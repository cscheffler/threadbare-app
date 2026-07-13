// Mirrors the Python test scenarios (tests/test_ids.py, tests/test_notation.py,
// tests/test_fold.py, and the fuzzy-matching behaviour in cli.py) against the
// ported logic in src/threadbare/static/core.js.
//
// Run with: node --test tests/frontend_core.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Pinned so the "no offset means local time" parseTimestamp tests (and the
// nowLocalISO round-trip test) aren't machine-dependent. Europe/London is
// deliberately non-UTC and DST-observing (BST in July), which is exactly
// the case that a naive toISOString()-based implementation gets wrong.
process.env.TZ = "Europe/London";

const require = createRequire(import.meta.url);
const TB = require("../src/threadbare/static/core.js");

// ---------------------------------------------------------------- ids

test("ULID shape, monotonic, sortable, unique", () => {
  const ids = [];
  for (let i = 0; i < 2000; i++) ids.push(TB.newUlid());
  assert.ok(ids.every((u) => u.length === 26));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
  assert.equal(new Set(ids).size, ids.length);
});

test("newEventId / newItemId prefixes", () => {
  assert.ok(TB.newEventId().startsWith("ev_"));
  assert.ok(TB.newItemId().startsWith("itm_"));
  assert.equal(TB.newEventId().length, 3 + 26);
  assert.equal(TB.newItemId().length, 4 + 26);
});

test("slugify", () => {
  assert.equal(TB.slugify("Sarah Chen"), "sarah_chen");
  assert.equal(TB.slugify("MATS — cohort 7!"), "mats_cohort_7");
  assert.equal(TB.slugify("Sarah Chen", "-"), "sarah-chen");
  assert.equal(TB.slugify("!!!"), "x");
});

test("person_id / thread_id", () => {
  assert.equal(TB.personId("Sarah Chen"), "per_sarah_chen");
  assert.equal(TB.threadId("MATS cohort 7"), "thr_mats_cohort_7");
});

// ---------------------------------------------------------------- notation

const BODY = [
  "Talked with @sarah about SAE feature steering.",
  "She's hitting the same soft-label problem.",
  "",
  "> send her the format-robustness draft !2w",
  "? does her harness handle [0,1] labels !never",
  ">> send the cohort intro email",
  "> @sarah to send the eval harness",
  "> ping @bob about the workshop !2026-08-01",
  "",
].join("\n");

test("parse: full note", () => {
  const parsed = TB.parse(BODY);
  assert.deepEqual(parsed.mentions, ["sarah", "bob"]);
  assert.deepEqual(parsed.closes, ["send the cohort intro email"]);
  const kinds = parsed.items.map((i) => [i.kind, i.due_spec]);
  assert.deepEqual(kinds, [
    ["commit", "2w"],
    ["question", "never"],
    ["commit", null],
    ["commit", "2026-08-01"],
  ]);
  assert.equal(parsed.items[0].text, "send her the format-robustness draft");
  assert.equal(parsed.items[1].text, "does her harness handle [0,1] labels");
  assert.equal(parsed.items[2].mention, "sarah");
  assert.equal(parsed.items[3].mention, "bob");
});

test("parse: mentions dedupe case-insensitively, keep first spelling", () => {
  assert.deepEqual(TB.parse("@Sarah and @sarah and @SARAH").mentions, ["Sarah"]);
});

test("parse: bang-only strips the token", () => {
  const item = TB.parse("> fix the !2d thing about x!y").items[0];
  assert.equal(item.due_spec, "2d");
  assert.equal(item.text, "fix the thing about x!y");
});

test("parse: mentions exclude trailing punctuation", () => {
  assert.deepEqual(TB.parse("Got introduced to @Brandon by @Jazon.").mentions, ["Brandon", "Jazon"]);
  assert.deepEqual(TB.parse("@sam. and @sam.smith and @al-").mentions, ["sam", "sam.smith", "al"]);
  assert.deepEqual(TB.parse("Met @Sarah-Jane today.").mentions, ["Sarah-Jane"]);
});

