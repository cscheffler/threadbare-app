import http.client
import json
import threading

import pytest

from threadbare.server import make_server


def make_event(i):
    return {"id": f"ev_{i:04d}", "ts": "2026-07-01T00:00:00Z", "type": "note",
            "thread": "thr_x", "people": [], "body": f"note {i}", "items": []}


@pytest.fixture
def running_server(tmp_path):
    log_path = tmp_path / "events.log"
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html>hi</html>")
    (tmp_path / "secret.txt").write_text("do not serve me")

    httpd = make_server(log_path, 0, static_dir)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1], log_path
    finally:
        httpd.shutdown()
        thread.join(timeout=2)
        httpd.server_close()


def request(port, method, path, body: bytes | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json"} if body is not None else {}
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    headers_out = dict(resp.getheaders())
    conn.close()
    return resp.status, raw, headers_out


def get(port, path):
    return request(port, "GET", path)


def post_json(port, path, payload):
    return request(port, "POST", path, json.dumps(payload).encode())


def post_raw(port, path, data: bytes):
    return request(port, "POST", path, data)


# ---------------------------------------------------------------- append/events

def test_append_events_roundtrip_preserves_order(running_server):
    port, _ = running_server
    for i in range(3):
        status, raw, _ = post_json(port, "/append", make_event(i))
        body = json.loads(raw)
        assert status == 200
        assert body["id"] == f"ev_{i:04d}"
        assert body["new_events"] == []

    status, raw, _ = get(port, "/events")
    body = json.loads(raw)
    assert status == 200
    assert [e["id"] for e in body["events"]] == ["ev_0000", "ev_0001", "ev_0002"]
    assert body["cursor"] == "ev_0002"


def test_duplicate_append_is_idempotent(running_server):
    port, log_path = running_server
    event = make_event(1)
    status1, raw1, _ = post_json(port, "/append", event)
    status2, raw2, _ = post_json(port, "/append", event)
    body1, body2 = json.loads(raw1), json.loads(raw2)

    assert status1 == 200 and status2 == 200
    assert body1["cursor"] == body2["cursor"] == "ev_0001"
    assert body1["new_events"] == body2["new_events"] == []
    lines = [l for l in log_path.read_text().splitlines() if l.strip()]
    assert len(lines) == 1


def test_since_returns_only_later_events_in_order(running_server):
    port, _ = running_server
    for i in range(4):
        post_json(port, "/append", make_event(i))

    status, raw, _ = get(port, "/events?since=ev_0001")
    body = json.loads(raw)
    assert status == 200
    assert [e["id"] for e in body["events"]] == ["ev_0002", "ev_0003"]
    assert body["cursor"] == "ev_0003"


def test_cursor_is_null_on_empty_log(running_server):
    port, _ = running_server
    status, raw, _ = get(port, "/events")
    body = json.loads(raw)
    assert status == 200
    assert body == {"events": [], "cursor": None}


def test_append_malformed_json_is_400(running_server):
    port, _ = running_server
    status, raw, _ = post_raw(port, "/append", b"{not valid json")
    assert status == 400
    assert "error" in json.loads(raw)


def test_append_missing_id_is_400(running_server):
    port, _ = running_server
    status, raw, _ = post_json(port, "/append", {"ts": "t", "type": "note"})
    assert status == 400
    assert "error" in json.loads(raw)


def test_enrich_returns_501(running_server):
    port, _ = running_server
    status, raw, _ = post_json(port, "/enrich", {"body": "x", "context": {}})
    assert status == 501
    assert json.loads(raw) == {"error": "enrichment is not built yet (build-order step 7)"}


# ---------------------------------------------------------------- static / routing

def test_index_served_as_html(running_server):
    port, _ = running_server
    status, raw, headers = get(port, "/")
    assert status == 200
    assert raw == b"<html>hi</html>"
    assert headers["Content-Type"].startswith("text/html")


def test_unknown_path_is_404_json(running_server):
    port, _ = running_server
    status, raw, _ = get(port, "/nope-not-a-thing")
    assert status == 404
    assert "error" in json.loads(raw)


def test_placeholder_page_when_index_missing(tmp_path):
    log_path = tmp_path / "events.log"
    empty_static = tmp_path / "empty"
    empty_static.mkdir()
    httpd = make_server(log_path, 0, empty_static)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, raw, headers = get(httpd.server_address[1], "/")
        assert status == 200
        assert headers["Content-Type"].startswith("text/html")
        assert b"frontend isn't built" in raw
    finally:
        httpd.shutdown()
        thread.join(timeout=2)
        httpd.server_close()


@pytest.mark.parametrize("path", ["/../secret.txt", "/%2e%2e/secret.txt"])
def test_path_traversal_does_not_escape_static_dir(running_server, path):
    port, _ = running_server
    status, raw, _ = get(port, path)
    assert status == 404
    assert b"do not serve me" not in raw
