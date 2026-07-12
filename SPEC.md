# Personal memory / networking app — v1 spec

A note-taking surface that happens to remember people. The scratchpad is the
primary interface; the person-graph is a byproduct. Local-first, single-user.

## Design principles

1. **Capture is sacred.** Typing into the scratchpad must be as fast as typing
   into a plain text file. No autocomplete popups, no modals, no parsing while
   the user types. During a meeting the app is dumb.
2. **All intelligence happens at save.** The post-meeting confirmation step is
   the product. Everything pre-filled; the user is approving, not entering data.
3. **The log is the only source of truth.** Append-only. Everything else —
   dashboard state, thread history, open loops — is a fold over the log,
   computed on demand.
4. **Never lose the raw input.** If the app does any cleanup, the original text
   is preserved verbatim in the event.

## Architecture

```
events.log (JSONL, append-only, canonical)
    │
    └─ fold → in-memory state
                │
                ├─ dashboard, sidebar, item lookup     (live)
                ├─ thread view, item view              (rendered on demand)
                └─ export/                             (written on demand, read-only)
```

The log is the only writable store. Everything else is a fold over it. The
`export/` directory is a **disposable, read-only** rendering for grep and for
reading outside the app — see [Export](#export). It is never read back in, never
parsed, never a source of truth. Deleting it loses nothing.

Suggested stack: whatever is cheapest to build a CLI/TUI or local web UI in.
SQLite is acceptable as a *cache* of the fold if startup time becomes a problem,
but it must be rebuildable from `events.log` with a single command and must
never be written to independently.

---

## Event schema

This is the expensive-to-change part. Get it right; everything downstream is
cheap to rewrite.

```jsonc
{
  "id": "ev_01H...",              // ULID; monotonic, sortable
  "ts": "2026-06-14T14:32:00Z",   // when the event was recorded
  "type": "note",                 // see event types below
  "thread": "thr_sarah_chen",     // primary thread this event belongs to
  "people": ["per_sarah_chen"],   // everyone mentioned/present
  "body": "raw text of the note", // verbatim, never rewritten
  "body_clean": "tidied prose",   // optional; null if user declined cleanup
  "items": [                      // items opened by this event
    {
      "id": "itm_01H...",
      "kind": "commit",           // "commit" | "question"
      "text": "send her the format-robustness draft",
      "owner": "me"               // "me" | person id | null
    }
  ],
  "closes": "itm_01H...",         // for type=close
  "supersedes": "itm_01H...",     // for type=revise
  "comment": "sent an outline instead", // optional, on close/revise
  "due": "2026-07-01"             // for type=nudge
}
```

Every event carries enough to reconstruct state without consulting anything
else. Fields not relevant to an event type are omitted.

### Event types

| type | meaning |
|---|---|
| `note` | A meeting note. May open items. May close/revise items via `>>` notation. |
| `close` | Marks an item resolved. Carries optional `comment`. |
| `revise` | Opens a new item that supersedes an old one. Chains. |
| `reopen` | Un-closes an item. Rare; include for completeness. |
| `person` | Creates or updates a person record. |
| `thread` | Creates or updates a thread record. |
| `nudge` | A time-based or cadence-based reminder attached to a person or thread. |

A `note` that closes items emits **one** `note` event plus one `close` event per
item closed. Do not overload `note` with close semantics — keeping them as
separate events makes the fold trivial and the item-history chain clean.

### Entities

**Person** — `id`, `name`, `aliases[]`, `org`, `links[]`, `tags[]`,
`met_context`, `cadence_days` (optional; drives "gone quiet").

Tag by *why you'd contact them* (collaborator / reviewer / student / owe-them-
something), not by org.

**Thread** — `id`, `title`, `people[]`, `kind` (`1:1` | `project` | `ad-hoc`).
A thread is a recurring context. A note attaches to exactly one thread and any
number of people.

**Item** — never stored directly. Derived from the `items` array on `note`
events, with state derived from subsequent `close` / `revise` / `reopen` events.
An item has exactly two states: **open** or **closed**. Do not build a state
machine. Mutation is handled by `revise` chains, not by extra states.