test("resolveDue: defaults, relative, ISO, never, bad spec", () => {
  const base = "2026-07-12";
  assert.equal(TB.resolveDue(null, base), "2026-07-15"); // default 3 days
  assert.equal(TB.resolveDue(null, base, 7), "2026-07-19");
  assert.equal(TB.resolveDue("5d", base), "2026-07-17");
  assert.equal(TB.resolveDue("2w", base), "2026-07-26");
  assert.equal(TB.resolveDue("2026-08-01", base), "2026-08-01");
  assert.equal(TB.resolveDue("never", base), null);
  assert.throws(() => TB.resolveDue("tuesday", base));
});

test("resolveDue accepts a Date object for base, matching UTC date parts", () => {
  const base = new Date(Date.UTC(2026, 6, 12)); // July 12 2026
  assert.equal(TB.resolveDue(null, base), "2026-07-15");
});

// ---------------------------------------------------------------- fold
// Same scenario as tests/conftest.py::scenario_events

function scenarioEvents() {
  return [
    {
      id: "ev_01", ts: "2026-06-01T10:00:00Z", type: "person",
      person: { id: "per_sarah_chen", name: "Sarah Chen", aliases: ["sarah"], cadence_days: 30 },
    },
    {
      id: "ev_02", ts: "2026-06-01T10:00:01Z", type: "thread",
      thread: { id: "thr_sarah_chen", title: "Sarah Chen", kind: "1:1", people: ["per_sarah_chen"] },
    },
    {
      id: "ev_03", ts: "2026-06-14T14:32:00Z", type: "note",
      thread: "thr_sarah_chen", people: ["per_sarah_chen"],
      body: "Talked about SAE feature steering.\n\n> send her the format-robustness draft\n? does her harness handle [0,1] labels",
      items: [
        { id: "itm_a", kind: "commit", text: "send her the format-robustness draft", owner: "me", due: "2026-06-17" },
        { id: "itm_b", kind: "question", text: "does her harness handle [0,1] labels", owner: null, due: null },
      ],
    },
    { id: "ev_04", ts: "2026-06-18T09:00:00Z", type: "nudge", item: "itm_a", due: "2026-06-25" },
    {
      id: "ev_05", ts: "2026-06-21T09:00:00Z", type: "revise",
      supersedes: "itm_a", thread: "thr_sarah_chen", people: ["per_sarah_chen"],
      items: [{ id: "itm_c", kind: "commit", text: "send draft + the D3 figure", owner: "me", due: "2026-06-28" }],
    },
    { id: "ev_06", ts: "2026-06-28T09:00:00Z", type: "close", closes: "itm_c", comment: "sent it" },
    { id: "ev_07", ts: "2026-06-29T09:00:00Z", type: "close", closes: "itm_b" },
    { id: "ev_08", ts: "2026-06-30T09:00:00Z", type: "reopen", reopens: "itm_b" },
    { id: "ev_09", ts: "2026-07-02T10:00:00Z", type: "person", person: { id: "per_sarah_chen", org: "AISC" } },
    {
      id: "ev_10", ts: "2026-07-03T10:00:00Z", type: "note",
      thread: "thr_misc", people: [],
      body: "> chase the reimbursement",
      items: [{ id: "itm_d", kind: "commit", text: "chase the reimbursement", owner: "me", due: "2026-07-05" }],
    },
  ];
}

test("fold: person merge is field-wise", () => {
  const s = TB.fold(scenarioEvents());
  const p = s.people["per_sarah_chen"];
  assert.equal(p.name, "Sarah Chen");
  assert.equal(p.org, "AISC");
  assert.equal(p.cadence_days, 30);
  assert.equal(p.last_contact, "2026-06-14T14:32:00Z");
});

test("fold: thread seen range", () => {
  const s = TB.fold(scenarioEvents());
  const t = s.threads["thr_sarah_chen"];
  assert.equal(t.first_seen, "2026-06-14T14:32:00Z");
  assert.equal(t.last_seen, "2026-06-14T14:32:00Z");
  assert.equal(t.kind, "1:1");
});

test("fold: revise chain links", () => {
  const s = TB.fold(scenarioEvents());
  const a = s.items["itm_a"];
  const c = s.items["itm_c"];
  assert.equal(a.superseded_by, "itm_c");
  assert.equal(c.supersedes, "itm_a");
  assert.deepEqual(s.chain(a).map((i) => i.id), ["itm_a", "itm_c"]);
  assert.equal(s.head(a).id, "itm_c");
  assert.equal(s.root(c).id, "itm_a");
});

