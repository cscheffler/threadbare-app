from datetime import date

from threadbare.fold import fold
from threadbare.render import (render_closed, render_dash, render_due,
                               render_item, render_open, render_thread)


def test_thread_view(state):
    out = render_thread(state, "thr_sarah_chen")
    assert "# Sarah Chen" in out
    assert "## 2026-06-14 — 1:1, Sarah Chen" in out
    assert "> send her the format-robustness draft" in out  # body is verbatim
    assert "*2026-06-18 — snoozed to 2026-06-25: send her the format-robustness draft*" in out
    assert ("*2026-06-21 — revised: send her the format-robustness draft "
            "→ send draft + the D3 figure*") in out
    assert "*2026-06-28 — closed: send draft + the D3 figure — sent it*" in out
    assert "---" in out
    # events from other threads stay out
    assert "reimbursement" not in out


def test_thread_view_backdated_note_sorts_chronologically():
    # ev_3 is appended last (log order) but backdated to slot between the
    # other two notes — the render is chronological by ts, not log order.
    events = [
        {"id": "ev_1", "ts": "2026-06-01T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "AAA first note", "items": []},
        {"id": "ev_2", "ts": "2026-06-20T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "CCC third note", "items": []},
        {"id": "ev_3", "ts": "2026-06-10T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "BBB backdated note", "items": []},
    ]
    out = render_thread(fold(events), "thr_x")
    assert out.index("AAA") < out.index("BBB") < out.index("CCC")


def test_thread_view_unknown_thread_is_empty(state):
    assert "*(no events)*" in render_thread(state, "thr_nope")


def test_item_chain(state):
    out = render_item(state, "itm_a")  # any node in the chain renders the chain
    assert out.startswith("# send draft + the D3 figure")
    assert "- 2026-06-14 — opened (commit) in Sarah Chen" in out
    assert "- 2026-06-18 — snoozed to 2026-06-25" in out
    assert "- 2026-06-21 — revised → send draft + the D3 figure" in out
    assert "- 2026-06-28 — closed — sent it" in out
    assert "Status: closed (2026-06-28)" in out


def test_open_list_format(state):
    out = render_open(state)
    assert "## Sarah Chen" in out
    assert "- [ ] `itm_b` 2026-06-14 ? does her harness handle [0,1] labels" in out
    assert "## (unassigned)" in out
    assert "`itm_d`" in out


def test_closed_list_collapses_chain(state):
    out = render_closed(state)
    assert "- [x] `itm_c` 2026-06-14 > send draft + the D3 figure" in out
    assert "(closed 2026-06-28 — sent it; revised once)" in out


def test_due_list(state):
    out = render_due(state, date(2026, 7, 10))
    assert "`itm_d`" in out
    assert "5d overdue" in out
    assert "`itm_b`" not in out  # never nudges
    assert render_due(state, date(2026, 7, 4)) == "*(nothing due)*\n"


def test_dashboard_sections(state):
    out = render_dash(state, date(2026, 7, 20))
    for section in ("## Due today", "## Gone quiet", "## Open loops", "## Recent"):
        assert section in out
    assert "Sarah Chen — 36d since last contact (cadence 30d)" in out
    assert "chase the reimbursement" in out
