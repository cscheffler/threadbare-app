"""The `app` CLI: capture, close, snooze, list, render.

Talks to the log only through the Log interface — FileLog today, HttpLog
later, with no call-site changes.
"""

import argparse
import difflib
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

from . import events as ev
from . import server
from .fold import Item, Person, State, Thread, fold
from .ids import new_item_id, person_id, slugify, thread_id
from .log import Event, FileLog, Log
from .notation import DEFAULT_NUDGE_DAYS, parse, resolve_due
from .render import (person_name, render_closed, render_dash, render_due,
                     render_item, render_open, render_thread)

DEFAULT_LOG = Path.home() / ".threadbare" / "events.log"

# --yes only auto-closes a >> match at or above this similarity; weaker
# matches still need an interactive yes (never auto-close, per spec)
YES_CLOSE_THRESHOLD = 0.6
MATCH_FLOOR = 0.35


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args) or 0


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(2)


def log_path(args) -> Path:
    if args.log:
        return Path(args.log)
    env = os.environ.get("THREADBARE_LOG")
    return Path(env) if env else DEFAULT_LOG


def load(args) -> tuple[Log, State]:
    log = FileLog(log_path(args))
    return log, fold(log.read())


def nudge_default_days() -> int:
    try:
        return int(os.environ.get("THREADBARE_NUDGE_DAYS", DEFAULT_NUDGE_DAYS))
    except ValueError:
        return DEFAULT_NUDGE_DAYS


def confirm(args, prompt: str, default: bool = True) -> bool:
    if getattr(args, "yes", False):
        return True
    if not sys.stdin.isatty():
        return False
    suffix = " [Y/n] " if default else " [y/N] "
    answer = input(prompt + suffix).strip().lower()
    return default if not answer else answer.startswith("y")


# ---------------------------------------------------------------- lookups

def find_item(state: State, ref: str) -> Item:
    if ref in state.items:
        return state.items[ref]
    candidates = [i for k, i in state.items.items()
                  if k.startswith(ref) or k.startswith("itm_" + ref)]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        die(f"no item matches {ref!r}")
    die(f"ambiguous item ref {ref!r}: " + ", ".join(i.id for i in candidates[:5]))


def find_thread(state: State, ref: str) -> Thread | None:
    if ref in state.threads:
        return state.threads[ref]
    tid = thread_id(ref)
    if tid in state.threads:
        return state.threads[tid]
    for t in state.threads.values():
        if t.title.lower() == ref.lower():
            return t
    return None


def resolve_person(state: State, name: str) -> list[Person]:
    """Match a mention against known people: id, name, alias, or first name."""
    needle = name.lower()
    if name in state.people:
        return [state.people[name]]
    exact, loose = [], []
    for p in state.people.values():
        if p.name.lower() == needle or needle in (a.lower() for a in p.aliases):
            exact.append(p)
        elif needle in p.name.lower().split() or p.id == person_id(name):
            loose.append(p)
    return exact or loose


# ---------------------------------------------------------------- note

