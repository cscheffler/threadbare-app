"""The fold: a pure function from events to state.

No I/O, no clock — anything time-dependent takes `today` as an argument.
Deleting all caches and re-folding events.log must reproduce this exactly.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any

Event = dict[str, Any]

PERSON_FIELDS = ("name", "aliases", "org", "links", "tags", "met_context", "cadence_days")
THREAD_FIELDS = ("title", "people", "kind")


@dataclass
class Person:
    id: str
    name: str = ""
    aliases: list[str] = field(default_factory=list)
    org: str | None = None
    links: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    met_context: str | None = None
    cadence_days: int | None = None
    last_contact: str | None = None  # ts of the last note that includes them


@dataclass
class Thread:
    id: str
    title: str = ""
    people: list[str] = field(default_factory=list)
    kind: str = "ad-hoc"
    first_seen: str | None = None
    last_seen: str | None = None


@dataclass
class Item:
    id: str
    kind: str
    text: str
    owner: str | None
    thread: str | None
    people: list[str]
    opened_ts: str
    due: str | None            # nudge date as opened; None = never
    status: str = "open"       # "open" | "closed" — exactly two states
    closed_ts: str | None = None
    close_comment: str | None = None
    supersedes: str | None = None
    superseded_by: str | None = None
    nudged: bool = False       # a nudge event has re-dated this item
    due_override: str | None = None
    history: list[dict] = field(default_factory=list)


@dataclass
class State:
    people: dict[str, Person] = field(default_factory=dict)
    threads: dict[str, Thread] = field(default_factory=dict)
    items: dict[str, Item] = field(default_factory=dict)
    notes: list[Event] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def effective_due(self, item: Item) -> str | None:
        return item.due_override if item.nudged else item.due

    def root(self, item: Item) -> Item:
        while item.supersedes and item.supersedes in self.items:
            item = self.items[item.supersedes]
        return item

    def head(self, item: Item) -> Item:
        while item.superseded_by:
            item = self.items[item.superseded_by]
        return item

    def chain(self, item: Item) -> list[Item]:
        node = self.root(item)
        out = [node]
        while node.superseded_by:
            node = self.items[node.superseded_by]
            out.append(node)
        return out

    def open_items(self) -> list[Item]:
        """Open chain heads, oldest first — the "open loops" list."""
        out = [i for i in self.items.values()
               if i.superseded_by is None and i.status == "open"]
        out.sort(key=lambda i: i.opened_ts)
        return out

    def closed_items(self) -> list[Item]:
        out = [i for i in self.items.values()
               if i.superseded_by is None and i.status == "closed"]
        out.sort(key=lambda i: i.closed_ts or i.opened_ts, reverse=True)
        return out

    def due_items(self, today: date) -> list[Item]:
        cutoff = today.isoformat()
        out = [i for i in self.open_items()
               if self.effective_due(i) is not None and self.effective_due(i) <= cutoff]
        out.sort(key=lambda i: self.effective_due(i))
        return out

    def gone_quiet(self, today: date) -> list[tuple[Person, int]]:
        out = []
        for p in self.people.values():
            if p.cadence_days is None or p.last_contact is None:
                continue
            days = (today - date.fromisoformat(p.last_contact[:10])).days
            if days > p.cadence_days:
                out.append((p, days))
        out.sort(key=lambda pair: -pair[1])
        return out

    def recent_notes(self, n: int = 5) -> list[Event]:
        return self.notes[-n:][::-1]

    def item_person(self, item: Item) -> str | None:
        if item.owner and item.owner.startswith("per_"):
            return item.owner
        return item.people[0] if item.people else None


def fold(events: list[Event]) -> State:
    s = State()
    for e in events:
        s.events.append(e)
        t = e.get("type")
        if t == "person":
            _merge_person(s, e)
        elif t == "thread":
            _merge_thread(s, e)
        elif t == "note":
            _apply_note(s, e)
        elif t == "revise":
            _apply_revise(s, e)
        elif t == "close":
            _apply_close(s, e)
        elif t == "reopen":
            _apply_reopen(s, e)
        elif t == "nudge":
            _apply_nudge(s, e)
        else:
            s.warnings.append(f"{e.get('id', '?')}: unknown event type {t!r}")
    return s


def _merge_person(s: State, e: Event) -> None:
    rec = e.get("person") or {}
    pid = rec.get("id")
    if not pid:
        s.warnings.append(f"{e['id']}: person event without person.id")
        return
    p = s.people.setdefault(pid, Person(id=pid))
    for f in PERSON_FIELDS:
        if f in rec:
            setattr(p, f, rec[f])


def _merge_thread(s: State, e: Event) -> None:
    rec = e.get("thread") or {}
    tid = rec.get("id")
    if not tid:
        s.warnings.append(f"{e['id']}: thread event without thread.id")
        return
    t = s.threads.setdefault(tid, Thread(id=tid))
    for f in THREAD_FIELDS:
        if f in rec:
            setattr(t, f, rec[f])


def _apply_note(s: State, e: Event) -> None:
    s.notes.append(e)
    tid = e.get("thread")
    if tid:
        t = s.threads.setdefault(tid, Thread(id=tid, title=tid))
        t.first_seen = min(t.first_seen, e["ts"]) if t.first_seen else e["ts"]
        t.last_seen = max(t.last_seen, e["ts"]) if t.last_seen else e["ts"]
    for pid in e.get("people", []):
        p = s.people.setdefault(pid, Person(id=pid, name=pid))
        if p.last_contact is None or e["ts"] > p.last_contact:
            p.last_contact = e["ts"]
    _open_items(s, e)


def _open_items(s: State, e: Event) -> list[Item]:
    created = []
    for entry in e.get("items", []):
        item = Item(
            id=entry["id"],
            kind=entry.get("kind", "commit"),
            text=entry.get("text", ""),
            owner=entry.get("owner"),
            thread=e.get("thread"),
            people=list(e.get("people", [])),
            opened_ts=e["ts"],
            due=entry.get("due"),
        )
        item.history.append({"ts": e["ts"], "action": "opened"})
        s.items[item.id] = item
        created.append(item)
    return created


def _apply_revise(s: State, e: Event) -> None:
    created = _open_items(s, e)
    old = s.items.get(e.get("supersedes") or "")
    if old is None:
        s.warnings.append(f"{e['id']}: revise of unknown item {e.get('supersedes')!r}")
        return
    if not created:
        s.warnings.append(f"{e['id']}: revise event carries no new item")
        return
    new = created[0]
    new.supersedes = old.id
    old.superseded_by = new.id
    old.history.append({"ts": e["ts"], "action": "revised", "to": new.id})
    if not e.get("people"):
        new.people = list(old.people)
    if not e.get("thread"):
        new.thread = old.thread


def _apply_close(s: State, e: Event) -> None:
    item = s.items.get(e.get("closes") or "")
    if item is None:
        s.warnings.append(f"{e['id']}: close of unknown item {e.get('closes')!r}")
        return
    item.status = "closed"
    item.closed_ts = e["ts"]
    item.close_comment = e.get("comment")
    item.history.append({"ts": e["ts"], "action": "closed", "comment": e.get("comment")})


def _apply_reopen(s: State, e: Event) -> None:
    item = s.items.get(e.get("reopens") or "")
    if item is None:
        s.warnings.append(f"{e['id']}: reopen of unknown item {e.get('reopens')!r}")
        return
    item.status = "open"
    item.closed_ts = None
    item.close_comment = None
    item.history.append({"ts": e["ts"], "action": "reopened"})


def _apply_nudge(s: State, e: Event) -> None:
    item = s.items.get(e.get("item") or "")
    if item is None:
        s.warnings.append(f"{e['id']}: nudge of unknown item {e.get('item')!r}")
        return
    item.nudged = True
    item.due_override = e.get("due")
    item.history.append({"ts": e["ts"], "action": "snoozed", "due": e.get("due")})
