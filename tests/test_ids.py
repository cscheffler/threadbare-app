from threadbare.ids import new_ulid, person_id, slugify, thread_id


def test_ulid_shape_and_monotonic():
    ids = [new_ulid() for _ in range(2000)]
    assert all(len(u) == 26 for u in ids)
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)


def test_slugify():
    assert slugify("Sarah Chen") == "sarah_chen"
    assert slugify("MATS — cohort 7!") == "mats_cohort_7"
    assert slugify("Sarah Chen", sep="-") == "sarah-chen"
    assert slugify("!!!") == "x"


def test_id_prefixes():
    assert person_id("Sarah Chen") == "per_sarah_chen"
    assert thread_id("MATS cohort 7") == "thr_mats_cohort_7"