def cmd_note(args) -> int:
    log, state = load(args)
    thread = find_thread(state, args.thread)
    body = get_body(args, state, thread)
    if not body.strip():
        die("empty note; nothing saved")
    parsed = parse(body)
    pending: list[Event] = []

    # 1. resolve the thread
    if thread is None:
        tid = thread_id(args.thread)
        if sys.stdin.isatty() and not getattr(args, "yes", False):
            if not confirm(args, f"create thread '{args.thread}' ({tid})?"):
                die("aborted; no events written")
        else:
            print(f"note: creating thread '{args.thread}' ({tid})")
        pending.append(ev.thread({"id": tid, "title": args.thread,
                                  "kind": args.kind, "people": []}))
        thread_people: list[str] = []
    else:
        tid = thread.id
        thread_people = list(thread.people)

    # 2. resolve people (@mentions ∪ thread people)
    mention_map: dict[str, str] = {}
    for name in parsed.mentions:
        matches = resolve_person(state, name)
        if len(matches) == 1:
            mention_map[name.lower()] = matches[0].id
        elif len(matches) > 1:
            options = ", ".join(m.name or m.id for m in matches)
            print(f"note: '@{name}' is ambiguous ({options}); leaving as text")
        else:
            pid = person_id(name)
            if pid in mention_map.values():
                continue
            if sys.stdin.isatty() and not getattr(args, "yes", False):
                if not confirm(args, f"create person '{name}' ({pid})?"):
                    continue
            else:
                print(f"note: creating person '{name}' ({pid})")
            pending.append(ev.person({"id": pid, "name": name}))
            mention_map[name.lower()] = pid
    people = list(dict.fromkeys(list(mention_map.values()) + thread_people))

    # 3. items, with nudge dates resolved now
    today = date.today()
    items_payload = []
    for pi in parsed.items:
        try:
            due = resolve_due(pi.due_spec, today, nudge_default_days())
        except ValueError as exc:
            die(str(exc))
        owner = None
        if pi.mention and pi.mention.lower() in mention_map:
            owner = mention_map[pi.mention.lower()]
        elif pi.kind == "commit":
            owner = "me"
        items_payload.append({"id": new_item_id(), "kind": pi.kind,
                              "text": pi.text, "owner": owner, "due": due})

    # 4. >> closes — fuzzy-matched, never closed without confirmation
    close_events = _match_closes(args, state, parsed.closes, people)

    # 5. emit: entity events, one note, then the closes
    pending.append(ev.note(tid, people, body, items_payload))
    pending.extend(close_events)
    for event in pending:
        log.append(event)

    names = ", ".join(person_name(state, p) or p for p in people) or "(nobody)"
    print(f"saved note to {tid} — people: {names}")
    for entry in items_payload:
        mark = ">" if entry["kind"] == "commit" else "?"
        nudge = f"nudge {entry['due']}" if entry["due"] else "no nudge"
        print(f"  opened {mark} {entry['text']} ({nudge}) [{entry['id']}]")
    for event in close_events:
        item = state.items[event["closes"]]
        print(f"  closed: {item.text}")
    return 0


def _match_closes(args, state: State, closes: list[str],
                  people: list[str]) -> list[Event]:
    if not closes:
        return []
    candidates = [i for i in state.open_items()
                  if set(i.people) & set(people) or state.item_person(i) in people]
    if not candidates:
        candidates = state.open_items()
    events = []
    for text in closes:
        best, score = None, 0.0
        for item in candidates:
            ratio = difflib.SequenceMatcher(None, text.lower(), item.text.lower()).ratio()
            if ratio > score:
                best, score = item, ratio
        if best is None or score < MATCH_FLOOR:
            print(f"note: no open item matches '>> {text}'; left in the body")
            continue
        prompt = f"close '{best.text}' (matched '>> {text}', {score:.0%})?"
        if getattr(args, "yes", False):
            if score >= YES_CLOSE_THRESHOLD:
                events.append(ev.close(best.id))
            else:
                print(f"note: weak match for '>> {text}' ({score:.0%}); not closing")
        elif sys.stdin.isatty() and confirm(args, prompt):
            events.append(ev.close(best.id))
        else:
            print(f"note: skipped closing '{best.text}' (no confirmation)")
    return events


def get_body(args, state: State, thread: Thread | None) -> str:
    if args.message is not None:
        return args.message
    if not sys.stdin.isatty():
        return sys.stdin.read()
    if thread is not None:
        last = next((e for e in reversed(state.notes) if e.get("thread") == thread.id), None)
        if last:
            print(f"— last note on this thread ({last['ts'][:10]}) —")
            print((last.get("body") or "").rstrip())
            print("—" * 40)
    editor = os.environ.get("EDITOR") or os.environ.get("VISUAL") or "vi"
    with tempfile.NamedTemporaryFile("w+", suffix=".md", delete=False) as f:
        path = f.name
    try:
        subprocess.call(shlex.split(editor) + [path])
        return Path(path).read_text(encoding="utf-8")
    finally:
        os.unlink(path)


# ---------------------------------------------------------------- items

def cmd_close(args) -> int:
    log, state = load(args)
    item = find_item(state, args.item)
    if item.superseded_by:
        head = state.head(item)
        die(f"item was revised; close the head instead: {head.id}")
    if item.status == "closed":
        die(f"already closed ({(item.closed_ts or '')[:10]})")
    log.append(ev.close(item.id, comment=args.message))
    print(f"closed: {item.text}")
    return 0


