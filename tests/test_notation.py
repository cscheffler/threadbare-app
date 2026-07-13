from datetime import date

import pytest

from threadbare.notation import parse, resolve_due

BODY = """\
Talked with @sarah about SAE feature steering.
She's hitting the same soft-label problem.

> send her the format-robustness draft !2w
? does her harness handle [0,1] labels !never
>> send the cohort intro email
> @sarah to send the eval harness
> ping @bob about the workshop !2026-08-01
"""


def test_parse_full_note():
    parsed = parse(BODY)
    assert parsed.mentions == ["sarah", "bob"]
    assert [c for c in parsed.closes] == ["send the cohort intro email"]
    kinds = [(i.kind, i.due_spec) for i in parsed.items]
    assert kinds == [("commit", "2w"), ("question", "never"),
                     ("commit", None), ("commit", "2026-08-01")]
    assert parsed.items[0].text == "send her the format-robustness draft"
    assert parsed.items[1].text == "does her harness handle [0,1] labels"
    assert parsed.items[2].mention == "sarah"
    assert parsed.items[3].mention == "bob"


def test_mentions_dedupe_case_insensitively():
    assert parse("@Sarah and @sarah and @SARAH").mentions == ["Sarah"]


def test_bang_only_strips_the_token():
    item = parse("> fix the !2d thing about x!y").items[0]
    assert item.due_spec == "2d"
    assert item.text == "fix the thing about x!y"


def test_mentions_exclude_trailing_punctuation():
    assert parse("Got introduced to @Brandon by @Jazon.").mentions == ["Brandon", "Jazon"]
    assert parse("@sam. and @sam.smith and @al-").mentions == ["sam", "sam.smith", "al"]


def test_resolve_due():
    base = date(2026, 7, 12)
    assert resolve_due(None, base) == "2026-07-15"          # default 3 days
    assert resolve_due(None, base, default_days=7) == "2026-07-19"
    assert resolve_due("5d", base) == "2026-07-17"
    assert resolve_due("2w", base) == "2026-07-26"
    assert resolve_due("2026-08-01", base) == "2026-08-01"
    assert resolve_due("never", base) is None
    with pytest.raises(ValueError):
        resolve_due("tuesday", base)
