# threadbare

A note-taking surface that happens to remember people. See [SPEC.md](SPEC.md).

This is v1, build-order steps 1–3: the append-only log, the fold, and the CLI.
No backend, no frontend, no LLM yet — the point is to live with the event
schema for a week before building anything downstream.

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
```

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
PYTHONPATH=src python3 -m pytest tests/ -q
```
