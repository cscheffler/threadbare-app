/* app.js — UI. Hash routing, dashboard, scratchpad, confirm step, thread/item views.
 * Depends on window.TB (core.js, loaded first). Vanilla DOM, no framework, no build step.
 * Loaded as a classic script (not a module) so everything here is plain top-level scope.
 */
"use strict";

const LS_DRAFT = "tb_draft_v1";
const LS_QUEUE = "tb_queue_v1";

// ---------------------------------------------------------------- DOM helper

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
  }
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

function dateOf(ts) { return (ts || "").slice(0, 10); }

// "(opened 2026-07-01; nudge 2026-07-03)" or "(opened 2026-07-01)" when the
// item has no effective due (never-nudge, or nudged off). The nudge date is
// always the fold's effectiveDue — last nudge event wins, else the item's
// own due — never recomputed here.
function loopDatesLabel(s, item) {
  const opened = "opened " + dateOf(item.opened_ts);
  const due = s.effectiveDue(item);
  return due ? "(" + opened + "; nudge " + dateOf(due) + ")" : "(" + opened + ")";
}

function dedupe(arr) {
  const out = [], seen = new Set();
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function personName(s, pid) {
  if (!pid) return "";
  const p = s.people[pid];
  return p ? (p.name || pid) : pid;
}

function threadPeopleIds(tid) {
  const s = App.folded, t = s.threads[tid];
  const ids = new Set(t ? t.people : []);
  for (const n of s.notes) if (n.thread === tid) for (const p of n.people || []) ids.add(p);
  return Array.from(ids);
}

function mostRecentThreadForPerson(pid) {
  const s = App.folded;
  let best = null, bestTs = null;
  for (const n of s.notes) {
    if (n.thread && (n.people || []).includes(pid)) {
      if (bestTs === null || n.ts > bestTs) { bestTs = n.ts; best = n.thread; }
    }
  }
  return best;
}

function personLink(pid, label) {
  const a = el("a", { href: "#", class: "person-link", text: label });
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    const tid = mostRecentThreadForPerson(pid);
    if (tid) location.hash = "#/thread/" + encodeURIComponent(tid);
  });
  return a;
}

// ---------------------------------------------------------------- persistence

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); } catch (e) { return []; }
}
function saveQueue(q) { localStorage.setItem(LS_QUEUE, JSON.stringify(q)); }
function pushQueue(events) { if (events.length) saveQueue(loadQueue().concat(events)); }

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(LS_DRAFT) || "null"); } catch (e) { return null; }
}
function saveDraft(d) { localStorage.setItem(LS_DRAFT, JSON.stringify(d)); }
function clearDraft() { localStorage.removeItem(LS_DRAFT); }

// ---------------------------------------------------------------- app state

const App = { serverEvents: [], events: [], folded: TB.fold([]), cursor: null, lastContactOK: null };
// creating tracks whether the inline "New person" form is open. It survives
// navigation away and back (mirrors PersonPageState.editing below) — only
// Cancel or a successful Save clears it. renderWouldClobberInput() protects
// the form's in-progress input via its person-edit-form class regardless.
const PeopleState = { filter: "", creating: false };
// PersonPageState.editing holds the id of the person whose inline edit form
// is open, else null. Keyed by id (not a bool) so navigating to a different
// person never accidentally reopens someone else's form.
const PersonPageState = { editing: null };
const PadState = {
  selectedThreadId: null, newThread: null, textareaValue: "",
  queuedLock: null, sidebarTicks: new Set(), pendingRestore: null, draftNotice: null,
  visibleCount: 5, // how many of the selected thread's notes are shown; resets to 5 on thread change / save
};

function recomputeFolded() {
  App.events = App.serverEvents.concat(loadQueue());
  App.folded = TB.fold(App.events);
}

// ---------------------------------------------------------------- network

