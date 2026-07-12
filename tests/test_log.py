from threadbare.log import FileLog


def make(i):
    return {"id": f"ev_{i:04d}", "ts": "2026-07-01T00:00:00Z", "type": "note",
            "thread": "thr_x", "people": [], "body": f"note {i}", "items": []}


def test_roundtrip_in_order(tmp_path):
    log = FileLog(tmp_path / "events.log")
    for i in range(3):
        assert log.append(make(i)).appended
    assert [e["body"] for e in log.read()] == ["note 0", "note 1", "note 2"]


def test_append_is_idempotent_on_id(tmp_path):
    path = tmp_path / "events.log"
    log = FileLog(path)
    event = make(1)
    assert log.append(event).appended
    assert not log.append(event).appended
    assert len(log.read()) == 1
    assert len(path.read_text().splitlines()) == 1


def test_idempotent_across_instances(tmp_path):
    path = tmp_path / "events.log"
    a, b = FileLog(path), FileLog(path)
    a.append(make(1))
    assert not b.append(make(1)).appended
    assert len(b.read()) == 1


def test_since_filters_by_id(tmp_path):
    log = FileLog(tmp_path / "events.log")
    events = [make(i) for i in range(4)]
    for e in events:
        log.append(e)
    later = log.read(since=events[1]["id"])
    assert [e["id"] for e in later] == ["ev_0002", "ev_0003"]


def test_two_writers_interleave(tmp_path):
    path = tmp_path / "events.log"
    a, b = FileLog(path), FileLog(path)
    a.append(make(1))
    b.append(make(2))
    a.append(make(3))
    assert [e["id"] for e in FileLog(path).read()] == ["ev_0001", "ev_0002", "ev_0003"]


def test_torn_final_line_is_ignored_until_complete(tmp_path):
    path = tmp_path / "events.log"
    log = FileLog(path)
    log.append(make(1))
    with open(path, "a") as f:
        f.write('{"id": "ev_partial"')  # a concurrent writer mid-append
    assert [e["id"] for e in log.read()] == ["ev_0001"]
    with open(path, "a") as f:
        f.write(', "type": "note", "ts": "t", "body": "", "items": []}\n')
    assert [e["id"] for e in log.read()] == ["ev_0001", "ev_partial"]
