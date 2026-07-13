from datetime import date

from threadbare.fold import fold


def test_person_merge_is_field_wise(state):
    p = state.people["per_sarah_chen"]
    assert p.name == "Sarah Chen"          # from the first person event
    assert p.org == "AISC"                 # from the second
    assert p.cadence_days == 30
    assert p.last_contact == "2026-06-14T14:32:00Z"


def test_thread_seen_range(state):
    t = state.threads["thr_sarah_chen"]
    assert t.first_seen == "2026-06-14T14:32:00Z"
    assert t.last_seen == "2026-06-14T14:32:00Z"
    assert t.kind == "1:1"


def test_revise_chain(state):
    a, c = state.items["itm_a"], state.items["itm_c"]
    assert a.superseded_by == "itm_c"
    assert c.supersedes == "itm_a"
    assert [i.id for i in state.chain(a)] == ["itm_a", "itm_c"]
    assert state.head(a).id == "itm_c"
    assert state.root(c).id == "itm_a"


def test_two_states_only(state):
    assert {i.status for i in state.items.values()} <= {"open", "closed"}


def test_open_items_are_open_heads_only(state):
    # itm_a superseded, itm_c closed, itm_b reopened, itm_d open
    assert [i.id for i in state.open_items()] == ["itm_b", "itm_d"]
    assert [i.id for i in state.closed_items()] == ["itm_c"]


def test_nudge_overrides_due(state):
    a = state.items["itm_a"]
    assert a.due == "2026-06-17"
    assert state.effective_due(a) == "2026-06-25"


def test_due_items_excludes_never_and_closed(state):
    # itm_b has due=None (never): excluded no matter the date
    assert [i.id for i in state.due_items(date(2026, 7, 10))] == ["itm_d"]
    assert state.due_items(date(2026, 7, 4)) == []


def test_snooze_to_never_removes_from_due():
    events = [
        {"id": "ev_1", "ts": "2026-07-01T00:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "> do it",
         "items": [{"id": "itm_x", "kind": "commit", "text": "do it",
                    "owner": "me", "due": "2026-07-02"}]},
        {"id": "ev_2", "ts": "2026-07-01T01:00:00Z", "type": "nudge",
         "item": "itm_x", "due": None},
    ]
    s = fold(events)
    assert s.due_items(date(2026, 8, 1)) == []
    assert s.effective_due(s.items["itm_x"]) is None


def test_thread_seen_range_min_max_with_backdated_note():
    # ev_2 (later ts) is appended before ev_3 (earlier ts, backdated). The
    # fold must not let write order drag first_seen/last_seen the wrong
    # way: first_seen is the min ts seen, last_seen the max, regardless of
    # the order events arrive in the log.
    events = [
        {"id": "ev_1", "ts": "2026-06-10T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "first", "items": []},
        {"id": "ev_2", "ts": "2026-06-20T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "second", "items": []},
        {"id": "ev_3", "ts": "2026-06-05T09:00:00Z", "type": "note",
         "thread": "thr_x", "people": [], "body": "backdated", "items": []},
    ]
    s = fold(events)
    t = s.threads["thr_x"]
    assert t.first_seen == "2026-06-05T09:00:00Z"
    assert t.last_seen == "2026-06-20T09:00:00Z"


def test_reopen_restores_open(state):
    b = state.items["itm_b"]
    assert b.status == "open"
    assert b.closed_ts is None
    actions = [h["action"] for h in b.history]
    assert actions == ["opened", "closed", "reopened"]


def test_gone_quiet(state):
    quiet = state.gone_quiet(date(2026, 7, 20))
    assert [(p.id, days) for p, days in quiet] == [("per_sarah_chen", 36)]
    assert state.gone_quiet(date(2026, 7, 1)) == []


def test_dangling_refs_warn_but_do_not_crash():
    s = fold([{"id": "ev_1", "ts": "t", "type": "close", "closes": "itm_ghost"}])
    assert s.warnings and "itm_ghost" in s.warnings[0]


def test_fold_is_deterministic():
    # re-folding the same log reproduces the same state — no hidden inputs
    from conftest import scenario_events
    from threadbare.render import render_dash
    a = render_dash(fold(scenario_events()), date(2026, 7, 10))
    b = render_dash(fold(scenario_events()), date(2026, 7, 10))
    assert a == b