async function apiGetEvents() {
  const res = await fetch("/events");
  if (!res.ok) throw new Error("bad status " + res.status);
  return res.json();
}
async function apiAppend(event) {
  const res = await fetch("/append", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error("bad status " + res.status);
  return res.json();
}

// True when a window-focus refresh must not call renderRoute(), because doing
// so would rebuild DOM out from under in-progress, unsaved user input:
//  - the person-edit form is open and currently on screen — checked by DOM
//    presence (view.querySelector), not by the raw PersonPageState.editing
//    flag: that flag is set by clicking "Edit" and only cleared by that
//    form's own Save/Cancel, so it stays set if the user navigates away
//    (e.g. clicks "Dashboard") without closing the form first. Guarding on
//    the flag alone would make every future focus refresh a no-op — on
//    every route, forever — which is exactly the "permanently inert" guard
//    the fix must avoid. Checking the form's actual DOM presence instead
//    means the guard only fires while that form is what's on screen;
//  - any focused input/textarea/select living inside #view — this generically
//    covers the dashboard closeWidget comment field, snoozeWidget date input,
//    the scratchpad textarea, and the People-view filter input, without
//    needing one check per widget. (This also covers the person-edit form's
//    own text fields; the DOM-presence check above additionally covers the
//    moment focus is on that form's Save/Cancel buttons.)
//  - the save/confirmation overlay (openConfirmPanel) is open. The overlay
//    itself is appended to document.body, not #view, so renderRoute() never
//    touches its DOM directly — but renderPad() and renderPeople() both end
//    by unconditionally focusing an element of the (hidden, behind-the-
//    overlay) view they just rebuilt. Left unguarded, a focus refresh while
//    the overlay is open silently steals focus from e.g. the "when" field
//    the user is mid-edit in, out into the hidden scratchpad textarea
//    underneath — a real instance of "re-render clobbers in-progress input"
//    even though the overlay's own DOM and value survive untouched.
function renderWouldClobberInput() {
  if (document.querySelector(".overlay")) return true;
  const view = document.getElementById("view");
  if (!view) return false;
  if (view.querySelector(".person-edit-form")) return true;
  const ae = document.activeElement;
  if (!ae || !view.contains(ae)) return false;
  return ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT";
}

async function refreshEvents(opts) {
  const render = !opts || opts.render !== false;
  try {
    const data = await apiGetEvents();
    App.serverEvents = data.events || [];
    App.cursor = data.cursor || null;
    App.lastContactOK = true;
  } catch (e) {
    App.lastContactOK = false;
  }
  recomputeFolded();
  updateDot();
  if (render) renderRoute();
}

async function flushQueue() {
  let queue = loadQueue();
  while (queue.length > 0) {
    const event = queue[0];
    try {
      await apiAppend(event);
      App.lastContactOK = true;
    } catch (e) {
      App.lastContactOK = false;
      updateDot();
      return false;
    }
    queue = queue.slice(1);
    saveQueue(queue);
  }
  updateDot();
  return true;
}

async function queueAndFlush(events, opts) {
  const render = !opts || opts.render !== false;
  if (events.length) pushQueue(events);
  recomputeFolded();
  if (render) renderRoute();
  const ok = await flushQueue();
  await refreshEvents({ render: render });
  return ok;
}

// ---------------------------------------------------------------- dot / banner / notices

function updateDot() {
  const dot = document.getElementById("status-dot");
  if (!dot) return;
  const queueLen = loadQueue().length;
  let cls, title;
  if (App.lastContactOK === null) { cls = "grey"; title = "backend: not yet contacted"; }
  else if (App.lastContactOK === false) { cls = "red"; title = "backend: last contact failed"; }
  else if (queueLen > 0) { cls = "red"; title = queueLen + " event(s) queued — retries on next save"; }
  else { cls = "green"; title = "backend: reachable"; }
  dot.className = "dot dot-" + cls;
  dot.title = title;
}

function showGlobalBanner(msg) {
  const b = document.getElementById("banner");
  if (!b) return;
  b.textContent = msg + " ";
  const dismiss = el("button", { class: "btn-small", text: "dismiss" });
  dismiss.addEventListener("click", hideGlobalBanner);
  b.appendChild(dismiss);
  b.classList.remove("hidden");
}
function hideGlobalBanner() {
  const b = document.getElementById("banner");
  if (!b) return;
  b.classList.add("hidden");
  b.textContent = "";
}
function showPadStatus(msg) {
  const e = document.getElementById("pad-status");
  if (e) e.textContent = msg;
}

// ---------------------------------------------------------------- routing

function renderRoute() {
  const hash = location.hash || "#/dash";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const route = parts[0] || "dash";
  document.querySelectorAll("nav a[data-route]").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
  if (route === "pad") renderPad();
  else if (route === "thread" && parts[1]) renderThreadView(decodeURIComponent(parts[1]));
  else if (route === "item" && parts[1]) renderItemView(decodeURIComponent(parts[1]));
  else if (route === "people") renderPeople();
  else if (route === "person" && parts[1]) renderPersonView(decodeURIComponent(parts[1]));
  else renderDash();
}

// ================================================================
// Dashboard
// ================================================================

function renderDash() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.appendChild(el("h1", { text: "Dashboard" }));
  const s = App.folded;
  const today = TB.todayISO();

  view.appendChild(el("h2", { text: "Due today" }));
  const due = s.dueItems(today);
  if (!due.length) view.appendChild(el("p", { class: "muted", text: "nothing due" }));
  else {
    const list = el("div", { class: "row-list" });
    for (const item of due) list.appendChild(dueRow(s, item, today));
    view.appendChild(list);
  }

  view.appendChild(el("h2", { text: "Gone quiet" }));
  const quiet = s.goneQuiet(today);
  if (!quiet.length) view.appendChild(el("p", { class: "muted", text: "nobody" }));
  else {
    const list = el("ul", { class: "plain-list" });
    for (const pair of quiet) {
      const p = pair[0], days = pair[1];
      const li = el("li");
      li.appendChild(personLink(p.id, p.name || p.id));
      li.appendChild(document.createTextNode(" — " + days + "d since last contact (cadence " + p.cadence_days + "d)"));
      list.appendChild(li);
    }
    view.appendChild(list);
  }

  view.appendChild(el("h2", { text: "Open loops" }));
  const open = s.openItems();
  if (!open.length) view.appendChild(el("p", { class: "muted", text: "no open items" }));
  else view.appendChild(groupedOpenLoops(s, open));

  view.appendChild(el("h2", { text: "Recent" }));
  const recent = s.recentNotes(5);
  if (!recent.length) view.appendChild(el("p", { class: "muted", text: "no notes yet" }));
  else {
    const list = el("ul", { class: "plain-list" });
    for (const e of recent) {
      const thread = s.threads[e.thread || ""];
      const tname = thread ? (thread.title || thread.id) : (e.thread || "?");
      const firstLine = (e.body || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
      list.appendChild(el("li", { text: dateOf(e.ts) + " — " + tname + ": " + firstLine.slice(0, 70) }));
    }
    view.appendChild(list);
  }
}

function groupedOpenLoops(s, items) {
  const groups = new Map();
  for (const item of items) {
    const pid = s.itemPerson(item);
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(item);
  }
  const ordered = Array.from(groups.keys()).sort((a, b) => {
    const na = a ? personName(s, a).toLowerCase() : "~";
    const nb = b ? personName(s, b).toLowerCase() : "~";
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const wrap = el("div");
  for (const pid of ordered) {
    const name = pid ? personName(s, pid) : "(unassigned)";
    const h3 = el("h3");
    if (pid) h3.appendChild(personLink(pid, name)); else h3.textContent = name;
    wrap.appendChild(h3);
    const list = el("div", { class: "row-list" });
    for (const item of groups.get(pid)) list.appendChild(openLoopRow(s, item));
    wrap.appendChild(list);
  }
  return wrap;
}

function openLoopRow(s, item) {
  const row = el("div", { class: "loop-row" });
  const mark = item.kind === "commit" ? "›" : "?";
  row.appendChild(el("span", { class: "mark", text: mark }));
  row.appendChild(el("span", { class: "item-text", text: item.text + " " + loopDatesLabel(s, item) }));
  const actions = el("span", { class: "actions" });
  actions.appendChild(closeWidget(item.id, renderDash));
  row.appendChild(actions);
  return row;
}

function dueRow(s, item, today) {
  const row = el("div", { class: "loop-row" });
  const mark = item.kind === "commit" ? "›" : "?";
  const who = s.itemPerson(item);
  const overdueDays = TB.daysBetween(today, s.effectiveDue(item));
  const whenLabel = overdueDays === 0 ? "due today" : overdueDays + "d overdue";
  row.appendChild(el("span", { class: "mark", text: mark }));
  row.appendChild(el("span", { class: "item-text", text: item.text }));
  if (who) { row.appendChild(document.createTextNode(" — ")); row.appendChild(personLink(who, personName(s, who))); }
  row.appendChild(el("span", { class: "due-label", text: " (" + whenLabel + ")" }));
  const actions = el("span", { class: "actions" });
  actions.appendChild(closeWidget(item.id, renderDash));
  actions.appendChild(snoozeWidget(item.id, renderDash));
  row.appendChild(actions);
  return row;
}

function closeWidget(itemId, onDone) {
  const wrap = el("span", { class: "close-widget" });
  const btn = el("button", { class: "btn-small", text: "close" });
  wrap.appendChild(btn);
  btn.addEventListener("click", () => {
    wrap.innerHTML = "";
    const input = el("input", { type: "text", placeholder: "comment (optional)", class: "comment-input" });
    const ok = el("button", { class: "btn-small", text: "✓" });
    const cancel = el("button", { class: "btn-small", text: "×" });
    wrap.appendChild(input); wrap.appendChild(ok); wrap.appendChild(cancel);
    input.focus();
    const commit = async () => {
      const comment = input.value.trim() || undefined;
      ok.disabled = true; cancel.disabled = true;
      const success = await queueAndFlush([TB.events.close(itemId, comment)], { render: false });
      if (!success) showGlobalBanner("backend unreachable — change is queued; Save retries");
      onDone();
    };
    ok.addEventListener("click", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      if (ev.key === "Escape") onDone();
    });
    cancel.addEventListener("click", () => onDone());
  });
  return wrap;
}

function snoozeWidget(itemId, onDone) {
  const wrap = el("span", { class: "snooze-widget" });
  async function commit(due) {
    const success = await queueAndFlush([TB.events.nudge(itemId, due)], { render: false });
    if (!success) showGlobalBanner("backend unreachable — snooze is queued; Save retries");
    onDone();
  }
  const mkQuick = (label, days) => {
    const b = el("button", { class: "btn-small", text: label });
    b.addEventListener("click", () => commit(TB.addDays(TB.todayISO(), days)));
    return b;
  };
  wrap.appendChild(mkQuick("+3d", 3));
  wrap.appendChild(mkQuick("+1w", 7));
  const dateBtn = el("button", { class: "btn-small", text: "date…" });
  dateBtn.addEventListener("click", () => {
    wrap.innerHTML = "";
    const input = el("input", { type: "date" });
    input.value = TB.todayISO();
    const ok = el("button", { class: "btn-small", text: "✓" });
    const cancel = el("button", { class: "btn-small", text: "×" });
    wrap.appendChild(input); wrap.appendChild(ok); wrap.appendChild(cancel);
    ok.addEventListener("click", () => commit(input.value));
    cancel.addEventListener("click", () => onDone());
  });
  wrap.appendChild(dateBtn);
  return wrap;
}

// ================================================================
// Scratchpad
// ================================================================

function currentThreadKey() {
  if (PadState.newThread) return "new:" + PadState.newThread.title;
  return PadState.selectedThreadId;
}

function applyPendingDraftRestore() {
  if (!PadState.pendingRestore) return;
  const d = PadState.pendingRestore;
  PadState.pendingRestore = null;
  PadState.textareaValue = d.body || "";
  if (typeof d.thread === "string" && d.thread.indexOf("new:") === 0) {
    PadState.newThread = { title: d.thread.slice(4), kind: "ad-hoc" };
    PadState.selectedThreadId = null;
  } else if (d.thread && App.folded.threads[d.thread]) {
    PadState.selectedThreadId = d.thread;
    PadState.newThread = null;
  }
  const t = d.savedAt ? new Date(d.savedAt) : null;
  const hhmm = t ? String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") : "";
  PadState.draftNotice = "restored draft from " + hhmm;
}

// Note history for the selected thread: sorted by event ts descending (not
// append order — a backdated note must sort into place by its own ts).
// Array#sort is stable, so notes sharing a ts keep their relative log order,
// which is a deterministic tiebreak without needing a secondary key.
// Renders from App.folded only — no network call, so pagination is instant
// and works offline / with queued-but-unsynced notes included.
function renderNoteHistory() {
  const wrap = el("div", { class: "note-history" });
  wrap.appendChild(el("h3", { text: "Notes" }));

  const notes = PadState.selectedThreadId
    ? App.folded.notes.filter((n) => n.thread === PadState.selectedThreadId)
    : [];
  const sorted = notes.slice().sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const total = sorted.length;
  const visible = sorted.slice(0, Math.min(PadState.visibleCount, total));

  if (!total) {
    wrap.appendChild(el("p", { class: "muted", text: "no notes yet" }));
  } else {
    for (const n of visible) {
      const block = el("div", { class: "last-note" });
      block.appendChild(el("div", { class: "last-note-heading", text: dateOf(n.ts) }));
      block.appendChild(el("pre", { class: "note-body", text: n.body_clean || n.body || "" }));
      wrap.appendChild(block);
    }
  }

  const remaining = total - visible.length;
  const btnRow = el("div", { class: "note-history-actions" });
  const showMoreBtn = el("button", { class: "btn-small", text: "Show more" });
  const showAllBtn = el("button", { class: "btn-small", text: "Show all" });
  showMoreBtn.disabled = remaining <= 0;
  showAllBtn.disabled = remaining <= 0;
  showMoreBtn.addEventListener("click", () => { PadState.visibleCount += 5; renderPad(); });
  showAllBtn.addEventListener("click", () => { PadState.visibleCount = Infinity; renderPad(); });
  btnRow.appendChild(showMoreBtn);
  btnRow.appendChild(showAllBtn);
  wrap.appendChild(btnRow);

  return wrap;
}

function renderPad() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  applyPendingDraftRestore();

  const threads = Object.values(App.folded.threads).sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
  if (PadState.selectedThreadId === null && !PadState.newThread) {
    if (threads.length) PadState.selectedThreadId = threads[0].id;
    else PadState.newThread = { title: "", kind: "ad-hoc" };
  }
  if (PadState.selectedThreadId && !App.folded.threads[PadState.selectedThreadId]) {
    // thread vanished from state (shouldn't normally happen); fall back
    PadState.selectedThreadId = threads.length ? threads[0].id : null;
    if (!PadState.selectedThreadId) PadState.newThread = { title: "", kind: "ad-hoc" };
    PadState.visibleCount = 5;
  }

  const layout = el("div", { class: "pad-layout" });
  const main = el("div", { class: "pad-main" });
  const header = el("div", { class: "pad-header" });

  const select = el("select", { id: "thread-select" });
  for (const t of threads) {
    const opt = el("option", { value: t.id, text: t.title || t.id });
    if (!PadState.newThread && t.id === PadState.selectedThreadId) opt.selected = true;
    select.appendChild(opt);
  }
  const newOpt = el("option", { value: "__new__", text: "+ New thread…" });
  if (PadState.newThread) newOpt.selected = true;
  select.appendChild(newOpt);
  header.appendChild(select);

  const newThreadInputs = el("span", { class: PadState.newThread ? "new-thread-inputs" : "new-thread-inputs hidden" });
  const titleInput = el("input", { type: "text", placeholder: "thread title" });
  titleInput.value = PadState.newThread ? PadState.newThread.title : "";
  const kindSelect = el("select");
  for (const k of ["ad-hoc", "1:1", "project"]) {
    const o = el("option", { value: k, text: k });
    if (PadState.newThread && PadState.newThread.kind === k) o.selected = true;
    kindSelect.appendChild(o);
  }
  newThreadInputs.appendChild(titleInput);
  newThreadInputs.appendChild(kindSelect);
  header.appendChild(newThreadInputs);

  select.addEventListener("change", () => {
    if (select.value === "__new__") {
      PadState.newThread = { title: "", kind: "ad-hoc" };
      PadState.selectedThreadId = null;
    } else {
      PadState.newThread = null;
      PadState.selectedThreadId = select.value;
    }
    PadState.sidebarTicks.clear();
    PadState.visibleCount = 5;
    renderPad();
  });
  titleInput.addEventListener("input", () => { if (PadState.newThread) PadState.newThread.title = titleInput.value; });
  kindSelect.addEventListener("change", () => { if (PadState.newThread) PadState.newThread.kind = kindSelect.value; });

  main.appendChild(header);

  if (PadState.draftNotice) {
    main.appendChild(el("div", { class: "notice", text: PadState.draftNotice }));
  }

  const textarea = el("textarea", {
    id: "pad-textarea", spellcheck: "false",
    placeholder: "@mentions, > commitments, ? questions, >> to close, ! to set nudge date",
  });
  textarea.value = PadState.textareaValue;
  main.appendChild(textarea);

  let draftTimer = null;
  textarea.addEventListener("input", () => {
    const val = textarea.value;
    PadState.textareaValue = val;
    PadState.draftNotice = null;
    if (PadState.queuedLock !== null) {
      if (val === PadState.queuedLock) return; // unchanged: still the queued, immutable note
      PadState.queuedLock = null; // user diverged: this is a brand-new draft now
    }
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      saveDraft({ thread: currentThreadKey(), body: val, savedAt: new Date().toISOString() });
    }, 200);
  });
  textarea.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      attemptSave();
    }
  });

  const actionsRow = el("div", { class: "pad-actions" });
  const saveBtn = el("button", { id: "save-btn", class: "btn-primary", text: "Save" });
  saveBtn.addEventListener("click", attemptSave);
  actionsRow.appendChild(saveBtn);
  actionsRow.appendChild(el("span", { class: "hint", text: " ⌘/Ctrl+Enter" }));
  actionsRow.appendChild(el("span", { id: "pad-status", class: "notice" }));
  main.appendChild(actionsRow);

  main.appendChild(renderNoteHistory());

  layout.appendChild(main);

  const aside = el("aside", { class: "pad-sidebar" });
  aside.appendChild(el("h3", { text: "Open loops" }));
  if (PadState.selectedThreadId) {
    const ids = threadPeopleIds(PadState.selectedThreadId);
    const items = App.folded.openItems().filter((i) => ids.includes(App.folded.itemPerson(i)));
    if (!items.length) aside.appendChild(el("p", { class: "muted", text: "none" }));
    for (const item of items) {
      const label = el("label", { class: "sidebar-row" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = PadState.sidebarTicks.has(item.id);
      cb.addEventListener("change", () => {
        if (cb.checked) PadState.sidebarTicks.add(item.id); else PadState.sidebarTicks.delete(item.id);
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.text + " "));
      label.appendChild(el("span", { class: "item-dates", text: loopDatesLabel(App.folded, item) }));
      aside.appendChild(label);
    }
  } else {
    aside.appendChild(el("p", { class: "muted", text: "select a thread" }));
  }
  layout.appendChild(aside);

  view.appendChild(layout);
  textarea.focus();
}

async function attemptSave() {
  hideGlobalBanner();
  const ta = document.getElementById("pad-textarea");
  const body = ta ? ta.value : "";
  if (PadState.queuedLock !== null && body === PadState.queuedLock) {
    await finalizeSave([], body);
    return;
  }
  if (!body.trim()) {
    if (loadQueue().length > 0) await finalizeSave([], null);
    return;
  }
  if (PadState.newThread && !PadState.newThread.title.trim()) {
    showPadStatus("enter a thread title first");
    return;
  }
  openConfirmPanel(body);
}

async function finalizeSave(newEvents, lockBody) {
  hideGlobalBanner();
  if (lockBody !== null) {
    // A real save (not just a queue-flush retry): the new note already landed
    // in App.folded (queued or not), so start the history view fresh at the top.
    PadState.queuedLock = lockBody; clearDraft(); PadState.sidebarTicks.clear(); PadState.visibleCount = 5;
  }
  const ok = await queueAndFlush(newEvents, { render: false });
  if (ok && lockBody !== null) {
    PadState.queuedLock = null;
    const ta = document.getElementById("pad-textarea");
    if (ta && ta.value === lockBody) {
      ta.value = "";
      PadState.textareaValue = "";
    }
  }
  if (!ok) {
    showGlobalBanner("backend unreachable — note is queued; Save retries");
  }
  renderPad();
  // after the rebuild — renderPad recreates #pad-status, wiping anything
  // written into the old DOM
  if (ok) showPadStatus("saved");
}

// ================================================================
// Save / confirmation step
// ================================================================

function openConfirmPanel(body) {
  const s = App.folded;
  const parsed = TB.parse(body);

  const isNewThread = !!PadState.newThread;
  const tid = isNewThread ? TB.threadId(PadState.newThread.title) : PadState.selectedThreadId;
  const existingThread = !isNewThread ? s.threads[tid] : null;
  const threadPeople = existingThread ? threadPeopleIds(tid) : [];

  // ---- when (editable timestamp; item due dates resolve against its date) ----
  const tsSection = el("div", { class: "confirm-section confirm-ts-row" });
  const tsLabel = el("label", { class: "confirm-ts-label", for: "confirm-ts-input", text: "when" });
  const tsInput = el("input", {
    type: "text", id: "confirm-ts-input", class: "confirm-ts-input", autocomplete: "off",
  });
  tsInput.value = TB.nowLocalISO();
  const tsError = el("span", { class: "confirm-ts-error" });
  tsSection.appendChild(tsLabel);
  tsSection.appendChild(tsInput);
  tsSection.appendChild(tsError);

  // ---- people ----
  const personRows = []; // {name, get(): pid|null, create(): record|null}
  const peopleSection = el("div", { class: "confirm-section" });
  peopleSection.appendChild(el("h3", { text: "People" }));
  if (!parsed.mentions.length) peopleSection.appendChild(el("p", { class: "muted", text: "no @mentions" }));
  for (const name of parsed.mentions) {
    const matches = TB.resolvePerson(s, name);
    const row = el("div", { class: "confirm-row" });
    if (matches.length === 1) {
      row.appendChild(el("span", { text: "@" + name + " → " + (matches[0].name || matches[0].id) }));
      personRows.push({ name: name, get: () => matches[0].id, create: () => null });
    } else if (matches.length === 0) {
      const pid = TB.personId(name);
      const cb = el("input", { type: "checkbox" });
      cb.checked = true;
      const label = el("label", { class: "confirm-inline" });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" create person '" + name + "' (" + pid + ")"));
      row.appendChild(label);
      personRows.push({ name: name, get: () => (cb.checked ? pid : null), create: () => (cb.checked ? { id: pid, name: name } : null) });
    } else {
      row.appendChild(el("span", { text: "@" + name + " is ambiguous — " }));
      const sel = el("select");
      for (const m of matches) sel.appendChild(el("option", { value: m.id, text: m.name || m.id }));
      sel.appendChild(el("option", { value: "__new__", text: "someone new (create)" }));
      row.appendChild(sel);
      personRows.push({
        name: name,
        get: () => (sel.value === "__new__" ? TB.personId(name) : sel.value),
        create: () => (sel.value === "__new__" ? { id: TB.personId(name), name: name } : null),
      });
    }
    peopleSection.appendChild(row);
  }

  // ---- items ----
  const itemRows = []; // {parsed, checkbox, dueSpan}
  const itemsSection = el("div", { class: "confirm-section" });
  itemsSection.appendChild(el("h3", { text: "Items" }));
  if (!parsed.items.length) itemsSection.appendChild(el("p", { class: "muted", text: "no > or ? lines" }));
  for (const pi of parsed.items) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = true;
    const mark = pi.kind === "commit" ? "›" : "?";
    const row = el("label", { class: "confirm-row" });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(" " + mark + " " + pi.text + " — "));
    const dueSpan = el("span", { class: "item-due-label" });
    row.appendChild(dueSpan);
    itemsSection.appendChild(row);
    itemRows.push({ parsed: pi, checkbox: cb, dueSpan: dueSpan });
  }

  // Re-derives every item's previewed nudge date from the "when" field's
  // date — resolveDue's base is the note's date, not wall-clock today.
  function refreshItemDueLabels(localDateISO) {
    for (const row of itemRows) {
      const due = TB.resolveDue(row.parsed.due_spec, localDateISO, TB.DEFAULT_NUDGE_DAYS);
      row.dueSpan.textContent = due ? "nudge " + due : "never";
    }
  }
  refreshItemDueLabels(TB.parseTimestamp(tsInput.value).localDate);
  tsInput.addEventListener("input", () => {
    tsError.textContent = "";
    const result = TB.parseTimestamp(tsInput.value);
    if (result.ok) refreshItemDueLabels(result.localDate);
  });

  // ---- >> closes (fuzzy-matched against open items for this note's people) ----
  const defaultMentionMap = {};
  for (const row of personRows) {
    const pid = row.get();
    if (pid) defaultMentionMap[row.name.toLowerCase()] = pid;
  }
  const defaultPeopleForMatch = dedupe(Object.values(defaultMentionMap).concat(threadPeople));
  let candidates = s.openItems().filter((i) =>
    i.people.some((p) => defaultPeopleForMatch.indexOf(p) !== -1) || defaultPeopleForMatch.indexOf(s.itemPerson(i)) !== -1
  );
  if (!candidates.length) candidates = s.openItems();
  const matchResults = TB.matchCloses(parsed.closes, candidates);

  const closeRows = []; // {itemId, checkbox}
  const closesSection = el("div", { class: "confirm-section" });
  closesSection.appendChild(el("h3", { text: ">> closes" }));
  if (!matchResults.length) closesSection.appendChild(el("p", { class: "muted", text: "no >> lines" }));
  for (const r of matchResults) {
    const row = el("div", { class: "confirm-row" });
    if (!r.item) {
      row.appendChild(el("span", { class: "muted", text: "no open item matches '>> " + r.text + "'; left as text" }));
    } else {
      const cb = el("input", { type: "checkbox" });
      cb.checked = r.score >= TB.YES_CLOSE_THRESHOLD;
      const label = el("label", { class: "confirm-inline" });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(
        " close '" + r.item.text + "' (matched '" + r.text + "', " + Math.round(r.score * 100) + "%)"
      ));
      row.appendChild(label);
      closeRows.push({ itemId: r.item.id, checkbox: cb });
    }
    closesSection.appendChild(row);
  }

  // ---- sidebar-ticked closes ----
  const sidebarSection = el("div", { class: "confirm-section" });
  const sidebarTicked = Array.from(PadState.sidebarTicks);
  if (sidebarTicked.length) {
    sidebarSection.appendChild(el("h3", { text: "Also closing (ticked in sidebar)" }));
    for (const itemId of sidebarTicked) {
      const item = s.items[itemId];
      if (!item) continue;
      const row = el("label", { class: "confirm-row" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = true;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(" " + item.text));
      sidebarSection.appendChild(row);
      closeRows.push({ itemId: itemId, checkbox: cb });
    }
  }

  // ---- panel chrome ----
  const panel = el("div", { class: "confirm-panel", role: "dialog" });
  panel.appendChild(el("h2", { text: isNewThread ? "New thread: " + PadState.newThread.title : (existingThread ? existingThread.title : tid) }));
  panel.appendChild(tsSection);
  panel.appendChild(peopleSection);
  panel.appendChild(itemsSection);
  panel.appendChild(closesSection);
  if (sidebarTicked.length) panel.appendChild(sidebarSection);
  const actions = el("div", { class: "confirm-actions" });
  const confirmBtn = el("button", { class: "btn-primary", text: "Confirm (Enter)" });
  const cancelBtn = el("button", { class: "btn-small", text: "Cancel (Esc)" });
  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);
  panel.appendChild(actions);

  const overlay = el("div", { class: "overlay" }, [panel]);
  document.body.appendChild(overlay);
  confirmBtn.focus();

  function cleanup() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); }
    else if (ev.key === "Enter" && ev.target.tagName !== "SELECT") { ev.preventDefault(); doConfirm(); }
  }
  document.addEventListener("keydown", onKey, true);
  cancelBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) cleanup(); });
  confirmBtn.addEventListener("click", doConfirm);

  async function doConfirm() {
    const parsedTs = TB.parseTimestamp(tsInput.value);
    if (!parsedTs.ok) {
      tsError.textContent = parsedTs.error;
      tsInput.focus();
      tsInput.select();
      return; // invalid: leave the panel open, emit nothing
    }
    cleanup();

    const mentionMap = {};
    const creations = [];
    for (const row of personRows) {
      const pid = row.get();
      if (pid) mentionMap[row.name.toLowerCase()] = pid;
      const rec = row.create();
      if (rec) creations.push(rec);
    }
    const peopleList = dedupe(Object.values(mentionMap).concat(threadPeople));

    const itemsPayload = [];
    for (const row of itemRows) {
      if (!row.checkbox.checked) continue;
      const pi = row.parsed;
      let owner = null;
      if (pi.mention && mentionMap[pi.mention.toLowerCase()]) owner = mentionMap[pi.mention.toLowerCase()];
      else if (pi.kind === "commit") owner = "me";
      const due = TB.resolveDue(pi.due_spec, parsedTs.localDate, TB.DEFAULT_NUDGE_DAYS);
      itemsPayload.push({ id: TB.newItemId(), kind: pi.kind, text: pi.text, owner: owner, due: due });
    }

    const closeIds = [];
    const seenClose = new Set();
    for (const row of closeRows) {
      if (row.checkbox.checked && !seenClose.has(row.itemId)) { seenClose.add(row.itemId); closeIds.push(row.itemId); }
    }

    const pending = [];
    if (isNewThread) {
      pending.push(TB.events.thread(
        { id: tid, title: PadState.newThread.title, kind: PadState.newThread.kind, people: [] },
        parsedTs.ts
      ));
    }
    for (const rec of creations) pending.push(TB.events.person(rec, parsedTs.ts));
    pending.push(TB.events.note(tid, peopleList, body, itemsPayload, null, parsedTs.ts));
    for (const itemId of closeIds) pending.push(TB.events.close(itemId, undefined, parsedTs.ts));

    if (isNewThread) { PadState.newThread = null; PadState.selectedThreadId = tid; }

    await finalizeSave(pending, body);
  }
}