test("fold: exactly two states", () => {
  const s = TB.fold(scenarioEvents());
  for (const item of Object.values(s.items)) {
    assert.ok(item.status === "open" || item.status === "closed");
  }
});

test("fold: open/closed heads only", () => {
  const s = TB.fold(scenarioEvents());
  assert.deepEqual(s.openItems().map((i) => i.id), ["itm_b", "itm_d"]);
  assert.deepEqual(s.closedItems().map((i) => i.id), ["itm_c"]);
});

test("fold: nudge overrides due (effective due)", () => {
  const s = TB.fold(scenarioEvents());
  const a = s.items["itm_a"];
  assert.equal(a.due, "2026-06-17");
  assert.equal(s.effectiveDue(a), "2026-06-25");
});

test("fold: due items excludes never and closed", () => {
  const s = TB.fold(scenarioEvents());
  assert.deepEqual(s.dueItems("2026-07-10").map((i) => i.id), ["itm_d"]);
  assert.deepEqual(s.dueItems("2026-07-04"), []);
});

test("fold: snooze to never removes from due", () => {
  const events = [
    {
      id: "ev_1", ts: "2026-07-01T00:00:00Z", type: "note",
      thread: "thr_x", people: [], body: "> do it",
      items: [{ id: "itm_x", kind: "commit", text: "do it", owner: "me", due: "2026-07-02" }],
    },
    { id: "ev_2", ts: "2026-07-01T01:00:00Z", type: "nudge", item: "itm_x", due: null },
  ];
  const s = TB.fold(events);
  assert.deepEqual(s.dueItems("2026-08-01"), []);
  assert.equal(s.effectiveDue(s.items["itm_x"]), null);
});

test("fold: reopen restores open and records history", () => {
  const s = TB.fold(scenarioEvents());
  const b = s.items["itm_b"];
  assert.equal(b.status, "open");
  assert.equal(b.closed_ts, null);
  assert.deepEqual(b.history.map((h) => h.action), ["opened", "closed", "reopened"]);
});

test("fold: gone quiet", () => {
  const s = TB.fold(scenarioEvents());
  const quiet = s.goneQuiet("2026-07-20");
  assert.deepEqual(quiet.map(([p, days]) => [p.id, days]), [["per_sarah_chen", 36]]);
  assert.deepEqual(s.goneQuiet("2026-07-01"), []);
});

test("fold: dangling refs warn but do not crash", () => {
  const s = TB.fold([{ id: "ev_1", ts: "t", type: "close", closes: "itm_ghost" }]);
  assert.ok(s.warnings.length > 0);
  assert.ok(s.warnings[0].includes("itm_ghost"));
});

test("fold: deterministic re-fold", () => {
  const a = TB.fold(scenarioEvents());
  const b = TB.fold(scenarioEvents());
  assert.deepEqual(a.openItems().map((i) => i.id), b.openItems().map((i) => i.id));
  assert.deepEqual(a.dueItems("2026-07-10").map((i) => i.id), b.dueItems("2026-07-10").map((i) => i.id));
});

test("fold: itemPerson prefers per_* owner, falls back to first person", () => {
  const s = TB.fold(scenarioEvents());
  assert.equal(s.itemPerson(s.items["itm_b"]), "per_sarah_chen"); // owner null, people[0]
  assert.equal(s.itemPerson(s.items["itm_d"]), null); // owner "me", no people
});

test("fold: recentNotes returns last n, newest first", () => {
  const s = TB.fold(scenarioEvents());
  const recent = s.recentNotes(5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].id, "ev_10");
  assert.equal(recent[1].id, "ev_03");
});

// ---------------------------------------------------------------- events.py

test("events.note / events.close carry the right fields, omit the rest", () => {
  const n = TB.events.note("thr_x", ["per_a"], "hello", []);
  assert.equal(n.type, "note");
  assert.equal(n.thread, "thr_x");
  assert.deepEqual(n.people, ["per_a"]);
  assert.equal(n.body, "hello");
  assert.ok(!("body_clean" in n));
  assert.ok(/^ev_[0-9A-Z]{26}$/.test(n.id));
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(n.ts));

  const c = TB.events.close("itm_x");
  assert.equal(c.type, "close");
  assert.equal(c.closes, "itm_x");
  assert.ok(!("comment" in c));

  const c2 = TB.events.close("itm_x", "done");
  assert.equal(c2.comment, "done");
});