def cmd_reopen(args) -> int:
    log, state = load(args)
    item = find_item(state, args.item)
    if item.superseded_by:
        die(f"item was revised; the head is {state.head(item).id}")
    if item.status == "open":
        die("already open")
    log.append(ev.reopen(item.id))
    print(f"reopened: {item.text}")
    return 0


def cmd_snooze(args) -> int:
    log, state = load(args)
    item = find_item(state, args.item)
    if item.superseded_by:
        die(f"item was revised; snooze the head instead: {state.head(item).id}")
    if item.status == "closed":
        die("item is closed; nothing to snooze")
    try:
        due = resolve_due(args.when, date.today())
    except ValueError as exc:
        die(str(exc))
    log.append(ev.nudge(item.id, due))
    if due:
        print(f"snoozed to {due}: {item.text}")
    else:
        print(f"nudge switched off: {item.text}")
    return 0


# ---------------------------------------------------------------- lists

def cmd_open(args) -> int:
    _, state = load(args)
    print(render_open(state), end="")
    return 0


def cmd_due(args) -> int:
    _, state = load(args)
    print(render_due(state, date.today()), end="")
    return 0


def cmd_dash(args) -> int:
    _, state = load(args)
    print(render_dash(state, date.today()), end="")
    return 0


def cmd_render(args) -> int:
    _, state = load(args)
    if args.thread:
        thread = find_thread(state, args.thread)
        if thread is None:
            die(f"no thread matches {args.thread!r}")
        print(render_thread(state, thread.id), end="")
    elif args.item:
        print(render_item(state, find_item(state, args.item).id), end="")
    elif args.open:
        print(render_open(state), end="")
    elif args.closed:
        print(render_closed(state), end="")
    else:
        die("pick one of --thread, --item, --open, --closed")
    return 0


# ---------------------------------------------------------------- entities

def cmd_person_add(args) -> int:
    log, state = load(args)
    pid = person_id(args.name)
    if pid in state.people:
        die(f"{pid} exists; use `app person set {pid} ...` to update")
    log.append(ev.person(_person_record(pid, args, name=args.name)))
    print(f"added {args.name} ({pid})")
    return 0


def cmd_person_set(args) -> int:
    log, state = load(args)
    matches = resolve_person(state, args.person)
    if not matches:
        die(f"no person matches {args.person!r}")
    if len(matches) > 1:
        die(f"ambiguous: " + ", ".join(p.id for p in matches))
    record = _person_record(matches[0].id, args, name=args.name)
    if list(record) == ["id"]:
        die("nothing to change")
    log.append(ev.person(record))
    print(f"updated {matches[0].id}")
    return 0


def _person_record(pid: str, args, name: str | None) -> dict:
    record: dict = {"id": pid}
    if name:
        record["name"] = name
    if args.alias:
        record["aliases"] = args.alias
    if args.org:
        record["org"] = args.org
    if args.link:
        record["links"] = args.link
    if args.tags:
        record["tags"] = [t.strip() for t in args.tags.split(",") if t.strip()]
    if args.met:
        record["met_context"] = args.met
    if args.cadence is not None:
        record["cadence_days"] = args.cadence
    return record


def cmd_person_list(args) -> int:
    _, state = load(args)
    if not state.people:
        print("(no people)")
        return 0
    for p in sorted(state.people.values(), key=lambda p: p.name.lower() or p.id):
        bits = [p.id, p.name or "-"]
        if p.org:
            bits.append(p.org)
        if p.tags:
            bits.append("[" + ",".join(p.tags) + "]")
        if p.cadence_days:
            bits.append(f"cadence {p.cadence_days}d")
        if p.last_contact:
            bits.append(f"last {p.last_contact[:10]}")
        print("  ".join(bits))
    return 0


def cmd_thread_add(args) -> int:
    log, state = load(args)
    tid = thread_id(args.title)
    if tid in state.threads:
        die(f"{tid} exists")
    people = []
    for name in (args.people.split(",") if args.people else []):
        name = name.strip()
        if not name:
            continue
        matches = resolve_person(state, name)
        if len(matches) != 1:
            die(f"person {name!r} " + ("is ambiguous" if matches else
                "not found; `app person add` them first"))
        people.append(matches[0].id)
    log.append(ev.thread({"id": tid, "title": args.title,
                          "kind": args.kind, "people": people}))
    print(f"added thread {args.title} ({tid})")
    return 0