// ================================================================
// Thread view — mirrors render.py::render_thread
// ================================================================

function renderThreadView(tid) {
  const view = document.getElementById("view");
  view.innerHTML = "";
  const s = App.folded;
  const thread = s.threads[tid];
  const title = (thread && thread.title) || tid;
  view.appendChild(el("h1", { text: title }));

  const entries = [];
  for (const e of s.events) {
    if (e.type === "note" && e.thread === tid) {
      entries.push({ ts: e.ts, kind: "note", node: noteBlock(s, e, thread) });
    } else if (e.type === "close" || e.type === "revise" || e.type === "reopen" || e.type === "nudge") {
      const node = houseLine(s, e, tid);
      if (node) entries.push({ ts: e.ts, kind: "house", node: node });
    }
  }
  if (!entries.length) {
    view.appendChild(el("p", { class: "muted", text: "(no events)" }));
    return;
  }
  // Chronological, not log order — a backdated note must slot into its place
  // in the arc. Array#sort is stable, so equal-ts entries keep log order.
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let prevKind = null;
  for (const entry of entries) {
    if (prevKind !== null && entry.kind !== prevKind) view.appendChild(el("hr"));
    view.appendChild(entry.node);
    prevKind = entry.kind;
  }
}

function noteBlock(s, e, thread) {
  let names = (e.people || []).map((p) => personName(s, p)).join(", ");
  if (!names) names = (thread && thread.title) || e.thread || "";
  const kind = thread ? thread.kind : "note";
  const body = (e.body_clean || e.body || "").replace(/\s+$/, "");
  const wrap = el("section", { class: "note-block" });
  wrap.appendChild(el("h2", { text: dateOf(e.ts) + " — " + kind + ", " + names }));
  wrap.appendChild(el("pre", { class: "note-body", text: body }));
  return wrap;
}

