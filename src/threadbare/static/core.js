/*
 * core.js — pure logic, ported from the Python modules. No DOM, no fetch.
 *
 * Mirrors, field-for-field and semantics-for-semantics:
 *   - src/threadbare/ids.py       (ULID, slugify, person_id, thread_id)
 *   - src/threadbare/notation.py  (@/>/? / >> / ! parsing, resolve_due)
 *   - src/threadbare/fold.py      (the fold: events -> State)
 *   - src/threadbare/events.py    (event constructors)
 *   - src/threadbare/cli.py       (resolve_person, >> fuzzy matching)
 *
 * Runs unmodified in the browser (attached to window.TB) and under Node
 * (module.exports) so tests/frontend_core.test.mjs can require() it.
 */

(function () {
  "use strict";

  // ================================================================
  // ids.py
  // ================================================================

  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  let _lastMs = -1n;
  let _lastRand = 0n;

  function _randomBytes(n) {
    const arr = new Uint8Array(n);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }

  function _bytesToBigInt(bytes) {
    let v = 0n;
    for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }

  function _encode(value, length) {
    let v = BigInt(value);
    const chars = new Array(length);
    for (let i = length - 1; i >= 0; i--) {
      chars[i] = CROCKFORD[Number(v & 0x1fn)];
      v >>= 5n;
    }
    return chars.join("");
  }

  /** 26-char Crockford ULID; strictly increasing within this page. */
  function newUlid() {
    let ms = BigInt(Date.now());
    if (ms <= _lastMs) {
      ms = _lastMs;
      _lastRand += 1n;
    } else {
      _lastMs = ms;
      _lastRand = _bytesToBigInt(_randomBytes(10)) >> 1n;
    }
    return _encode(ms, 10) + _encode(_lastRand, 16);
  }

  function newEventId() {
    return "ev_" + newUlid();
  }

  function newItemId() {
    return "itm_" + newUlid();
  }

  function slugify(text, sep) {
    sep = sep === undefined ? "_" : sep;
    let slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, sep);
    const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const stripRe = new RegExp("^(?:" + escaped + ")+|(?:" + escaped + ")+$", "g");
      slug = slug.replace(stripRe, "");
    }
    return slug || "x";
  }

  function personId(name) {
    return "per_" + slugify(name);
  }

  function threadId(title) {
    return "thr_" + slugify(title);
  }

  // ================================================================
  // notation.py
  // ================================================================

  const MENTION_SRC = "@([A-Za-z][A-Za-z0-9_.'-]*)";
  const DUE_SRC = "(?:(?<=\\s)|^)!(never|\\d{4}-\\d{2}-\\d{2}|\\d+[dw])\\b";
  const DEFAULT_NUDGE_DAYS = 3;

  function _mentionRe(flags) {
    return new RegExp(MENTION_SRC, flags || "");
  }

  function _dueRe() {
    return new RegExp(DUE_SRC, "i");
  }

  /** Parse the inline notation: @name, >, ?, >>, !when. */
  function parse(body) {
    const mentions = [];
    const seen = new Set();
    const mentionAll = _mentionRe("g");
    let m;
    while ((m = mentionAll.exec(body)) !== null) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        mentions.push(name);
      }
    }

    const items = [];
    const closes = [];
    for (const line of body.split(/\r\n|\r|\n/)) {
      const stripped = line.trim();
      if (stripped.startsWith(">>")) {
        closes.push(stripped.slice(2).trim());
      } else if (stripped.startsWith(">")) {
        items.push(_parseItem("commit", stripped.slice(1)));
      } else if (stripped.startsWith("?")) {
        items.push(_parseItem("question", stripped.slice(1)));
      }
    }
    return { mentions, items, closes };
  }

  function _parseItem(kind, rest) {
    let dueSpec = null;
    const dueMatch = _dueRe().exec(rest);
    if (dueMatch) {
      dueSpec = dueMatch[1].toLowerCase();
      rest = rest.slice(0, dueMatch.index) + rest.slice(dueMatch.index + dueMatch[0].length);
    }
    const mentionMatch = _mentionRe().exec(rest);
    return {
      kind: kind,
      text: rest.split(/\s+/).filter(Boolean).join(" "),
      due_spec: dueSpec,
      mention: mentionMatch ? mentionMatch[1] : null,
    };
  }

  /** Turn a !spec into an ISO date relative to base; null means never nudge. */
  function resolveDue(spec, base, defaultDays) {
    defaultDays = defaultDays === undefined ? DEFAULT_NUDGE_DAYS : defaultDays;
    const baseISO = toISODate(base);
    if (spec === null || spec === undefined) {
      return addDays(baseISO, defaultDays);
    }
    const lower = String(spec).toLowerCase();
    if (lower === "never") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return lower;
    const m = /^(\d+)([dw])$/.exec(lower);
    if (!m) throw new Error("bad nudge spec: " + JSON.stringify(spec));
    const days = parseInt(m[1], 10) * (m[2] === "w" ? 7 : 1);
    return addDays(baseISO, days);
  }

  // ---- date helpers (dates are plain "YYYY-MM-DD" strings, UTC-based) ----

  function toISODate(d) {
    if (d instanceof Date) {
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const da = String(d.getUTCDate()).padStart(2, "0");
      return y + "-" + mo + "-" + da;
    }
    return String(d).slice(0, 10);
  }

  function _epochDay(iso) {
    const parts = iso.split("-").map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
  }

  function daysBetween(aISO, bISO) {
    return Math.round(_epochDay(aISO) - _epochDay(bISO));
  }

  function addDays(iso, n) {
    const parts = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  function todayISO() {
    return toISODate(new Date());
  }

  // ================================================================
  // fold.py
  // ================================================================

  const PERSON_FIELDS = ["name", "aliases", "org", "links", "tags", "met_context", "cadence_days"];
  const THREAD_FIELDS = ["title", "people", "kind"];

  function newPerson(id, name) {
    return {
      id: id,
      name: name === undefined ? "" : name,
      aliases: [],
      org: null,
      links: [],
      tags: [],
      met_context: null,
      cadence_days: null,
      last_contact: null,
    };
  }

  function newThread(id, title) {
    return {
      id: id,
      title: title === undefined ? "" : title,
      people: [],
      kind: "ad-hoc",
      first_seen: null,
      last_seen: null,
    };
  }

  function newItem(id) {
    return {
      id: id,
      kind: "commit",
      text: "",
      owner: null,
      thread: null,
      people: [],
      opened_ts: null,
      due: null,
      status: "open",
      closed_ts: null,
      close_comment: null,
      supersedes: null,
      superseded_by: null,
      nudged: false,
      due_override: null,
      history: [],
    };
  }

  function fold(events) {
    const state = {
      people: {},
      threads: {},
      items: {},
      notes: [],
      events: [],
      warnings: [],
    };
    for (const e of events) {
      state.events.push(e);
      const t = e.type;
      if (t === "person") _mergePerson(state, e);
      else if (t === "thread") _mergeThread(state, e);
      else if (t === "note") _applyNote(state, e);
      else if (t === "revise") _applyRevise(state, e);
      else if (t === "close") _applyClose(state, e);
      else if (t === "reopen") _applyReopen(state, e);
      else if (t === "nudge") _applyNudge(state, e);
      else state.warnings.push((e.id || "?") + ": unknown event type " + JSON.stringify(t));
    }
    _attachQueries(state);
    return state;
  }

  function _mergePerson(state, e) {
    const rec = e.person || {};
    const pid = rec.id;
    if (!pid) {
      state.warnings.push(e.id + ": person event without person.id");
      return;
    }
    if (!state.people[pid]) state.people[pid] = newPerson(pid);
    const p = state.people[pid];
    for (const f of PERSON_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rec, f)) p[f] = rec[f];
    }
  }

  function _mergeThread(state, e) {
    const rec = e.thread || {};
    const tid = rec.id;
    if (!tid) {
      state.warnings.push(e.id + ": thread event without thread.id");
      return;
    }
    if (!state.threads[tid]) state.threads[tid] = newThread(tid);
    const t = state.threads[tid];
    for (const f of THREAD_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rec, f)) t[f] = rec[f];
    }
  }

  function _applyNote(state, e) {
    state.notes.push(e);
    const tid = e.thread;
    if (tid) {
      if (!state.threads[tid]) state.threads[tid] = newThread(tid, tid);
      const t = state.threads[tid];
      t.first_seen = t.first_seen || e.ts;
      t.last_seen = e.ts;
    }
    for (const pid of e.people || []) {
      if (!state.people[pid]) state.people[pid] = newPerson(pid, pid);
      const p = state.people[pid];
      if (p.last_contact === null || e.ts > p.last_contact) p.last_contact = e.ts;
    }
    _openItemsFromEvent(state, e);
  }

  function _openItemsFromEvent(state, e) {
    const created = [];
    for (const entry of e.items || []) {
      const item = newItem(entry.id);
      item.kind = entry.kind || "commit";
      item.text = entry.text || "";
      item.owner = entry.owner === undefined ? null : entry.owner;
      item.thread = e.thread === undefined ? null : e.thread;
      item.people = (e.people || []).slice();
      item.opened_ts = e.ts;
      item.due = entry.due === undefined ? null : entry.due;
      item.history.push({ ts: e.ts, action: "opened" });
      state.items[item.id] = item;
      created.push(item);
    }
    return created;
  }

  function _applyRevise(state, e) {
    const created = _openItemsFromEvent(state, e);
    const old = state.items[e.supersedes || ""];
    if (!old) {
      state.warnings.push(e.id + ": revise of unknown item " + JSON.stringify(e.supersedes || null));
      return;
    }
    if (created.length === 0) {
      state.warnings.push(e.id + ": revise event carries no new item");
      return;
    }
    const fresh = created[0];
    fresh.supersedes = old.id;
    old.superseded_by = fresh.id;
    old.history.push({ ts: e.ts, action: "revised", to: fresh.id });
    if (!e.people || e.people.length === 0) fresh.people = old.people.slice();
    if (!e.thread) fresh.thread = old.thread;
  }

  function _applyClose(state, e) {
    const item = state.items[e.closes || ""];
    if (!item) {
      state.warnings.push(e.id + ": close of unknown item " + JSON.stringify(e.closes || null));
      return;
    }
    item.status = "closed";
    item.closed_ts = e.ts;
    item.close_comment = e.comment === undefined ? null : e.comment;
    item.history.push({ ts: e.ts, action: "closed", comment: e.comment === undefined ? null : e.comment });
  }

  function _applyReopen(state, e) {
    const item = state.items[e.reopens || ""];
    if (!item) {
      state.warnings.push(e.id + ": reopen of unknown item " + JSON.stringify(e.reopens || null));
      return;
    }
    item.status = "open";
    item.closed_ts = null;
    item.close_comment = null;
    item.history.push({ ts: e.ts, action: "reopened" });
  }

  function _applyNudge(state, e) {
    const item = state.items[e.item || ""];
    if (!item) {
      state.warnings.push(e.id + ": nudge of unknown item " + JSON.stringify(e.item || null));
      return;
    }
    item.nudged = true;
    item.due_override = e.due === undefined ? null : e.due;
    item.history.push({ ts: e.ts, action: "snoozed", due: e.due === undefined ? null : e.due });
  }

  function _attachQueries(state) {
    state.effectiveDue = function (item) {
      return item.nudged ? item.due_override : item.due;
    };
    state.root = function (item) {
      while (item.supersedes && state.items[item.supersedes]) {
        item = state.items[item.supersedes];
      }
      return item;
    };
    state.head = function (item) {
      while (item.superseded_by) {
        item = state.items[item.superseded_by];
      }
      return item;
    };
    state.chain = function (item) {
      let node = state.root(item);
      const out = [node];
      while (node.superseded_by) {
        node = state.items[node.superseded_by];
        out.push(node);
      }
      return out;
    };
    state.openItems = function () {
      const out = Object.values(state.items).filter(
        (i) => i.superseded_by === null && i.status === "open"
      );
      out.sort((a, b) => (a.opened_ts < b.opened_ts ? -1 : a.opened_ts > b.opened_ts ? 1 : 0));
      return out;
    };
    state.closedItems = function () {
      const out = Object.values(state.items).filter(
        (i) => i.superseded_by === null && i.status === "closed"
      );
      out.sort((a, b) => {
        const da = a.closed_ts || a.opened_ts;
        const db = b.closed_ts || b.opened_ts;
        return da < db ? 1 : da > db ? -1 : 0; // reverse (newest first)
      });
      return out;
    };
    state.dueItems = function (today) {
      const cutoff = toISODate(today);
      const out = state.openItems().filter((i) => {
        const d = state.effectiveDue(i);
        return d !== null && d <= cutoff;
      });
      out.sort((a, b) => {
        const da = state.effectiveDue(a);
        const db = state.effectiveDue(b);
        return da < db ? -1 : da > db ? 1 : 0;
      });
      return out;
    };
    state.goneQuiet = function (today) {
      const todayISO = toISODate(today);
      const out = [];
      for (const p of Object.values(state.people)) {
        if (p.cadence_days === null || p.cadence_days === undefined) continue;
        if (p.last_contact === null || p.last_contact === undefined) continue;
        const days = daysBetween(todayISO, p.last_contact.slice(0, 10));
        if (days > p.cadence_days) out.push([p, days]);
      }
      out.sort((a, b) => b[1] - a[1]);
      return out;
    };
    state.recentNotes = function (n) {
      n = n === undefined ? 5 : n;
      return state.notes.slice(Math.max(0, state.notes.length - n)).reverse();
    };
    state.itemPerson = function (item) {
      if (item.owner && String(item.owner).startsWith("per_")) return item.owner;
      return item.people.length ? item.people[0] : null;
    };
  }

  // ================================================================
  // events.py
  // ================================================================

  function nowTs() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function _base(type) {
    return { id: newEventId(), ts: nowTs(), type: type };
  }

  function eventNote(thread, people, body, items, bodyClean) {
    const e = _base("note");
    e.thread = thread;
    e.people = people;
    e.body = body;
    e.items = items;
    if (bodyClean !== null && bodyClean !== undefined) e.body_clean = bodyClean;
    return e;
  }

  function eventClose(itemId, comment) {
    const e = _base("close");
    e.closes = itemId;
    if (comment) e.comment = comment;
    return e;
  }

  function eventReopen(itemId) {
    const e = _base("reopen");
    e.reopens = itemId;
    return e;
  }

  function eventNudge(itemId, due, comment) {
    const e = _base("nudge");
    e.item = itemId;
    e.due = due === undefined ? null : due;
    if (comment) e.comment = comment;
    return e;
  }

  function eventPerson(record) {
    const e = _base("person");
    e.person = record;
    return e;
  }

  function eventThread(record) {
    const e = _base("thread");
    e.thread = record;
    return e;
  }

  // ================================================================
  // cli.py — resolve_person, >> fuzzy matching
  // ================================================================

  /** Match a mention against known people: id, name, alias, or first name. */
  function resolvePerson(state, name) {
    const needle = name.toLowerCase();
    if (state.people[name]) return [state.people[name]];
    const exact = [];
    const loose = [];
    for (const p of Object.values(state.people)) {
      const pname = (p.name || "").toLowerCase();
      const aliases = (p.aliases || []).map((a) => a.toLowerCase());
      if (pname === needle || aliases.indexOf(needle) !== -1) {
        exact.push(p);
      } else if (pname.split(/\s+/).filter(Boolean).indexOf(needle) !== -1 || p.id === personId(name)) {
        loose.push(p);
      }
    }
    return exact.length ? exact : loose;
  }

  const MATCH_FLOOR = 0.35;
  const YES_CLOSE_THRESHOLD = 0.6;

  function _bigramCounts(s) {
    const counts = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      counts.set(bg, (counts.get(bg) || 0) + 1);
    }
    return counts;
  }

  /** Dice coefficient over character bigrams, in [0, 1]. JS has no difflib. */
  function similarity(a, b) {
    const A = String(a == null ? "" : a).toLowerCase();
    const B = String(b == null ? "" : b).toLowerCase();
    if (A === B) return 1;
    if (A.length < 2 || B.length < 2) return 0;
    const bgA = _bigramCounts(A);
    const bgB = _bigramCounts(B);
    let totalA = 0;
    for (const v of bgA.values()) totalA += v;
    let totalB = 0;
    for (const v of bgB.values()) totalB += v;
    let overlap = 0;
    for (const [bg, count] of bgA) {
      const other = bgB.get(bg);
      if (other) overlap += Math.min(count, other);
    }
    if (totalA + totalB === 0) return 0;
    return (2 * overlap) / (totalA + totalB);
  }

  /**
   * Best-match each `>>` close text against candidateItems (already filtered
   * by the caller to the relevant people, mirroring cli._match_closes).
   * Returns [{text, item, score}], item is null when nothing clears the floor.
   */
  function matchCloses(closeTexts, candidateItems) {
    return closeTexts.map((text) => {
      let best = null;
      let score = 0;
      for (const item of candidateItems) {
        const s = similarity(text, item.text);
        if (s > score) {
          best = item;
          score = s;
        }
      }
      if (best === null || score < MATCH_FLOOR) return { text: text, item: null, score: 0 };
      return { text: text, item: best, score: score };
    });
  }

  // ================================================================
  // exports
  // ================================================================

  const TB = {
    // ids.py
    newUlid: newUlid,
    newEventId: newEventId,
    newItemId: newItemId,
    slugify: slugify,
    personId: personId,
    threadId: threadId,
    // notation.py
    parse: parse,
    resolveDue: resolveDue,
    DEFAULT_NUDGE_DAYS: DEFAULT_NUDGE_DAYS,
    // date helpers
    toISODate: toISODate,
    addDays: addDays,
    daysBetween: daysBetween,
    todayISO: todayISO,
    // fold.py
    fold: fold,
    // events.py
    nowTs: nowTs,
    events: {
      note: eventNote,
      close: eventClose,
      reopen: eventReopen,
      nudge: eventNudge,
      person: eventPerson,
      thread: eventThread,
    },
    // cli.py
    resolvePerson: resolvePerson,
    similarity: similarity,
    matchCloses: matchCloses,
    MATCH_FLOOR: MATCH_FLOOR,
    YES_CLOSE_THRESHOLD: YES_CLOSE_THRESHOLD,
  };

  if (typeof window !== "undefined") {
    window.TB = TB;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TB;
  }
})();