test("events.*: default ts is now when omitted", () => {
  const before = Date.now();
  const n = TB.events.note("thr_x", [], "hi", []);
  const after = Date.now();
  const ms = Date.parse(n.ts);
  assert.ok(ms >= before - 1000 && ms <= after + 1000);
});

test("events.*: every constructor accepts an optional trailing ts override", () => {
  const ts = "2026-01-02T03:04:05Z";
  assert.equal(TB.events.note("thr_x", ["per_a"], "hi", [], null, ts).ts, ts);
  assert.equal(TB.events.close("itm_x", undefined, ts).ts, ts);
  assert.equal(TB.events.reopen("itm_x", ts).ts, ts);
  assert.equal(TB.events.nudge("itm_x", "2026-02-01", undefined, ts).ts, ts);
  assert.equal(TB.events.person({ id: "per_x", name: "X" }, ts).ts, ts);
  assert.equal(TB.events.thread({ id: "thr_x", title: "X" }, ts).ts, ts);
});

// ---------------------------------------------------------------- fold: backdating (out-of-order ts)

test("fold: thread first_seen/last_seen are min/max over ts, not write order", () => {
  // ev_3 arrives last in the log but is backdated earlier than both prior
  // notes. first_seen must become the min ts seen and last_seen the max,
  // regardless of the order events were appended in.
  const events = [
    { id: "ev_1", ts: "2026-06-10T09:00:00Z", type: "note", thread: "thr_x", people: [], body: "first", items: [] },
    { id: "ev_2", ts: "2026-06-20T09:00:00Z", type: "note", thread: "thr_x", people: [], body: "second", items: [] },
    { id: "ev_3", ts: "2026-06-05T09:00:00Z", type: "note", thread: "thr_x", people: [], body: "backdated", items: [] },
  ];
  const s = TB.fold(events);
  const t = s.threads["thr_x"];
  assert.equal(t.first_seen, "2026-06-05T09:00:00Z");
  assert.equal(t.last_seen, "2026-06-20T09:00:00Z");
});

test("fold: person last_contact is max-guarded against an out-of-order backdated note", () => {
  const events = [
    { id: "ev_1", ts: "2026-06-20T09:00:00Z", type: "note", thread: "thr_x", people: ["per_a"], body: "later", items: [] },
    { id: "ev_2", ts: "2026-06-05T09:00:00Z", type: "note", thread: "thr_x", people: ["per_a"], body: "backdated", items: [] },
  ];
  const s = TB.fold(events);
  assert.equal(s.people["per_a"].last_contact, "2026-06-20T09:00:00Z");
});

// ---------------------------------------------------------------- timestamp entry (save-step "when" field)

test("nowLocalISO: shape, and round-trips via parseTimestamp to ~now in the pinned zone", () => {
  const before = Date.now();
  const iso = TB.nowLocalISO();
  const after = Date.now();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

  // Never toISOString() for this: cross-check the offset independently,
  // straight off getTimezoneOffset(), rather than trusting core.js's own math.
  const now = new Date();
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const expectedOffset = sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
  assert.ok(iso.endsWith(expectedOffset), `expected ${iso} to end with ${expectedOffset}`);

  const parsed = TB.parseTimestamp(iso);
  assert.equal(parsed.ok, true);
  const parsedMs = Date.parse(parsed.ts);
  assert.ok(parsedMs >= before - 1000 && parsedMs <= after + 1000);
  const expectedLocalDate = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  assert.equal(parsed.localDate, expectedLocalDate);
});

test("parseTimestamp: Z passthrough", () => {
  const r = TB.parseTimestamp("2026-07-13T09:42:00Z");
  assert.deepEqual(r, { ok: true, ts: "2026-07-13T09:42:00Z", localDate: "2026-07-13" });
});

test("parseTimestamp: missing seconds default to :00", () => {
  const r = TB.parseTimestamp("2026-07-13T09:42Z");
  assert.equal(r.ok, true);
  assert.equal(r.ts, "2026-07-13T09:42:00Z");
});

test("parseTimestamp: numeric offset converts to correct UTC, with and without colon", () => {
  assert.equal(TB.parseTimestamp("2026-07-13T09:42:00+01:00").ts, "2026-07-13T08:42:00Z");
  assert.equal(TB.parseTimestamp("2026-07-13T09:42:00+0100").ts, "2026-07-13T08:42:00Z");
  assert.equal(TB.parseTimestamp("2026-07-13T09:42:00-05:00").ts, "2026-07-13T14:42:00Z");
});