function houseLine(s, e, tid) {
  const t = e.type;
  if (t === "revise") {
    const old = s.items[e.supersedes || ""];
    if (!old || old.thread !== tid) return null;
    const fresh = s.items[old.superseded_by || ""];
    const newText = fresh ? fresh.text : "?";
    return el("p", { class: "house", text: dateOf(e.ts) + " — revised: " + old.text + " → " + newText });
  }
  const targetField = { close: "closes", reopen: "reopens", nudge: "item" }[t];
  const item = s.items[e[targetField] || ""];
  if (!item || item.thread !== tid) return null;
  const d = dateOf(e.ts);
  if (t === "close") {
    const comment = e.comment ? " — " + e.comment : "";
    return el("p", { class: "house", text: d + " — closed: " + item.text + comment });
  }
  if (t === "reopen") {
    return el("p", { class: "house", text: d + " — reopened: " + item.text });
  }
  if (e.due) {
    return el("p", { class: "house", text: d + " — snoozed to " + e.due + ": " + item.text });
  }
  return el("p", { class: "house", text: d + " — nudge off: " + item.text });
}

// ================================================================
// Item view — mirrors render.py::render_item
// ================================================================

function renderItemView(itemId) {
  const view = document.getElementById("view");
  view.innerHTML = "";
  const s = App.folded;
  const item = s.items[itemId];
  if (!item) {
    view.appendChild(el("p", { text: "no such item: " + itemId }));
    return;
  }
  const chain = s.chain(item);
  const head = chain[chain.length - 1];
  view.appendChild(el("h1", { text: head.text }));
  const list = el("ul", { class: "history" });
  for (const node of chain) {
    for (const h of node.history) list.appendChild(el("li", { text: historyLine(s, node, h) }));
  }
  view.appendChild(list);
  const due = s.effectiveDue(head);
  let statusText;
  if (head.status === "open") {
    statusText = "Status: open" + (due ? ", nudge due " + due : ", no nudge");
  } else {
    const when = head.closed_ts ? " (" + dateOf(head.closed_ts) + ")" : "";
    statusText = "Status: closed" + when;
  }
  view.appendChild(el("p", { class: "status", text: statusText }));
}

