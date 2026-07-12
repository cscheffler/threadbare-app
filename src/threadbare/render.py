"""Markdown renders: thread view, item chain, open/closed lists, dashboard.

One implementation, many callers: the CLI's `render` prints these to stdout,
and export (later) writes the same output to files. Not a second renderer.
"""

from datetime import date

from .fold import Event, Item, State


def _date(ts: str | None) -> str:
    return (ts or "")[:10]


def person_name(state: State, pid: str | None) -> str:
    if pid is None:
        return ""
    p = state.people.get(pid)
    return (p.name or pid) if p else pid


def render_thread(state: State, thread_id: str) -> str:
    thread = state.threads.get(thread_id)
    title = (thread.title if thread else "") or thread_id
    entries: list[tuple[str, str]] = []  # (kind, text)
    for e in state.events:
        t = e.get("type")
        if t == "note" and e.get("thread") == thread_id:
            entries.append(("note", _note_block(state, e, thread)))
        elif t in ("close", "revise", "reopen", "nudge"):
            line = _house_line(state, e, thread_id)
            if line:
                entries.append(("house", line))
    if not entries:
        return f"# {title}\n\n*(no events)*\n"
    blocks = [f"# {title}"]
    prev = None
    for kind, text in entries:
        if prev is not None and kind != prev:
            blocks.append("---")
        blocks.append(text)
        prev = kind
    return "\n\n".join(blocks) + "\n"


def _note_block(state: State, e: Event, thread) -> str:
    names = ", ".join(person_name(state, p) for p in e.get("people", []))
    names = names or ((thread.title if thread else "") or e.get("thread", ""))
    kind = thread.kind if thread else "note"
    body = (e.get("body_clean") or e.get("body", "")).rstrip()
    return f"## {_date(e['ts'])} — {kind}, {names}\n\n{body}"


def _house_line(state: State, e: Event, thread_id: str) -> str | None:
    t = e["type"]
    if t == "revise":
        old = state.items.get(e.get("supersedes") or "")
        if old is None or old.thread != thread_id:
            return None
        new = state.items.get(old.superseded_by or "")
        new_text = new.text if new else "?"
        return f"*{_date(e['ts'])} — revised: {old.text} → {new_text}*"
    target_field = {"close": "closes", "reopen": "reopens", "nudge": "item"}[t]
    item = state.items.get(e.get(target_field) or "")
    if item is None or item.thread != thread_id:
        return None
    d = _date(e["ts"])
    if t == "close":
        comment = f" — {e['comment']}" if e.get("comment") else ""
        return f"*{d} — closed: {item.text}{comment}*"
    if t == "reopen":
        return f"*{d} — reopened: {item.text}*"
    if e.get("due"):
        return f"*{d} — snoozed to {e['due']}: {item.text}*"
    return f"*{d} — nudge off: {item.text}*"


def render_item(state: State, item_id: str) -> str:
    chain = state.chain(state.items[item_id])
    head = chain[-1]
    lines = [f"# {head.text}", ""]
    for node in chain:
        for h in node.history:
            lines.append(_history_line(state, node, h))
    lines.append("")
    due = state.effective_due(head)
    if head.status == "open":
        lines.append("Status: open" + (f", nudge due {due}" if due else ", no nudge"))
    else:
        when = f" ({_date(head.closed_ts)})" if head.closed_ts else ""
        lines.append(f"Status: closed{when}")
    return "\n".join(lines) + "\n"


def _history_line(state: State, node: Item, h: dict) -> str:
    d = _date(h["ts"])
    action = h["action"]
    if action == "opened":
        thread = state.threads.get(node.thread or "")
        where = f" in {thread.title or thread.id}" if thread else ""
        return f"- {d} — opened ({node.kind}){where}: {node.text} [`{node.id}`]"
    if action == "revised":
        new = state.items.get(h.get("to") or "")
        return f"- {d} — revised → {new.text if new else '?'}"
    if action == "closed":
        comment = f" — {h['comment']}" if h.get("comment") else ""
        return f"- {d} — closed{comment}"
    if action == "reopened":
        return f"- {d} — reopened"
    if h.get("due"):
        return f"- {d} — snoozed to {h['due']}"
    return f"- {d} — nudge switched off"


def _grouped_by_person(state: State, items: list[Item]) -> list[tuple[str, list[Item]]]:
    groups: dict[str | None, list[Item]] = {}
    for item in items:
        groups.setdefault(state.item_person(item), []).append(item)
    ordered = sorted(groups, key=lambda p: person_name(state, p).lower() if p else "~")
    return [(person_name(state, p) if p else "(unassigned)", groups[p]) for p in ordered]


def render_open(state: State) -> str:
    sections = []
    for name, items in _grouped_by_person(state, state.open_items()):
        lines = [f"## {name}", ""]
        for item in items:
            mark = ">" if item.kind == "commit" else "?"
            lines.append(f"- [ ] `{item.id}` {_date(item.opened_ts)} {mark} {item.text}")
        sections.append("\n".join(lines))
    return ("\n\n".join(sections) + "\n") if sections else "*(no open items)*\n"


def render_closed(state: State) -> str:
    sections = []
    for name, items in _grouped_by_person(state, state.closed_items()):
        lines = [f"## {name}", ""]
        for item in items:
            root = state.chain(item)[0]
            mark = ">" if item.kind == "commit" else "?"
            info = f"closed {_date(item.closed_ts)}" if item.closed_ts else "closed"
            if item.close_comment:
                info += f" — {item.close_comment}"
            revisions = len(state.chain(item)) - 1
            if revisions == 1:
                info += "; revised once"
            elif revisions > 1:
                info += f"; revised {revisions} times"
            lines.append(f"- [x] `{item.id}` {_date(root.opened_ts)} {mark} {item.text}")
            lines.append(f"      ({info})")
        sections.append("\n".join(lines))
    return ("\n\n".join(sections) + "\n") if sections else "*(no closed items)*\n"


def render_due(state: State, today: date) -> str:
    items = state.due_items(today)
    if not items:
        return "*(nothing due)*\n"
    lines = []
    for item in items:
        due = state.effective_due(item)
        overdue = (today - date.fromisoformat(due)).days
        when = "due today" if overdue == 0 else f"{overdue}d overdue"
        mark = ">" if item.kind == "commit" else "?"
        who = person_name(state, state.item_person(item))
        suffix = f" — {who}" if who else ""
        lines.append(f"- `{item.id}` {when} {mark} {item.text}{suffix}")
    return "\n".join(lines) + "\n"


def render_dash(state: State, today: date) -> str:
    parts = ["# Dashboard", "", "## Due today", "", render_due(state, today).rstrip()]
    parts += ["", "## Gone quiet", ""]
    quiet = state.gone_quiet(today)
    if quiet:
        for p, days in quiet:
            parts.append(f"- {p.name or p.id} — {days}d since last contact "
                         f"(cadence {p.cadence_days}d)")
    else:
        parts.append("*(nobody)*")
    parts += ["", "## Open loops", "", render_open(state).rstrip()]
    parts += ["", "## Recent", ""]
    recent = state.recent_notes()
    if recent:
        for e in recent:
            first = next((ln.strip() for ln in e.get("body", "").splitlines() if ln.strip()), "")
            thread = state.threads.get(e.get("thread") or "")
            tname = (thread.title or thread.id) if thread else e.get("thread", "?")
            parts.append(f"- {_date(e['ts'])} — {tname}: {first[:70]}")
    else:
        parts.append("*(no notes yet)*")
    return "\n".join(parts) + "\n"
