"""ULID generation and id construction.

ULIDs are monotonic and sortable — cursoring is a string comparison, not an
index lookup. Do not substitute UUIDs.
"""

import os
import re
import threading
import time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_lock = threading.Lock()
_last_ms = -1
_last_rand = 0


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def new_ulid() -> str:
    """26-char Crockford ULID; strictly increasing within this process."""
    global _last_ms, _last_rand
    with _lock:
        ms = time.time_ns() // 1_000_000
        if ms <= _last_ms:
            ms = _last_ms
            _last_rand += 1
        else:
            _last_ms = ms
            _last_rand = int.from_bytes(os.urandom(10), "big") >> 1
        return _encode(ms, 10) + _encode(_last_rand, 16)


def new_event_id() -> str:
    return "ev_" + new_ulid()


def new_item_id() -> str:
    return "itm_" + new_ulid()


def slugify(text: str, sep: str = "_") -> str:
    slug = re.sub(r"[^a-z0-9]+", sep, text.lower()).strip(sep)
    return slug or "x"


def person_id(name: str) -> str:
    return "per_" + slugify(name)


def thread_id(title: str) -> str:
    return "thr_" + slugify(title)