function historyLine(s, node, h) {
  const d = dateOf(h.ts);
  const action = h.action;
  if (action === "opened") {
    const thread = s.threads[node.thread || ""];
    const where = thread ? " in " + (thread.title || thread.id) : "";
    return d + " — opened (" + node.kind + ")" + where + ": " + node.text + " [" + node.id + "]";
  }
  if (action === "revised") {
    const fresh = s.items[h.to || ""];
    return d + " — revised → " + (fresh ? fresh.text : "?");
  }
  if (action === "closed") {
    const comment = h.comment ? " — " + h.comment : "";
    return d + " — closed" + comment;
  }
  if (action === "reopened") return d + " — reopened";
  if (h.due) return d + " — snoozed to " + h.due;
  return d + " — nudge switched off";
}

// ================================================================
// People view (index + person page)
// ================================================================

// Filter lives in module state (not the DOM) so it survives re-renders
// triggered from elsewhere (e.g. window focus). On every keystroke we only
// rebuild the list container below the input — never the input itself —
// so the element never loses focus or caret position.
function renderPeople() {
  const view = document.getElementById("view");
  view.innerHTML = "";
  view.appendChild(el("h1", { text: "People" }));

  const filterRow = el("div", { class: "people-filter-row" });
  const filterInput = el("input", {
    type: "text", id: "people-filter", class: "people-filter",
    placeholder: "filter by name or alias", autocomplete: "off",
  });
  filterInput.value = PeopleState.filter;
  filterRow.appendChild(filterInput);

  const newBtn = el("button", { class: "btn-small people-new-btn", text: "New person" });
  newBtn.addEventListener("click", () => {
    if (PeopleState.creating) {
      // already open: a re-render would rebuild the form blank and wipe
      // anything half-typed into it — just put focus back on it instead
      const nameInput = view.querySelector(".person-create-form .person-edit-input");
      if (nameInput) nameInput.focus();
      return;
    }
    PeopleState.creating = true;
    renderPeople();
  });
  filterRow.appendChild(newBtn);
  view.appendChild(filterRow);

  if (PeopleState.creating) view.appendChild(personCreateForm());

  const listWrap = el("div", { id: "people-list-wrap" });
  view.appendChild(listWrap);
  renderPeopleList(listWrap);

  filterInput.addEventListener("input", () => {
    PeopleState.filter = filterInput.value;
    renderPeopleList(listWrap);
  });

  if (PeopleState.creating) {
    // The create form is appended above; focus its name input now that it's
    // actually attached to #view (focusing before attach is a no-op).
    const nameInput = view.querySelector(".person-create-form .person-edit-input");
    if (nameInput) nameInput.focus();
  } else {
    filterInput.focus();
  }
}

