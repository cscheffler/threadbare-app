# threadbare

A note-taking surface that happens to remember people. See [SPEC.md](SPEC.md).

This is v1 through build-order step 6: the append-only log, the fold, the
CLI, the localhost backend, and the browser frontend (scratchpad +
dashboard). Enrichment (step 7), export (8), and HttpLog (9) are not built
yet — everything works with notation-only parsing and no LLM.

## Install

```sh
uv tool install --editable .   # gives you the `app` command
# or: pip install -e .
```

## Where data lives

`~/.threadbare/events.log` — JSONL, append-only, the only source of truth.
Override with `THREADBARE_LOG` or `--log`. Everything you see is a fold over
this file; deleting anything else loses nothing.

## Quickstart

```sh
app person add "Sarah Chen" --alias sarah --cadence 30 --tags collaborator
app thread add "Sarah Chen" --kind 1:1 --people sarah

app note -t "Sarah Chen"     # shows the last note on the thread, opens $EDITOR
app dash                     # due today / gone quiet / open loops / recent

app due                      # nudges that have fired
app snooze itm_01ABC 1w      # push a nudge out (3d, 2w, 2026-08-01, never)
app close itm_01ABC -m "sent it"

app render --thread sarah-chen   # markdown to stdout
app render --item itm_01ABC      # one item's whole chain

app serve                        # http://127.0.0.1:8787 — the browser app
```

The browser app is the meeting-time surface: the scratchpad writes a draft
to localStorage on every keystroke and never touches the network while you
type; saves go through a retry queue, so the backend can be dead all meeting
and nothing is lost (the status dot shows green/grey/red). The CLI and the
browser can write to the same log at the same time.

Item ids accept unique prefixes. `app note` also takes `-m "body"` or a piped
stdin body; `--yes` skips prompts (creates unknown people/threads, closes
strong `>>` matches).

## Notation

| mark | meaning |
|---|---|
| `@name` | mentions a person |
| `>` (line-initial) | a commitment (mine, or theirs if the line @mentions them) |
| `?` (line-initial) | an open question |
| `>>` (line-initial) | closes an open item — fuzzy-matched, confirmed, never automatic |
| `!when` (on a `>`/`?` line) | nudge date: `!10d`, `!2w`, `!2026-08-01`, `!never` |

Items nudge after **3 days** by default (`THREADBARE_NUDGE_DAYS` to change).

## Development

```sh
PYTHONPATH=src python3 -m pytest tests/ -q          # Python: log, fold, CLI, server
node --test tests/frontend_core.test.mjs            # JS port of fold/notation/ULID
```
