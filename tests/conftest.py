import pytest

from threadbare.fold import fold


def scenario_events():
    return [
        {"id": "ev_01", "ts": "2026-06-01T10:00:00Z", "type": "person",
         "person": {"id": "per_sarah_chen", "name": "Sarah Chen",
                    "aliases": ["sarah"], "cadence_days": 30}},
        {"id": "ev_02", "ts": "2026-06-01T10:00:01Z", "type": "thread",
         "thread": {"id": "thr_sarah_chen", "title": "Sarah Chen",
                    "kind": "1:1", "people": ["per_sarah_chen"]}},
        {"id": "ev_03", "ts": "2026-06-14T14:32:00Z", "type": "note",
         "thread": "thr_sarah_chen", "people": ["per_sarah_chen"],
         "body": ("Talked about SAE feature steering.\n\n"
                  "> send her the format-robustness draft\n"
                  "? does her harness handle [0,1] labels"),
         "items": [
             {"id": "itm_a", "kind": "commit",
              "text": "send her the format-robustness draft",
              "owner": "me", "due": "2026-06-17"},
             {"id": "itm_b", "kind": "question",
              "text": "does her harness handle [0,1] labels",
              "owner": None, "due": None},
         ]},
        {"id": "ev_04", "ts": "2026-06-18T09:00:00Z", "type": "nudge",
         "item": "itm_a", "due": "2026-06-25"},
        {"id": "ev_05", "ts": "2026-06-21T09:00:00Z", "type": "revise",
         "supersedes": "itm_a", "thread": "thr_sarah_chen",
         "people": ["per_sarah_chen"],
         "items": [{"id": "itm_c", "kind": "commit",
                    "text": "send draft + the D3 figure",
                    "owner": "me", "due": "2026-06-28"}]},
        {"id": "ev_06", "ts": "2026-06-28T09:00:00Z", "type": "close",
         "closes": "itm_c", "comment": "sent it"},
        {"id": "ev_07", "ts": "2026-06-29T09:00:00Z", "type": "close",
         "closes": "itm_b"},
        {"id": "ev_08", "ts": "2026-06-30T09:00:00Z", "type": "reopen",
         "reopens": "itm_b"},
        {"id": "ev_09", "ts": "2026-07-02T10:00:00Z", "type": "person",
         "person": {"id": "per_sarah_chen", "org": "AISC"}},
        {"id": "ev_10", "ts": "2026-07-03T10:00:00Z", "type": "note",
         "thread": "thr_misc", "people": [],
         "body": "> chase the reimbursement",
         "items": [{"id": "itm_d", "kind": "commit",
                    "text": "chase the reimbursement",
                    "owner": "me", "due": "2026-07-05"}]},
    ]


@pytest.fixture
def state():
    return fold(scenario_events())
