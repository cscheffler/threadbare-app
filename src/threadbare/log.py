"""The Log interface and FileLog.

Nothing outside this module opens events.log. All access — fold, renderers,
CLI, export — goes through Log.
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Protocol

Event = dict[str, Any]


@dataclass
class AppendResult:
    id: str
    appended: bool  # False when the id was already in the log (idempotent dedupe)
    new_events: list[Event] = field(default_factory=list)


class Log(Protocol):
    def read(self, since: str | None = None) -> list[Event]: ...
    def append(self, event: Event) -> AppendResult: ...


class FileLog:
    """Append-only JSONL log on a local filesystem.

    Each append is one line followed by fsync; concurrent single-line appends
    under 4KB interleave cleanly under POSIX O_APPEND. Append is idempotent on
    event id, so retries are always safe.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._ids: set[str] = set()
        self._scanned = 0  # bytes of the file already folded into _ids

    def read(self, since: str | None = None) -> list[Event]:
        events = [json.loads(line) for line in self._complete_lines()]
        if since is not None:
            events = [e for e in events if e["id"] > since]
        return events

    def append(self, event: Event) -> AppendResult:
        if "id" not in event:
            raise ValueError("event has no id")
        self._refresh_ids()
        if event["id"] in self._ids:
            return AppendResult(id=event["id"], appended=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
        self._ids.add(event["id"])
        return AppendResult(id=event["id"], appended=True)

    def _complete_lines(self) -> Iterator[str]:
        # Only newline-terminated lines count: a torn final line is a
        # concurrent writer mid-append and will be complete on the next read.
        if not self.path.exists():
            return
        data = self.path.read_bytes()
        end = data.rfind(b"\n") + 1
        for raw in data[:end].splitlines():
            if raw.strip():
                yield raw.decode("utf-8")

    def _refresh_ids(self) -> None:
        if not self.path.exists():
            return
        with open(self.path, "rb") as f:
            f.seek(self._scanned)
            data = f.read()
        end = data.rfind(b"\n") + 1
        for raw in data[:end].splitlines():
            if raw.strip():
                self._ids.add(json.loads(raw)["id"])
        self._scanned += end
