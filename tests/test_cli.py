from datetime import date, timedelta

import pytest

from threadbare.cli import find_item, main
from threadbare.fold import Item, State
from threadbare.log import FileLog


def test_end_to_end_capture_flow(tmp_path, capsys):
    log = str(tmp_path / "events.log")

    assert main(["--log", log, "person", "add", "Sarah Chen",
                 "--alias", "sarah", "--cadence", "30"]) == 0
    assert main(["--log", log, "thread", "add", "Sarah Chen",
                 "--kind", "1:1", "--people", "sarah"]) == 0
    capsys.readouterr()

    body = "> send her the draft !5d\n? does her harness handle labels"
    assert main(["--log", log, "note", "-t", "Sarah Chen", "-m", body, "--yes"]) == 0
    out = capsys.readouterr().out
    assert "saved note to thr_sarah_chen" in out

    events = FileLog(log).read()
    note = next(e for e in events if e["type"] == "note")
    assert note["people"] == ["per_sarah_chen"]
    commit, question = note["items"]
    assert commit["owner"] == "me"
    assert commit["due"] == (date.today() + timedelta(days=5)).isoformat()
    assert question["due"] == (date.today() + timedelta(days=3)).isoformat()

    main(["--log", log, "open"])
    out = capsys.readouterr().out
    assert "## Sarah Chen" in out and "send her the draft" in out

    # >> in a follow-up note closes the earlier item (strong match + --yes)
    assert main(["--log", log, "note", "-t", "sarah-chen", "-m",
                 ">> send her the draft", "--yes"]) == 0
    capsys.readouterr()
    events = FileLog(log).read()
    assert any(e["type"] == "close" and e["closes"] == commit["id"] for e in events)

    # snooze the question into the past, see it in `due`, then close it
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    assert main(["--log", log, "snooze", question["id"], yesterday]) == 0
    capsys.readouterr()
    main(["--log", log, "due"])
    out = capsys.readouterr().out
    assert question["id"] in out and "overdue" in out

    assert main(["--log", log, "close", question["id"], "-m", "answered"]) == 0
    capsys.readouterr()
    main(["--log", log, "due"])
    assert "nothing due" in capsys.readouterr().out

    main(["--log", log, "dash"])
    assert "# Dashboard" in capsys.readouterr().out

    main(["--log", log, "render", "--thread", "sarah-chen"])
    out = capsys.readouterr().out
    assert "## " in out and "closed:" in out


def test_note_creates_unknown_thread_and_person(tmp_path, capsys):
    log = str(tmp_path / "events.log")
    assert main(["--log", log, "note", "-t", "MATS cohort 7", "-m",
                 "met @priya at the workshop\n> intro priya to the eval team",
                 "--yes"]) == 0
    out = capsys.readouterr().out
    assert "creating thread" in out
    events = FileLog(log).read()
    assert any(e["type"] == "thread" and e["thread"]["id"] == "thr_mats_cohort_7"
               for e in events)
    assert any(e["type"] == "person" and e["person"]["id"] == "per_priya"
               for e in events)
    note = next(e for e in events if e["type"] == "note")
    assert "per_priya" in note["people"]


def test_empty_note_saves_nothing(tmp_path, capsys):
    log = str(tmp_path / "events.log")
    with pytest.raises(SystemExit):
        main(["--log", log, "note", "-t", "x", "-m", "   ", "--yes"])
    assert FileLog(log).read() == []


def _item(id_):
    return Item(id=id_, kind="commit", text="x", owner=None, thread=None,
                people=[], opened_ts="t", due=None)


def test_find_item_accepts_unique_prefixes():
    s = State()
    s.items["itm_AAA1"] = _item("itm_AAA1")
    s.items["itm_BBB2"] = _item("itm_BBB2")
    assert find_item(s, "itm_AAA1").id == "itm_AAA1"
    assert find_item(s, "itm_AAA").id == "itm_AAA1"
    assert find_item(s, "BBB2").id == "itm_BBB2"
    with pytest.raises(SystemExit):
        find_item(s, "itm_")  # ambiguous
    with pytest.raises(SystemExit):
        find_item(s, "nope")