---

## Notation

Typed inline in the scratchpad. Optional — the save-step LLM catches what isn't
marked — but the marked path must be fast.

| mark | meaning |
|---|---|
| `@name` | mentions a person |
| `>` (line-initial) | a commitment (mine or theirs) |
| `?` (line-initial) | an open question |
| `>>` (line-initial) | closes an open item — fuzzy-matched at save time |

`>>` matching: at save, fuzzy-match the text against open items belonging to the
people mentioned in this note. Present matches for confirmation. Never
auto-close without confirmation.

Closing via the sidebar is the primary path; `>>` is the fast path for when the
user is already typing.

---

## Screens

### 1. Dashboard (default view on open)

Read-only, scannable, no interaction required to be useful. Four sections, no
more:

- **Due today** — nudges falling due.
- **Gone quiet** — people with no contact in `cadence_days` (per-person, set
  once).
- **Open loops** — all unresolved commitments and questions, grouped by person.
  Sorted oldest-first. This is the sleeper feature: "what did I promise someone
  and not do?" is a harder question than "who haven't I talked to lately."
- **Recent** — last ~5 notes, to jog memory.

Clicking an open loop closes it (with optional comment). Clicking a person opens
their thread view.

### 2. Scratchpad (where the user lives during meetings)

- A text area. Just a text area.
- Header: thread selector. Selecting a thread shows **the last note from that
  thread** above the blank input. This is the "digital memory" bit — see what
  you said last time before you start typing.
- Sidebar: open loops for the people on this thread, each with a checkbox.
  Ticking one queues a `close` event, applied at save.
- No parsing, no network calls, no popups while typing.

Autosave the raw buffer to a crash file continuously. If the app dies mid-
meeting, the text survives.

### 3. Save / confirmation step

Triggered explicitly by the user at the end of the meeting. This is the two
minutes when they'd otherwise close the tab and forget — make it feel like
reviewing, not data entry.

The step does, in order:

1. **Resolve people.** Extract mentioned names, match against known people.
   Ambiguous → ask ("Sarah — Sarah Chen, or someone new?"). Unknown → offer to
   create.
2. **Extract items.** Pull out `>` / `?` lines *and* anything in the prose that
   looks like a commitment or question. Present as a checklist, pre-checked.
   User unchecks anything that isn't real.
3. **Match `>>` closes.** Show which open items they matched. Confirm.
4. **Offer cleanup.** LLM tidies the prose. **Show a diff.** Original is always
   kept in `body`; the tidied version goes in `body_clean`. User can decline.
5. **Emit events.** One `note`, plus `close` / `revise` events for anything
   ticked in the sidebar or matched by `>>`.

Every step must be skippable with one keystroke. A user in a hurry should be
able to hit save-save-save and still get a correct (if unenriched) event.

### 4. Thread view (on demand)

Chronological render of every event on a thread. Notes render as prose;
housekeeping events render as subordinate italic lines, inline:

```markdown
## 2026-06-14 — 1:1, Sarah Chen

Talked about SAE feature steering. She's hitting the same soft-label
problem I had with the Obeso probes.

> send her the format-robustness draft
? does her harness handle [0,1] labels

---

*2026-06-21 — closed: send her the format-robustness draft*

*2026-06-28 — revised: send draft → send draft + the D3 figure*

---

## 2026-07-02 — coffee, Sarah Chen

She'd read it. Wants to co-author something on...
```

Reading a thread top to bottom shows the whole arc, including what happened
between meetings.

**Multi-person notes:** a note mentioning three people appears in all three
thread views, rendered from the same event, with a marker showing who else was
present. **Do not duplicate the text.** One event, many renders.

### 5. Item view (on demand)

One item, its entire chain: opened → revised → revised → closed, with dates and
comments. Cheap once `supersedes` pointers exist. This is what you want when
someone says "wait, what did you agree to?"

---

---

## Export