def cmd_thread_list(args) -> int:
    _, state = load(args)
    if not state.threads:
        print("(no threads)")
        return 0
    for t in sorted(state.threads.values(), key=lambda t: t.last_seen or "", reverse=True):
        names = ", ".join(person_name(state, p) for p in t.people) or "-"
        last = f"last {t.last_seen[:10]}" if t.last_seen else "no notes yet"
        print(f"{t.id}  {t.title or '-'}  ({t.kind})  {names}  {last}")
    return 0


# ---------------------------------------------------------------- serve

def cmd_serve(args) -> int:
    path = log_path(args)
    print(f"serving on http://127.0.0.1:{args.port} — log: {path}")
    server.serve(path, port=args.port)
    return 0


# ---------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="app", description="threadbare — notes that remember people")
    p.add_argument("--log", help="path to events.log "
                   "(env THREADBARE_LOG; default ~/.threadbare/events.log)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("note", help="capture a note (opens $EDITOR unless -m/stdin)")
    sp.add_argument("-t", "--thread", required=True, help="thread id, slug, or title")
    sp.add_argument("-m", "--message", help="note body (otherwise stdin or $EDITOR)")
    sp.add_argument("--kind", default="ad-hoc", choices=["1:1", "project", "ad-hoc"],
                    help="thread kind if the thread is created")
    sp.add_argument("-y", "--yes", action="store_true",
                    help="no prompts: create people/threads, close strong >> matches")
    sp.set_defaults(func=cmd_note)

    sp = sub.add_parser("close", help="close an item")
    sp.add_argument("item", help="item id (or unique prefix)")
    sp.add_argument("-m", "--message", help="optional comment")
    sp.set_defaults(func=cmd_close)

    sp = sub.add_parser("reopen", help="reopen a closed item")
    sp.add_argument("item")
    sp.set_defaults(func=cmd_reopen)

    sp = sub.add_parser("snooze", help="push an item's nudge date out")
    sp.add_argument("item")
    sp.add_argument("when", help="3d, 2w, 2026-08-01, or never")
    sp.set_defaults(func=cmd_snooze)

    sub.add_parser("open", help="open items, grouped by person").set_defaults(func=cmd_open)
    sub.add_parser("due", help="open items due today or overdue").set_defaults(func=cmd_due)
    sub.add_parser("dash", help="the dashboard, as text").set_defaults(func=cmd_dash)

    sp = sub.add_parser("render", help="markdown to stdout")
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--thread", help="thread id, slug, or title")
    g.add_argument("--item", help="item id (or unique prefix)")
    g.add_argument("--open", action="store_true")
    g.add_argument("--closed", action="store_true")
    sp.set_defaults(func=cmd_render)

    pp = sub.add_parser("person", help="manage people")
    psub = pp.add_subparsers(dest="person_cmd", required=True)
    for verb, func in (("add", cmd_person_add), ("set", cmd_person_set)):
        sp = psub.add_parser(verb)
        if verb == "add":
            sp.add_argument("name")
        else:
            sp.add_argument("person", help="person id or name")
            sp.add_argument("--name")
        sp.add_argument("--alias", action="append", default=[])
        sp.add_argument("--org")
        sp.add_argument("--link", action="append", default=[])
        sp.add_argument("--tags", help="comma-separated; tag by why you'd contact them")
        sp.add_argument("--met", help="how you met")
        sp.add_argument("--cadence", type=int,
                        help="days of silence before they count as gone quiet")
        sp.set_defaults(func=func)
    psub.add_parser("list").set_defaults(func=cmd_person_list)

    tp = sub.add_parser("thread", help="manage threads")
    tsub = tp.add_subparsers(dest="thread_cmd", required=True)
    sp = tsub.add_parser("add")
    sp.add_argument("title")
    sp.add_argument("--kind", default="ad-hoc", choices=["1:1", "project", "ad-hoc"])
    sp.add_argument("--people", help="comma-separated names/ids of existing people")
    sp.set_defaults(func=cmd_thread_add)
    tsub.add_parser("list").set_defaults(func=cmd_thread_list)

    sp = sub.add_parser("serve", help="run the backend (static SPA + log endpoints)")
    sp.add_argument("--port", type=int, default=8787)
    sp.set_defaults(func=cmd_serve)

    return p


if __name__ == "__main__":
    raise SystemExit(main())
