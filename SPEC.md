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
5. **Capture never depends on the backend.** The scratchpad is a local buffer.
   The backend can be dead for the entire meeting and the user should not
   notice. Failures surface at save, non-destructively, with a retry that is
   always safe.

## Architecture

Browser frontend, deliberately anaemic Python backend, plain-text append-only
log. No database.

```
┌─ browser ──────────────────────────────┐
│  scratchpad, dashboard, thread view    │
│  localStorage: draft buffer + retry q  │
└────────────┬───────────────────────────┘
             │ GET  /            (the SPA itself)
             │ GET  /events      (log, cursorable)
             │ POST /append      (one event)
             │ POST /enrich      (optional)
             ▼
┌─ backend (~100 lines, Python) ─────────┐
│  serves the SPA as static files        │
│  append / read via the Log interface   │
│  no business logic, no state           │
└────────────┬───────────────────────────┘
             │
      ┌──────┴───────┐
      │ Log (iface)  │   FileLog  |  HttpLog
      └──────┬───────┘
             ▼
        events.log  (JSONL, append-only, canonical)
             │
             ├─ fold → in-memory state → dashboard, sidebar, item lookup
             ├─ fold → markdown        → thread view, item view (on demand)
             └─ fold → export/         → written on demand, read-only
             ▲
             │ via the same Log interface — FileLog locally, HttpLog if remote
        ┌────┴─────┐
        │   CLI    │  app note / app close / app export / app render
        └──────────┘
```

### Why this shape

- **Append-only is what makes the no-coordination design safe.** Two processes
  appending single sub-4KB lines to the same file interleave cleanly; they never
  corrupt each other. The browser and the CLI can both write to `events.log`
  with no lockfile, no protocol, no shared connection. (This is why *not*
  SQLite: WASM SQLite over the File System Access API has no reliable
  cross-process lock, and two writers to one `.db` means a corrupt file and a
  destroyed memory system.)
- **The backend has no logic**, so it can't have bugs worth debugging, and it
  can die without taking anything with it. It exists only to (a) hold the API
  key out of the page and (b) give cross-browser file access, which the File
  System Access API does not (Chrome/Edge only).
- **The fold lives in both clients.** Frontend and CLI each read the whole log
  and fold it in memory. At the expected volume (~10k events, a few MB) this is
  sub-second and happens once at startup. Do not optimise this. If it ever gets
  slow, add a *cache* of the fold that is rebuildable from `events.log` with one
  command and is never written to independently — but not in v1.

The `export/` directory is a **disposable, read-only** rendering for grep and
reading outside the app — see [Export](#export). Never read back in, never
parsed, never a source of truth. Deleting it loses nothing.

### Stack

- **Backend:** Python. FastAPI or stdlib `http.server`; it does not matter. Two
  endpoints. It owns the log file and the LLM call.
- **Frontend:** single-page, served from localhost. No build step. Plain JS or a
  single-file React via CDN. The moment there is a `node_modules`, the project
  has failed a smell test.
- **CLI:** a sibling to the server, importing the *same* fold and render modules.
  Batch operations, grepping, and export belong in the terminal; the meeting-time
  interface does not.

  ```
  app note -t THREAD [-m TEXT]   # capture; notation parsed locally, no LLM
  app close ITEM [-m COMMENT]    # resolve an item (dismisses its nudge)
  app reopen ITEM
  app snooze ITEM WHEN           # emits a nudge event (3d, 2w, 2026-08-01, never)
  app open                       # all open items, grouped by person
  app due                        # open items due today or overdue
  app dash                       # the four dashboard sections, as text
  app person … / app thread …    # create, update, list entities
  app render …                   # markdown to stdout; see Export
  app export …                   # see Export
  ```

---

## Resilience

The scratchpad must survive the backend being dead, and the user must never lose
typed text. Capture does not depend on the backend at all.

### Draft buffer

- The scratchpad writes its raw buffer to `localStorage` on every keystroke
  (debounced ~200ms). This is the only thing standing between the user and a
  lost meeting; treat it as load-bearing.
- The backend is not contacted while typing. Ever. No autosave-to-server, no
  presence ping, no parse-as-you-type. If the backend is down mid-meeting the
  user does not notice, because nothing tried to reach it.
- On load, if a draft buffer exists, restore it and say so.

### Save failure

- Save failing is an **inline, non-blocking error**. Never a modal — a modal the
  user dismisses is a modal that can take the buffer with it.
- The buffer is untouched. The save button stays live. The user restarts the
  backend by hand and presses save again.
- Failed events go into a **retry queue** in `localStorage` (an ordered list).
  The next successful save flushes the whole queue in order. This handles "I
  saved three meetings while the backend was down" without the user tracking
  which ones landed.
- No background retry loop, no exponential backoff, no service worker. The queue
  is retried when the user presses the button. That is the entire mechanism.

### Idempotent append (do not skip this)

The failure that will actually occur is **not** "backend down". It is: backend
up, append succeeded, response lost. The browser believes it failed, the user
retries, and the event is now in the log twice.

Therefore:

- **The client generates the event ULID**, not the server.
- `POST /append` is idempotent on `id`. The server keeps a set of recently-seen
  IDs (and can check the tail of the log); appending an ID already present is a
  no-op returning success.
- Retry is therefore always safe — including a retry the user performs by hand
  ten minutes later.

The honest worst case for this system is "the user presses save twice", and
pressing save twice is harmless.

### Backend-state indicator

A small dot in the UI: **green** (backend reachable), **grey** (unknown, not yet
contacted), **red** (last save failed / queue non-empty). It blocks nothing. Its
only job is to ensure the user learns the process died at lunch *before* they
type forty minutes of notes on top of that assumption.

Polling for this should be lazy — on load, on save, and on window focus. Not a
timer.

### LLM calls

The save-step enrichment is a backend call. If it fails, **degrade, do not
block**: emit the event with the raw body, no cleanup, and items parsed by the
plain notation rules (`@`, `>`, `?`) which need no LLM at all. An unenriched
event is a correct event. Losing the note is not recoverable; losing the tidy-up
is trivially recoverable.

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
      "owner": "me",              // "me" | person id | null
      "due": "2026-06-17"         // nudge date, resolved at save; null = never nudge
    }
  ],
  "closes": "itm_01H...",         // for type=close
  "supersedes": "itm_01H...",     // for type=revise
  "reopens": "itm_01H...",        // for type=reopen
  "comment": "sent an outline instead", // optional, on close/revise/nudge
  "item": "itm_01H...",           // for type=nudge: the item being re-dated
  "due": "2026-07-01"             // for type=nudge: the new nudge date; null = never
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
| `nudge` | Re-dates an item's nudge (snooze / push out). Carries `item` + `due`. |

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

