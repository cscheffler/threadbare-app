"""Constructors for the event types.

Events are plain dicts (the log is JSONL); these builders are the one place
that knows which fields each type carries. Fields not relevant to a type are
omitted, per the spec.
"""

from datetime import datetime, timezone
from typing import Any

from .ids import new_event_id

Event = dict[str, Any]


def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _base(type_: str) -> Event:
    return {"id": new_event_id(), "ts": now_ts(), "type": type_}


def note(thread: str, people: list[str], body: str, items: list[dict],
         body_clean: str | None = None) -> Event:
    e = _base("note") | {"thread": thread, "people": people, "body": body, "items": items}
    if body_clean is not None:
        e["body_clean"] = body_clean
    return e


def close(item_id: str, comment: str | None = None) -> Event:
    e = _base("close") | {"closes": item_id}
    if comment:
        e["comment"] = comment
    return e


def reopen(item_id: str) -> Event:
    return _base("reopen") | {"reopens": item_id}


def revise(old_item_id: str, new_item: dict, thread: str | None,
           people: list[str]) -> Event:
    return _base("revise") | {
        "supersedes": old_item_id,
        "thread": thread,
        "people": people,
        "items": [new_item],
    }


def nudge(item_id: str, due: str | None, comment: str | None = None) -> Event:
    e = _base("nudge") | {"item": item_id, "due": due}
    if comment:
        e["comment"] = comment
    return e


def person(record: dict) -> Event:
    return _base("person") | {"person": record}


def thread(record: dict) -> Event:
    return _base("thread") | {"thread": record}