A read-only markdown rendering of the log, written to disk for grepping and for
reading outside the app. It reuses the same renderers as the thread view and
item view — this is a serialisation target, not a second implementation.

### Contract

- **Write-only from the app's perspective.** The app never reads `export/`,
  never parses it, never appends to it.
- **Disposable.** Deleting the whole directory loses nothing. It is fully
  regenerable from `events.log`.
- **Clobbering.** Export overwrites the target directory wholesale. Never merge
  into an existing export, never diff against it. If the user hand-edits a file
  there, those edits are lost on the next export — this is correct behaviour and
  should be stated in the README.
- **Not automatic.** Export runs when invoked. Do not export on every save, do
  not watch the log. (A user who wants it fresh can wire up a git hook or a cron
  job themselves; that's their business, not the app's.)

### CLI

```
app export [--out DIR] [--threads] [--items] [--all]
           [--since DATE] [--thread ID] [--person ID]
           [--state open|closed|all]
```

Defaults: `--out ./export`, `--all`, `--state all`. Bare `app export` produces
the full tree below.

Also support a stdout mode for one-off piping, which is often what's actually
wanted:

```
app render --thread sarah-chen           # markdown to stdout
app render --item itm_01H...             # one item's chain
app render --open                        # all open items
```

`render` is the same code path as `export`, writing to stdout instead of files.

### Layout

```
export/
  README.md                  # states that this dir is generated and read-only
  open.md                    # all open items, grouped by person, oldest first
  closed.md                  # all closed items, grouped by person, newest first
  threads/
    sarah-chen.md            # full chronological thread render
    mats-cohort-7.md
    ...
  people/
    sarah-chen.md            # person card + index of threads they appear in
    ...
```

Filenames are slugified from the thread/person title, with the ID appended on
collision. Stable across exports so that `git diff` on the export directory is
meaningful — which is a legitimate use, and the reason to keep filenames
deterministic.

### Formats

**`threads/*.md`** — exactly the thread view render specified above: notes as
prose, housekeeping events as subordinate italic lines, chronological. Add a
YAML frontmatter block (`title`, `people`, `first_seen`, `last_seen`,
`open_items`) so the files are usable in a digital-garden pipeline without
reprocessing.

**`open.md` / `closed.md`** — checkbox lists, one line per item, greppable:

```markdown
## Sarah Chen

- [ ] `itm_01H8X` 2026-07-02 ? does her harness handle [0,1] labels
- [x] `itm_01H7Q` 2026-06-14 > send the format-robustness draft
      (closed 2026-06-28 — sent draft + D3 figure; revised once)
```

Item IDs are included so a grep result can be fed straight back to
`app render --item`. Revision chains are collapsed to the head with a note of
how many revisions occurred; the full chain lives in the item view.

**`people/*.md`** — person record (org, tags, cadence, how met), plus a list of
threads they appear in with dates, plus their open items. An index, not a
duplicate of the note content.

---

## Non-goals for v1

Explicitly out of scope. Do not build these.

- Email or calendar integration.
- Push notifications of any kind. The dashboard is pull-only.
- Priorities, due dates on items, sub-tasks, or any richer item state. Two
  states plus a comment covers 95%; more turns this into a task manager, which
  will not be maintained.
- Multi-user, sync, or a server.
- Relationship-strength scoring, graph visualisation, intro suggestions.

## Acceptance criteria

- [ ] Typing in the scratchpad has no perceptible latency and triggers no
      network calls.
- [ ] Killing the process mid-note loses nothing.
- [ ] Deleting all caches and re-folding `events.log` reproduces the dashboard
      exactly.
- [ ] The raw text of every note is recoverable verbatim from the log.
- [ ] A commitment opened, revised twice, and closed renders as a single
      coherent chain in the item view.
- [ ] Save can be completed with at most three keystrokes and no mouse.
- [ ] `rm -rf export/ && app export` reproduces the export directory byte-for-byte.
- [ ] Nothing in the codebase reads from `export/`.
- [ ] `grep` on `export/open.md` yields an item ID that `app render --item` accepts.