Every item carries a `due` date — its nudge date — resolved at save time.
`nudge` events re-date it; the fold takes the last one. See [Nudges](#nudges).

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
| `!when` (on a `>` / `?` line) | sets the item's nudge date: `!10d`, `!2w`, `!2026-08-01`, `!never` |

`>>` matching: at save, fuzzy-match the text against open items belonging to the
people mentioned in this note. Present matches for confirmation. Never
auto-close without confirmation.

`!` resolution: relative specs (`!10d`, `!2w`) count from the note's date; an
ISO date is taken as-is; `!never` opts the item out of nudging. No `!` at all
means the default: note date + 3 days. The token is stripped from the item
text at save; the resolved date lands in the item's `due` field.

Closing via the sidebar is the primary path; `>>` is the fast path for when the
user is already typing.

---

## Nudges

Every open item nudges. A commitment or question that has gone quiet for a few
days is exactly the thing this app exists to catch, so nudging is opt-out, not
opt-in.

- **Every item gets a nudge date (`due`) when it is opened.** Default: the
  note's date + 3 days (configurable via `THREADBARE_NUDGE_DAYS`). Override per
  item with the `!` notation; `!never` opts the item out.
- **The date is resolved at save time and stored on the item** — events carry
  enough to reconstruct state without consulting configuration.
- **A nudge fires by appearing in "Due today"** once its date arrives, and
  stays there while the item is open. Pull-only: no timers, no notifications
  (see Non-goals).
- **Dismissing a nudge = closing the item** (a `close` event, optional
  comment). There is no separate "dismissed" state.
- **Snoozing = a `nudge` event** carrying the item id and a new date. The
  fold's rule is trivial: an item's effective due date is the `due` of the last
  `nudge` event targeting it, else the item's own `due`. The item reappears in
  "Due today" when the new date arrives.

Snoozes are deliberately *not* `revise` events: `revise` chains record changes
to what an item *is*, and pushing a date is not that. Keeping them separate
keeps the item-history chain about content — the same reason `note` doesn't
carry close semantics.

UI: each "Due today" row offers close (with optional comment) and snooze
(+3 days, +1 week, or pick a date). CLI: `app due` lists them; `app snooze
<item> <when>` and `app close <item>` act on them.

---

## Screens

### 1. Dashboard (default view on open)

Read-only, scannable, no interaction required to be useful. Four sections, no
more:

- **Due today** — open items whose nudge date has arrived (today or overdue).
  Each row can be closed or snoozed in place. See [Nudges](#nudges).
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

The raw buffer is written to `localStorage` on every keystroke (debounced). If
the app dies mid-meeting — browser crash, laptop death, backend gone — the text
survives and is restored on next load. See [Resilience](#resilience).

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
   ticked in the sidebar or matched by `>>`. **IDs are generated client-side**
   before the append call, so retries are idempotent.

Every step must be skippable with one keystroke. A user in a hurry should be
able to hit save-save-save and still get a correct (if unenriched) event.

Steps 1 and 4 require the LLM; step 2's prose-scanning does, but its notation
parsing (`>`, `?`) does not. If the backend or the LLM is unavailable, **skip
straight to step 5** with raw body and notation-parsed items, and tell the user
the note was saved unenriched. Never block a save on enrichment.

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

## Backend API

Three endpoints. The backend holds no state and makes no decisions. It also
serves the SPA as static files from the same process — there is no separate web
server.

```
GET  /                          → index.html (+ static assets)

GET  /events?since=<ulid>       → 200 {"events": [...], "cursor": "<ulid>"}
                                  All events after <ulid>, in order.
                                  Omit `since` for the whole log.

POST /append   {event}          → 200 {"id": "...", "new_events": [...], "cursor": "<ulid>"}
                                  Idempotent on event.id.
                                  `new_events` = anything appended since the
                                  client's cursor that it hasn't seen.

POST /enrich   {body, context}  → 200 {people, items, closes, body_clean}
                                  Optional. Every client must work if this 500s.
```

**Design notes, all of which cost nothing now and are expensive to retrofit:**

- **`?since=<ulid>` exists from day one**, even though the v1 client will ignore
  it and just pull the whole log. Adding a query parameter later is easy; adding
  it after three clients hardcode a full-log fetch is not.
- **`/append` returns `new_events`.** In v1 this is always empty (single client).
  It exists so that two browsers, or a browser and a CLI, can stay consistent
  without polling — the append response tells the client what it missed. Return
  the empty list now; the field being in the contract is the point.
- **ULIDs are monotonic and sortable**, which is what makes cursoring a
  `since`-comparison rather than an index lookup. This is the reason for ULIDs
  over UUIDs; do not substitute.
- The API key lives in the backend's environment. Never sent to the browser.

### Enrichment providers

`/enrich` is the only place the app talks to an LLM, and the provider is
configurable. One interface, mirroring the `Log` pattern:

```python
class Enricher(Protocol):
    def enrich(self, body: str, context: Context) -> Enrichment: ...
```

Selected by environment variable; the backend constructs exactly one at startup:

| `LLM_PROVIDER` | mechanism | auth / config |
|---|---|---|
| `anthropic` (default) | Anthropic Messages API | `ANTHROPIC_API_KEY`; model via `LLM_MODEL` (default `claude-opus-4-8`) |
| `openai` | OpenAI API | `OPENAI_API_KEY`; model via `LLM_MODEL` |
| `claude-cli` | subprocess: `claude -p`, prompt on stdin, output on stdout | whatever the CLI is logged in as |
| `codex-cli` | subprocess: `codex exec`, prompt on stdin, output on stdout | whatever the CLI is logged in as |

For the subprocess providers, `LLM_CMD` overrides the exact command line when
the defaults don't fit. Rules, identical for every provider:

- The prompt asks for a single JSON object (`people`, `items`, `closes`,
  `body_clean`); the response is parsed, never trusted — malformed output is an
  enrichment failure, not an error to surface as broken data.
- Failure of any kind — non-zero exit, timeout (30s), unparseable output, API
  error — degrades per [Resilience](#llm-calls): the note saves unenriched.
- API keys live in the backend's environment. Never in the page, never in the
  log.
- Subprocess providers get the prompt via **stdin, not argv** — prompts contain
  the user's notes, and argv is visible to `ps`.

### Storage interface

The fold, the renderers, the CLI, and the export **must never open `events.log`
directly.** All access goes through one interface:

```python
class Log(Protocol):
    def read(self, since: str | None = None) -> list[Event]: ...
    def append(self, event: Event) -> AppendResult: ...
```

Two implementations in v1:

- **`FileLog`** — opens `events.log` in append mode, writes one line, `fsync`s.
  Used by the backend and by the CLI when running against a local log.
- **`HttpLog`** — same interface, talks to the API. Used by the CLI when pointed
  at a remote instance (`APP_URL=https://...`), and conceptually by the frontend.

This is the single most important portability decision in the spec. It is ~30
lines. Without it, every call site hardcodes a file path and moving the log
anywhere — a remote host, a different backend, a test fixture — means touching
all of them.

### Deployment

The architecture runs unchanged on a cloud VM: the backend serves the SPA, the
browser talks to it over HTTPS, the CLI uses `HttpLog`. **Two constraints:**

1. **The log must live on a real block device.** The append-safety guarantee
   (concurrent appends of sub-4KB lines interleave rather than corrupt) relies
   on POSIX `O_APPEND` semantics on a local filesystem. It does **not** hold on
   NFS, EFS, or anything object-storage-backed. A normal VM with a normal disk
   is fine. Serverless with S3 is not, and would require a redesign.
2. **Auth must exist before binding to anything but `127.0.0.1`.** See below.

---

## Security posture

**v1 is localhost-only and has no authentication.** This is a deliberate choice,
and it is correct for a single user on their own machine.

- Bind to `127.0.0.1`. Not `0.0.0.0`. Not "just for a minute".
- The log contains private notes about named people. Exposing this endpoint
  publicly without auth would publish your entire personal network.

**Deploying beyond localhost requires, at minimum:** TLS, and a session cookie
or basic auth on every endpoint. This is deferred, not forgotten. The
architecture supports it — adding a middleware to a three-endpoint server is
trivial — but it is not built in v1, and the code should carry a comment at the
bind call saying so.

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
- **Authentication.** Deferred, not designed out. v1 binds to `127.0.0.1` and
  has none. See [Security posture](#security-posture) — the architecture must
  not preclude adding it, but do not build it now.
- Multi-device sync, presence, or real-time updates. The `new_events` field in
  the append response exists so this is *possible* later; it returns an empty
  list in v1 and no client acts on it.
- Relationship-strength scoring, graph visualisation, intro suggestions.
- A database. The log is a text file. Adding SQLite in v1 is a mistake.
- Background sync, service workers, retry daemons. Retry is a button.

## Acceptance criteria

- [ ] Typing in the scratchpad has no perceptible latency and triggers no
      network calls.
- [ ] **Kill the backend, type a full note, save.** The user gets a non-blocking
      error, the text is intact, the save button still works. Restart the
      backend, press save, the note lands.
- [ ] **Kill the browser mid-note.** Reopen; the draft is restored.
- [ ] **Save the same event twice.** It appears in the log once.
- [ ] Save three notes with the backend down, then bring it up and save. All
      three land, in order.
- [ ] `/enrich` returning 500 does not prevent a save; the note lands with raw
      body and notation-parsed items.
- [ ] The CLI and the browser can both append while the other is running, with
      no corruption and no coordination.
- [ ] Deleting all caches and re-folding `events.log` reproduces the dashboard
      exactly.
- [ ] The raw text of every note is recoverable verbatim from the log.
- [ ] A commitment opened, revised twice, and closed renders as a single
      coherent chain in the item view.
- [ ] An item saved with no `!` mark appears in "Due today" three days later;
      one saved with `!never` never does.
- [ ] Snoozing an item removes it from "Due today" until the new date; its
      revision chain is untouched.
- [ ] Save can be completed with three keystrokes and no mouse.
- [ ] `rm -rf export/ && app export` reproduces the export directory byte-for-byte.
- [ ] Nothing in the codebase reads from `export/`.
- [ ] `grep` on `export/open.md` yields an item ID that `app render --item` accepts.
- [ ] **No module outside `FileLog` opens `events.log` directly.** `grep` for the
      filename should hit exactly one file.
- [ ] The CLI works identically against `FileLog` and `HttpLog` — swapping the
      implementation requires changing one line.
- [ ] `GET /events?since=<ulid>` returns only later events, in order.
- [ ] The backend binds to `127.0.0.1` and there is a comment at the bind call
      explaining why changing it requires auth first.

---

## Build order

Build in this order. Do not skip ahead.

1. **The `Log` interface and `FileLog`.** Append, read, `fsync`. Nothing else
   in the codebase ever touches the file. Thirty lines, and everything else
   depends on getting it right.
2. **The fold.** A pure function from events to state. No UI, no LLM, no server.
3. **The CLI.** `app note`, `app close`, `app open` (list open items),
   `app due`, `app snooze`, `app render`. Enough to use the system — nudges
   included — from a terminal with hand-typed notation.
4. **Live with (1)–(3) for a week.** This is the only way to find out whether
   the event schema is right, which is the only thing here that is expensive to
   get wrong. Everything downstream is a fold and can be rewritten in an
   afternoon.
5. **The backend.** Three endpoints over the existing `Log` and fold modules,
   plus static file serving. Bind to localhost.
6. **The frontend.** Scratchpad and dashboard, with the resilience behaviour
   above. Get failure handling right *before* adding enrichment — a save path
   that is only correct on the happy path is worse than no save path.
7. **Enrichment.** `/enrich` and the confirmation step. Last, because it is the
   only optional thing.
8. **Export.**
9. **`HttpLog`.** Cheap once the interface exists, and it proves the interface
   was drawn in the right place.