test("parseTimestamp: no offset is interpreted as local time (pinned TZ)", () => {
  // Europe/London in July is BST (UTC+1) — same instant as the +01:00 case.
  const r = TB.parseTimestamp("2026-07-13T09:42:00");
  assert.equal(r.ok, true);
  assert.equal(r.ts, "2026-07-13T08:42:00Z");
  assert.equal(r.localDate, "2026-07-13");
});

test("parseTimestamp: localDate is the date as typed, not the UTC-shifted date", () => {
  // Local midnight-thirty at +05:00 lands on the previous UTC day; localDate
  // must still read "the note's date" as the human typed it.
  const r = TB.parseTimestamp("2026-07-13T00:30:00+05:00");
  assert.equal(r.ok, true);
  assert.equal(r.ts, "2026-07-12T19:30:00Z");
  assert.equal(r.localDate, "2026-07-13");
});

test("parseTimestamp: trims surrounding whitespace", () => {
  const r = TB.parseTimestamp("  2026-07-13T09:42:00Z  ");
  assert.equal(r.ok, true);
  assert.equal(r.ts, "2026-07-13T09:42:00Z");
});

test("parseTimestamp: garbage is rejected with a short error", () => {
  for (const bad of ["banana", "", "   ", "2026-07-13", "13/07/2026 09:42", "2026-07-13 09:42:00"]) {
    const r = TB.parseTimestamp(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 0 && r.error.length < 80);
  }
});

test("parseTimestamp: impossible calendar dates are rejected, not rolled over", () => {
  // Naive `new Date(2026, 1, 30)` silently becomes March 2 — must not happen.
  assert.equal(TB.parseTimestamp("2026-02-30T10:00:00").ok, false);
  assert.equal(TB.parseTimestamp("2026-02-30T10:00:00Z").ok, false);
  assert.equal(TB.parseTimestamp("2026-04-31T10:00:00Z").ok, false);
  assert.equal(TB.parseTimestamp("2026-07-13T25:00:00Z").ok, false); // bad hour
  assert.equal(TB.parseTimestamp("2026-07-13T09:60:00Z").ok, false); // bad minute
  // 2024 is a leap year, 2026 is not: Feb 29 valid one year, not the other.
  assert.equal(TB.parseTimestamp("2024-02-29T10:00:00Z").ok, true);
  assert.equal(TB.parseTimestamp("2026-02-29T10:00:00Z").ok, false);
});

// ---------------------------------------------------------------- cli.py: resolve_person

test("resolvePerson: exact name, alias, loose first-name, id match", () => {
  const s = TB.fold(scenarioEvents());
  assert.deepEqual(TB.resolvePerson(s, "Sarah Chen").map((p) => p.id), ["per_sarah_chen"]);
  assert.deepEqual(TB.resolvePerson(s, "sarah").map((p) => p.id), ["per_sarah_chen"]); // alias
  assert.deepEqual(TB.resolvePerson(s, "Chen").map((p) => p.id), ["per_sarah_chen"]); // loose (name word)
  assert.deepEqual(TB.resolvePerson(s, "nobody"), []);
});

// ---------------------------------------------------------------- similarity / matchCloses

test("similarity: identical strings score 1", () => {
  assert.equal(TB.similarity("send the draft", "send the draft"), 1);
});

test("similarity: disjoint strings score near 0", () => {
  assert.ok(TB.similarity("send the draft", "zzyx qqvv") < 0.15);
});

test("similarity: near-duplicate phrasing clears 0.6", () => {
  const score = TB.similarity(
    "send the format robustness draft",
    "send her the format-robustness draft"
  );
  assert.ok(score >= 0.6, `expected >= 0.6, got ${score}`);
});

test("matchCloses: best match per text, floor at 0.35, never auto-selects below floor", () => {
  const candidates = [
    { id: "itm_1", text: "send her the format-robustness draft" },
    { id: "itm_2", text: "does her harness handle labels" },
  ];
  const results = TB.matchCloses(["send the format robustness draft", "completely unrelated text"], candidates);
  assert.equal(results[0].item.id, "itm_1");
  assert.ok(results[0].score >= TB.YES_CLOSE_THRESHOLD);
  assert.equal(results[1].item, null);
});