function renderPeopleList(container) {
  container.innerHTML = "";
  const s = App.folded;
  const allPeople = Object.values(s.people);
  if (!allPeople.length) {
    container.appendChild(el("p", { class: "muted", text: "no people yet" }));
    return;
  }

  const needle = PeopleState.filter.trim().toLowerCase();
  const filtered = !needle ? allPeople : allPeople.filter((p) => {
    const name = (p.name || "").toLowerCase();
    if (name.indexOf(needle) !== -1) return true;
    return (p.aliases || []).some((a) => (a || "").toLowerCase().indexOf(needle) !== -1);
  });
  if (!filtered.length) {
    container.appendChild(el("p", { class: "muted", text: "no matches" }));
    return;
  }

  const sorted = filtered.slice().sort((a, b) => {
    const na = (a.name || a.id || "").toLowerCase();
    const nb = (b.name || b.id || "").toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const list = el("ul", { class: "plain-list people-list" });
  for (const p of sorted) list.appendChild(personIndexRow(p));
  container.appendChild(list);
}

function personIndexRow(p) {
  const li = el("li");
  li.appendChild(el("a", { href: "#/person/" + encodeURIComponent(p.id), text: p.name || p.id }));
  const bits = [];
  if (p.org) bits.push(p.org);
  if (p.tags && p.tags.length) bits.push(p.tags.join(", "));
  if (p.cadence_days !== null && p.cadence_days !== undefined) bits.push("cadence " + p.cadence_days + "d");
  if (p.last_contact) bits.push("last " + dateOf(p.last_contact));
  if (bits.length) {
    li.appendChild(document.createTextNode(" — "));
    li.appendChild(el("span", { class: "muted", text: bits.join(" · ") }));
  }
  return li;
}

function renderPersonView(pid) {
  const view = document.getElementById("view");
  view.innerHTML = "";
  const s = App.folded;
  const p = s.people[pid];
  if (!p) {
    view.appendChild(el("h1", { text: pid }));
    view.appendChild(el("p", { class: "muted", text: "person not found" }));
    return;
  }

  const card = el("div", { class: "person-card" });
  if (PersonPageState.editing === pid) {
    card.appendChild(personEditForm(p));
  } else {
    card.appendChild(el("h1", { text: p.name || p.id }));
    const metaLines = [];
    if (p.aliases && p.aliases.length) metaLines.push("aka " + p.aliases.join(", "));
    if (p.org) metaLines.push(p.org);
    if (p.tags && p.tags.length) metaLines.push("tags: " + p.tags.join(", "));
    if (p.met_context) metaLines.push("met: " + p.met_context);
    if (p.cadence_days !== null && p.cadence_days !== undefined) metaLines.push("cadence: " + p.cadence_days + "d");
    if (p.last_contact) metaLines.push("last contact: " + dateOf(p.last_contact));
    for (const line of metaLines) card.appendChild(el("p", { class: "muted person-meta-line", text: line }));
    const editBtn = el("button", { class: "btn-small person-edit-btn", text: "Edit" });
    editBtn.addEventListener("click", () => {
      PersonPageState.editing = pid;
      renderPersonView(pid);
    });
    card.appendChild(editBtn);
  }
  view.appendChild(card);

  view.appendChild(el("h2", { text: "Open loops" }));
  const items = s.openItems().filter((i) => s.itemPerson(i) === pid);
  if (!items.length) view.appendChild(el("p", { class: "muted", text: "no open items" }));
  else {
    const list = el("div", { class: "row-list" });
    for (const item of items) list.appendChild(personOpenLoopRow(s, item));
    view.appendChild(list);
  }

  view.appendChild(el("h2", { text: "Notes" }));
  // Newest first: this is a lookup surface ("what have I told/heard from
  // this person"), not the chronological thread arc — the opposite sort
  // from renderThreadView.
  const notes = s.notes
    .filter((n) => (n.people || []).includes(pid))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  if (!notes.length) view.appendChild(el("p", { class: "muted", text: "no notes yet" }));
  else for (const n of notes) view.appendChild(personNoteBlock(s, n));
}

// Shared by personEditForm and personCreateForm below.
function fieldRow(labelText, input) {
  const row = el("div", { class: "person-edit-row" });
  row.appendChild(el("label", { class: "person-edit-label", text: labelText }));
  row.appendChild(input);
  return row;
}

// Inline edit form for the person card. Prefilled from the fold's current
// record; Save builds a `person` event carrying only the fields that
// actually changed (the fold merges field-wise — see core.js PERSON_FIELDS),
// so an untouched field must never appear in the emitted record.
function personEditForm(p) {
  const form = el("div", { class: "person-edit-form" });

  const nameInput = el("input", { type: "text", class: "person-edit-input" });
  nameInput.value = p.name || "";
  const orgInput = el("input", { type: "text", class: "person-edit-input" });
  orgInput.value = p.org || "";
  const aliasesInput = el("input", { type: "text", class: "person-edit-input" });
  aliasesInput.value = (p.aliases || []).join(", ");
  const tagsInput = el("input", { type: "text", class: "person-edit-input" });
  tagsInput.value = (p.tags || []).join(", ");
  const linksInput = el("input", { type: "text", class: "person-edit-input" });
  linksInput.value = (p.links || []).join(", ");
  const metInput = el("input", { type: "text", class: "person-edit-input" });
  metInput.value = p.met_context || "";
  const cadenceInput = el("input", {
    type: "text", class: "person-edit-input", inputmode: "numeric", placeholder: "days, blank = none",
  });
  cadenceInput.value = (p.cadence_days !== null && p.cadence_days !== undefined) ? String(p.cadence_days) : "";
  const cadenceError = el("span", { class: "person-edit-error" });

  form.appendChild(fieldRow("name", nameInput));
  form.appendChild(fieldRow("org", orgInput));
  form.appendChild(fieldRow("aliases", aliasesInput));
  form.appendChild(fieldRow("tags", tagsInput));
  form.appendChild(fieldRow("links", linksInput));
  form.appendChild(fieldRow("met", metInput));
  const cadenceRow = fieldRow("cadence (days)", cadenceInput);
  cadenceRow.appendChild(cadenceError);
  form.appendChild(cadenceRow);

  const actions = el("div", { class: "person-edit-actions" });
  const saveBtn = el("button", { class: "btn-primary", text: "Save" });
  const cancelBtn = el("button", { class: "btn-small", text: "Cancel" });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  function cancel() {
    PersonPageState.editing = null;
    renderPersonView(p.id);
  }

  async function save() {
    cadenceError.textContent = "";
    const record = { id: p.id };

    addTextFieldDiff(record, "name", nameInput.value, p.name);
    addTextFieldDiff(record, "org", orgInput.value, p.org);
    addTextFieldDiff(record, "met_context", metInput.value, p.met_context);
    addListFieldDiff(record, "aliases", aliasesInput.value, p.aliases);
    addListFieldDiff(record, "tags", tagsInput.value, p.tags);
    addListFieldDiff(record, "links", linksInput.value, p.links);

    const cadenceParsed = parseCadenceDays(cadenceInput.value);
    if (cadenceParsed.error) {
      cadenceError.textContent = cadenceParsed.error;
      cadenceInput.focus();
      cadenceInput.select();
      return; // invalid: leave the form open, save nothing
    }
    const currentCadence = (p.cadence_days === undefined) ? null : p.cadence_days;
    if (cadenceParsed.value !== currentCadence) record.cadence_days = cadenceParsed.value;

    if (Object.keys(record).length <= 1) {
      // nothing changed: close the form, do not append a no-op event
      cancel();
      return;
    }

    saveBtn.disabled = true; cancelBtn.disabled = true;
    const ok = await queueAndFlush([TB.events.person(record)], { render: false });
    if (!ok) showGlobalBanner("backend unreachable — person edit is queued; Save retries");
    PersonPageState.editing = null;
    renderPersonView(p.id);
  }

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);

  function onKeydown(ev) {
    if (ev.key === "Enter") { ev.preventDefault(); save(); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  }
  for (const input of [nameInput, orgInput, aliasesInput, tagsInput, linksInput, metInput, cadenceInput]) {
    input.addEventListener("keydown", onKeydown);
  }
  nameInput.focus();

  return form;
}

// Inline create form for a brand-new person, opened from the People index's
// "New person" button. Mirrors personEditForm's fields (name, org, aliases,
// tags, links, met, cadence) and the same comma-list / cadence parsing, but
// starts blank and requires a non-empty name — mirroring `app person add
// NAME [--org ...]`, where name is the only positional (required) field.
// Carries the person-edit-form class (like personEditForm) so the focus-poll
// guard in renderWouldClobberInput() protects it while it's on screen.
function personCreateForm() {
  const form = el("div", { class: "person-edit-form person-card person-create-form" });

  const nameInput = el("input", { type: "text", class: "person-edit-input" });
  const nameError = el("span", { class: "person-edit-error" });
  const orgInput = el("input", { type: "text", class: "person-edit-input" });
  const aliasesInput = el("input", { type: "text", class: "person-edit-input" });
  const tagsInput = el("input", { type: "text", class: "person-edit-input" });
  const linksInput = el("input", { type: "text", class: "person-edit-input" });
  const metInput = el("input", { type: "text", class: "person-edit-input" });
  const cadenceInput = el("input", {
    type: "text", class: "person-edit-input", inputmode: "numeric", placeholder: "days, blank = none",
  });
  const cadenceError = el("span", { class: "person-edit-error" });

  const nameRow = fieldRow("name", nameInput);
  nameRow.appendChild(nameError);
  form.appendChild(nameRow);
  form.appendChild(fieldRow("org", orgInput));
  form.appendChild(fieldRow("aliases", aliasesInput));
  form.appendChild(fieldRow("tags", tagsInput));
  form.appendChild(fieldRow("links", linksInput));
  form.appendChild(fieldRow("met", metInput));
  const cadenceRow = fieldRow("cadence (days)", cadenceInput);
  cadenceRow.appendChild(cadenceError);
  form.appendChild(cadenceRow);

  const actions = el("div", { class: "person-edit-actions" });
  const saveBtn = el("button", { class: "btn-primary", text: "Save" });
  const cancelBtn = el("button", { class: "btn-small", text: "Cancel" });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  function cancel() {
    PeopleState.creating = false;
    renderPeople();
  }

  async function save() {
    nameError.textContent = "";
    cadenceError.textContent = "";

    const name = nameInput.value.trim();
    if (!name) {
      nameError.textContent = "name is required";
      nameInput.focus();
      nameInput.select();
      return; // invalid: leave the form open, save nothing
    }

    // Duplicate check against the current local fold (App.folded.people
    // already reflects any queued-but-unsynced events) — mirrors the CLI's
    // `die(f"{pid} exists; ...")` in cmd_person_add.
    const pid = TB.personId(name);
    if (App.folded.people[pid]) {
      nameError.appendChild(el("a", { href: "#/person/" + encodeURIComponent(pid), text: pid }));
      nameError.appendChild(document.createTextNode(" exists — edit them instead"));
      nameInput.focus();
      nameInput.select();
      return; // duplicate: leave the form open, append nothing
    }

    const cadenceParsed = parseCadenceDays(cadenceInput.value);
    if (cadenceParsed.error) {
      cadenceError.textContent = cadenceParsed.error;
      cadenceInput.focus();
      cadenceInput.select();
      return; // invalid: leave the form open, save nothing
    }

    // Mirrors cli._person_record: id + name always present, every other
    // field included only when non-empty (no blank strings, no empty lists,
    // no null cadence).
    const record = { id: pid, name: name };
    const org = orgInput.value.trim();
    if (org) record.org = org;
    const aliases = parseCommaList(aliasesInput.value);
    if (aliases.length) record.aliases = aliases;
    const tags = parseCommaList(tagsInput.value);
    if (tags.length) record.tags = tags;
    const links = parseCommaList(linksInput.value);
    if (links.length) record.links = links;
    const met = metInput.value.trim();
    if (met) record.met_context = met;
    if (cadenceParsed.value !== null) record.cadence_days = cadenceParsed.value;

    saveBtn.disabled = true; cancelBtn.disabled = true;
    const ok = await queueAndFlush([TB.events.person(record)], { render: false });
    if (!ok) showGlobalBanner("backend unreachable — new person is queued; Save retries");
    PeopleState.creating = false;
    location.hash = "#/person/" + encodeURIComponent(pid);
  }

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);

  function onKeydown(ev) {
    if (ev.key === "Enter") { ev.preventDefault(); save(); }
    else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  }
  for (const input of [nameInput, orgInput, aliasesInput, tagsInput, linksInput, metInput, cadenceInput]) {
    input.addEventListener("keydown", onKeydown);
  }

  return form;
}

// Trimmed-text diff: unchanged (after trimming) -> untouched; changed-to-blank
// -> null (clears the field on merge); else the trimmed value.
function addTextFieldDiff(record, field, rawValue, currentValue) {
  const trimmed = rawValue.trim();
  const current = (currentValue === undefined || currentValue === null) ? "" : currentValue;
  if (trimmed === current) return;
  record[field] = trimmed === "" ? null : trimmed;
}

// Comma-split list parse: entries trimmed, empties dropped. Shared by the
// create form (build-if-non-empty) and addListFieldDiff below (diff against
// the current array).
function parseCommaList(rawValue) {
  return rawValue.split(",").map((v) => v.trim()).filter(Boolean);
}

// Comma-split list diff: compared order-sensitively against the current
// array; changed-to-blank -> [].
function addListFieldDiff(record, field, rawValue, currentValue) {
  const list = parseCommaList(rawValue);
  const current = currentValue || [];
  const same = list.length === current.length && list.every((v, i) => v === current[i]);
  if (same) return;
  record[field] = list;
}

// Cadence input parse: blank -> {value: null}; positive integer -> {value};
// anything else -> {error}. Shared by personEditForm (diffed against the
// current value) and personCreateForm (included only when non-null).
function parseCadenceDays(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === "") return { value: null };
  if (!/^\d+$/.test(trimmed) || parseInt(trimmed, 10) <= 0) {
    return { error: "cadence must be a positive whole number of days" };
  }
  return { value: parseInt(trimmed, 10) };
}

