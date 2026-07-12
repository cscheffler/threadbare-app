"""The backend: three endpoints and static file serving, nothing else.

No business logic, no state beyond a lock around appends. All log access goes
through the Log interface (FileLog) — this module never opens events.log.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .log import FileLog, Log

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

PLACEHOLDER = b"""<!doctype html>
<html><body><h1>threadbare</h1>
<p>The frontend isn't built yet (build-order step 6).</p>
</body></html>"""


def make_server(log_path: str | Path, port: int,
                static_dir: str | Path | None = None) -> ThreadingHTTPServer:
    log = FileLog(log_path)
    lock = threading.Lock()
    static = (Path(static_dir) if static_dir else Path(__file__).parent / "static").resolve()

    def handler(*args):
        Handler(log, lock, static, *args)

    # v1 has no auth: the log holds private notes about named people, so
    # binding beyond 127.0.0.1 would publish it. Do not change this without
    # TLS and a session/basic-auth check on every endpoint first — see
    # SPEC.md "Security posture".
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(log_path: str | Path, port: int = 8787,
          static_dir: str | Path | None = None) -> None:
    make_server(log_path, port, static_dir).serve_forever()


class Handler(BaseHTTPRequestHandler):
    def __init__(self, log: Log, lock: threading.Lock, static: Path, *args):
        self.log = log
        self.lock = lock
        self.static = static
        super().__init__(*args)

    def log_message(self, fmt: str, *args) -> None:
        pass

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/events":
            self._events()
        else:
            self._static(path)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/append":
            self._append()
        elif path == "/enrich":
            self._json(501, {"error": "enrichment is not built yet (build-order step 7)"})
        else:
            self._json(404, {"error": "not found"})

    # ---------------------------------------------------------------- events

    def _events(self) -> None:
        since = parse_qs(urlsplit(self.path).query).get("since", [None])[0]
        events = self.log.read(since=since)
        self._json(200, {"events": events, "cursor": self._cursor()})

    def _append(self) -> None:
        body = self._read_body()
        try:
            event = json.loads(body) if body else None
        except json.JSONDecodeError:
            event = None
        if not isinstance(event, dict) or "id" not in event:
            self._json(400, {"error": "malformed body: expected a JSON event with an id"})
            return
        with self.lock:
            self.log.append(event)
            cursor = self._cursor()
        self._json(200, {"id": event["id"], "new_events": [], "cursor": cursor})

    def _cursor(self) -> str | None:
        events = self.log.read()
        return events[-1]["id"] if events else None

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return b""
        return self.rfile.read(length) if length > 0 else b""

    # ---------------------------------------------------------------- static

    def _static(self, path: str) -> None:
        rel = unquote(path).lstrip("/") or "index.html"
        try:
            resolved = (self.static / rel).resolve()
            resolved.relative_to(self.static)
        except (ValueError, RuntimeError, OSError):
            self._json(404, {"error": "not found"})
            return
        if not resolved.is_file():
            if rel == "index.html":
                self._send(200, "text/html; charset=utf-8", PLACEHOLDER)
            else:
                self._json(404, {"error": "not found"})
            return
        content_type = CONTENT_TYPES.get(resolved.suffix, "application/octet-stream")
        self._send(200, content_type, resolved.read_bytes())

    # ---------------------------------------------------------------- io

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, "application/json", json.dumps(payload).encode("utf-8"))

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # localhost tool, editable install: stale cached assets are worse
        # than the re-read
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)
