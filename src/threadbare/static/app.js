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
    for (const item of groups.get(pid)) list.appendChild(openLoopRow(item));
    wrap.appendChild(list);
  }
  return wrap;
}

function openLoopRow(item) {
  const row = el("div", { class: "loop-row" });
  const mark = item.kind === "commit" ? "›" : "?";
  row.appendChild(el("span", { class: "mark", text: mark }));
  row.appendChild(el("span", { class: "item-text", text: item.text + " (opened " + dateOf(item.opened_ts) + ")" }));
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
      label.appendChild(document.createTextNode(" " + item.text));
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
// Boot
// ================================================================

async function boot() {
  PadState.pendingRestore = loadDraft();
  updateDot();
  await refreshEvents({ render: false });
  renderRoute();
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("focus", () => refreshEvents());
}

boot();