function personOpenLoopRow(s, item) {
  const row = el("div", { class: "loop-row" });
  const mark = item.kind === "commit" ? "›" : "?";
  row.appendChild(el("span", { class: "mark", text: mark }));
  row.appendChild(el("a", { href: "#/item/" + encodeURIComponent(item.id), class: "item-text", text: item.text }));
  row.appendChild(el("span", { class: "muted", text: " " + loopDatesLabel(s, item) }));
  return row;
}

function personNoteBlock(s, n) {
  const thread = s.threads[n.thread || ""];
  const tname = thread ? (thread.title || thread.id) : (n.thread || "?");
  const block = el("div", { class: "last-note" });
  const heading = el("div", { class: "last-note-heading" });
  heading.appendChild(document.createTextNode(dateOf(n.ts) + " — "));
  heading.appendChild(el("a", { href: "#/thread/" + encodeURIComponent(n.thread || ""), text: tname }));
  block.appendChild(heading);
  const body = (n.body_clean || n.body || "").replace(/\s+$/, "");
  block.appendChild(el("pre", { class: "note-body", text: body }));
  return block;
}

// ================================================================
// Boot
// ================================================================

async function boot() {
  PadState.pendingRestore = loadDraft();
  updateDot();
  await refreshEvents({ render: false });
  renderRoute();
  window.addEventListener("hashchange", renderRoute);
  // Focus poll: always refresh server state and the dot, but skip the
  // re-render when it would clobber in-progress input (SPEC.md, "Resilience
  // → Backend-state indicator").
  window.addEventListener("focus", () => refreshEvents({ render: !renderWouldClobberInput() }));
}

boot();
