"""Parse the inline notation: @name, >, ?, >>, !when. No LLM anywhere here.

Notation parsing must work with the backend dead — an unenriched event built
from these rules is a correct event.
"""

import re
from dataclasses import dataclass
from datetime import date, timedelta

MENTION_RE = re.compile(r"@([A-Za-z][A-Za-z0-9_.'-]*)")
DUE_RE = re.compile(r"(?:(?<=\s)|^)!(never|\d{4}-\d{2}-\d{2}|\d+[dw])\b", re.IGNORECASE)

DEFAULT_NUDGE_DAYS = 3


@dataclass
class ParsedItem:
    kind: str             # "commit" | "question"
    text: str             # marker and !spec stripped, whitespace collapsed
    due_spec: str | None  # raw spec ("2w", "2026-08-01", "never"), None = default
    mention: str | None   # first @name on the line (owner heuristic)


@dataclass
class ParsedNote:
    mentions: list[str]
    items: list[ParsedItem]
    closes: list[str]


def parse(body: str) -> ParsedNote:
    mentions: list[str] = []
    seen = set()
    for name in MENTION_RE.findall(body):
        if name.lower() not in seen:
            seen.add(name.lower())
            mentions.append(name)

    items: list[ParsedItem] = []
    closes: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith(">>"):
            closes.append(stripped[2:].strip())
        elif stripped.startswith(">"):
            items.append(_parse_item("commit", stripped[1:]))
        elif stripped.startswith("?"):
            items.append(_parse_item("question", stripped[1:]))
    return ParsedNote(mentions=mentions, items=items, closes=closes)


def _parse_item(kind: str, rest: str) -> ParsedItem:
    due_spec = None
    m = DUE_RE.search(rest)
    if m:
        due_spec = m.group(1).lower()
        rest = rest[: m.start()] + rest[m.end():]
    mention = MENTION_RE.search(rest)
    return ParsedItem(
        kind=kind,
        text=" ".join(rest.split()),
        due_spec=due_spec,
        mention=mention.group(1) if mention else None,
    )


def resolve_due(spec: str | None, base: date,
                default_days: int = DEFAULT_NUDGE_DAYS) -> str | None:
    """Turn a !spec into an ISO date relative to base; None means never nudge."""
    if spec is None:
        return (base + timedelta(days=default_days)).isoformat()
    spec = spec.lower()
    if spec == "never":
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", spec):
        return spec
    m = re.fullmatch(r"(\d+)([dw])", spec)
    if not m:
        raise ValueError(f"bad nudge spec: {spec!r}")
    days = int(m.group(1)) * (7 if m.group(2) == "w" else 1)
    return (base + timedelta(days=days)).isoformat()
