// Agenda: striscia della settimana (frecce, "Oggi", swipe) con gli eventi del giorno,
// e Compiti con consegna raggruppati per scadenza (spunta "fatto" ottimistica).
import { get, post, load, invalidate, openFile } from "aulera/api";
import { store } from "aulera/state";
import {
  html, raw, icon, setHTML, $, $$, toast, segmented, bindSegmented, openSheet, emptyState, errorState,
  fmtDate, fmtTime, relativeDay, parseDate, ymd, addDays, startOfWeek, sameDay, DAY_SHORT, subjectName, personName,
} from "aulera/ui";
import { pageHeader } from "aulera/main";

/* ---------------- date ---------------- */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const monthLong = (d) => cap(d.toLocaleDateString("it-IT", { month: "long" }));
const today0 = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const dayDiff = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today0()) / 86400000);

function weekTitle(ws) {
  const we = addDays(ws, 6);
  if (ws.getMonth() === we.getMonth()) return `${monthLong(ws)} ${ws.getFullYear()}`;
  return `${monthLong(ws).slice(0, 3)} – ${monthLong(we).slice(0, 3)} ${we.getFullYear()}`;
}
function weekRelative(ws) {
  const diff = Math.round((ws - startOfWeek(new Date())) / (7 * 86400000));
  if (diff === 0) return "Questa settimana";
  if (diff === 1) return "Settimana prossima";
  if (diff === -1) return "Settimana scorsa";
  return diff > 0 ? `Tra ${diff} settimane` : `${-diff} settimane fa`;
}

/* ---------------- striscia settimana (condivisa con lezioni.js per copia) ---------------- */
function weekStrip(ws, selected, dotsFor, dir = "") {
  const now = new Date();
  const isThisWeek = sameDay(ws, startOfWeek(now));
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  return html`<div class="agenda-weekhead">
      <div class="agenda-weektitle"><p class="title-3">${weekTitle(ws)}</p><p class="caption">${weekRelative(ws)}</p></div>
      <div class="agenda-weeknav">
        <button type="button" class="btn agenda-todaybtn" data-week="today" ${isThisWeek && sameDay(selected, now) ? raw("disabled") : ""}>Oggi</button>
        <button type="button" class="btn btn-icon" data-week="-1" aria-label="Settimana precedente">${icon("chevronLeft")}</button>
        <button type="button" class="btn btn-icon" data-week="1" aria-label="Settimana successiva">${icon("chevronRight")}</button>
      </div>
    </div>
    <div class="agenda-strip${dir ? ` is-from-${dir}` : ""}" role="tablist" aria-label="Giorni della settimana" data-strip>
      ${days.map((d) => {
        const dots = dotsFor(d);
        const sel = sameDay(d, selected);
        return html`<button type="button" role="tab" class="agenda-day${sameDay(d, now) ? " is-today" : ""}${d.getDay() === 0 ? " is-sunday" : ""}"
          aria-selected="${String(sel)}" tabindex="${sel ? "0" : "-1"}" data-date="${ymd(d)}" aria-label="${fmtDate(d, { weekday: true })}${dots.length ? ", con eventi" : ""}">
          <span class="agenda-day-name">${DAY_SHORT[d.getDay()]}</span>
          <span class="agenda-day-num tnum">${d.getDate()}</span>
          <span class="agenda-day-dots" aria-hidden="true">${dots.slice(0, 3).map((k) => html`<i class="k-${k}"></i>`)}</span>
        </button>`;
      })}
    </div>`;
}
/** Collega frecce, "Oggi", tocco sui giorni, frecce da tastiera e swipe orizzontale. */
function bindWeekStrip(el, { onWeek, onDay }) {
  let suppress = 0;
  el.addEventListener("click", (e) => {
    if (Date.now() < suppress) return;
    const w = e.target.closest("[data-week]");
    if (w) return onWeek(w.dataset.week);
    const d = e.target.closest("[data-date]");
    if (d) onDay(parseDate(d.dataset.date));
  });
  el.addEventListener("keydown", (e) => {
    const d = e.target.closest("[data-date]");
    if (!d || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    onDay(addDays(parseDate(d.dataset.date), e.key === "ArrowLeft" ? -1 : 1), true);
  });
  let x0 = null, y0 = 0, pid = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !e.target.closest("[data-strip]")) return;
    x0 = e.clientX; y0 = e.clientY; pid = e.pointerId;
  });
  el.addEventListener("pointerup", (e) => {
    if (x0 === null || e.pointerId !== pid) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      suppress = Date.now() + 350;
      onWeek(dx < 0 ? "1" : "-1");
    }
  });
  el.addEventListener("pointercancel", () => { x0 = null; });
}

/* ---------------- eventi agenda ---------------- */
const KINDS = {
  hw: { label: "Compiti", icon: "homework" },
  test: { label: "Verifica", icon: "flask" },
  note: { label: "Annotazione", icon: "note" },
  room: { label: "Prenotazione aula", icon: "calendar" },
};
const KIND_ORDER = { test: 0, hw: 1, note: 2, room: 3 };
function kindOf(ev) {
  if (ev.evtCode === "AGHW") return "hw";
  if (ev.evtCode === "AGCR") return "room";
  return /verific|compito in classe|test\b|interrog|prova|simulazion|esame/i.test(ev.notes || "") ? "test" : "note";
}
function kindLabel(ev) {
  const k = kindOf(ev);
  if (k === "test" && /interrog/i.test(ev.notes || "")) return "Interrogazione";
  return KINDS[k].label;
}
function evTime(ev) {
  if (ev.isFullDay) return "Tutto il giorno";
  const a = fmtTime(ev.evtDatetimeBegin), b = fmtTime(ev.evtDatetimeEnd);
  return a && b && a !== b ? `${a}–${b}` : a;
}
function evTitle(ev) {
  if (ev.subjectDesc) return subjectName(ev.subjectDesc);
  return kindLabel(ev);
}
const evDay = (ev) => String(ev.evtDatetimeBegin || "").slice(0, 10).replace(/-/g, "");
function sortEvents(list) {
  return list.slice().sort((a, b) => String(a.evtDatetimeBegin).localeCompare(String(b.evtDatetimeBegin))
    || KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)]);
}

function eventSheet(ev) {
  const k = kindOf(ev);
  const d = parseDate(ev.evtDatetimeBegin);
  const rel = relativeDay(d);
  openSheet({
    title: evTitle(ev),
    content: html`<div class="agenda-sheet">
      <div class="hstack agenda-sheet-chips"><span class="chip agenda-chip k-${k}">${icon(KINDS[k].icon)}${kindLabel(ev)}</span>
        ${rel === "Oggi" || rel === "Domani" ? html`<span class="chip chip-accent">${rel}</span>` : ""}</div>
      <ul class="card list agenda-sheet-info">
        <li class="row"><span class="row-icon">${icon("calendar")}</span><div class="row-main"><p class="row-title">${cap(fmtDate(d, { weekday: true, year: true }))}</p><p class="row-sub">${evTime(ev)}</p></div></li>
        ${ev.authorName ? html`<li class="row"><span class="row-icon">${icon("person")}</span><div class="row-main"><p class="row-title">${personName(ev.authorName)}</p><p class="row-sub">Docente</p></div></li>` : ""}
      </ul>
      ${ev.notes ? html`<p class="overline agenda-sheet-label">Dettagli</p><div class="card card-pad agenda-notes">${ev.notes}</div>` : ""}
    </div>`,
  });
}

/* ---------------- compiti ---------------- */
function dueInfo(hw) {
  const d = parseDate(hw.expiryDate);
  if (!d) return { text: "Senza scadenza", diff: Infinity };
  const diff = dayDiff(d);
  const t = /^\d{2}:\d{2}/.test(hw.expiryTime || "") && !/^(23:59|00:00)/.test(hw.expiryTime) ? ` alle ${hw.expiryTime.slice(0, 5)}` : "";
  let text;
  if (diff < -1) text = `Scaduto ${relativeDay(d) === fmtDate(d) ? `il ${fmtDate(d)}` : `${-diff} giorni fa`}`;
  else if (diff === -1) text = "Scaduto ieri";
  else if (diff === 0) text = `Scade oggi${t}`;
  else if (diff === 1) text = `Scade domani${t}`;
  else if (diff < 7) text = `Scade ${relativeDay(d).toLowerCase()}${t}`;
  else text = `Scade il ${fmtDate(d)}`;
  return { text, diff };
}
function groupHomework(items) {
  const g = { late: [], today: [], next: [], done: [] };
  items.forEach((hw) => {
    if (hw.homeworkMarkedDone) return g.done.push(hw);
    const { diff } = dueInfo(hw);
    if (diff < 0) g.late.push(hw);
    else if (diff === 0) g.today.push(hw);
    else g.next.push(hw);
  });
  const byDue = (a, b) => String(a.expiryDate || "9").localeCompare(String(b.expiryDate || "9"));
  g.late.sort(byDue); g.today.sort(byDue); g.next.sort(byDue);
  g.done.sort((a, b) => -byDue(a, b));
  return g;
}
function linkOf(l) {
  if (typeof l === "string") return { url: l, label: l };
  const url = l?.url || l?.link || l?.linkUrl || l?.href || "";
  return { url, label: l?.title || l?.desc || l?.linkDesc || l?.name || url };
}

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    let tab = ctx.params.get("tab") === "compiti" ? "compiti" : store.get("agenda:tab", "agenda");
    if (tab !== "compiti") tab = "agenda";
    let weekStart = startOfWeek(new Date());
    let selected = today0();
    const weeks = new Map(); // ymd(lunedì) -> eventi | {error}
    let homework = null; // array | null
    let hwError = null;
    let regroupTimer = null;
    let alive = true;

    setHTML(root, html`${pageHeader({ eyebrow: "Registro", title: "Agenda" })}
      <div class="agenda-toolbar">${segmented("agenda-tab", [{ value: "agenda", label: "Agenda" }, { value: "compiti", label: "Compiti" }], tab)}
        <span class="caption agenda-toolbar-note" data-tabnote></span></div>
      <div data-pane></div>`);
    const pane = $("[data-pane]", root);
    bindSegmented(root, "agenda-tab", (v) => {
      tab = v;
      store.set("agenda:tab", v);
      const url = new URL(location.href);
      if (v === "compiti") url.searchParams.set("tab", "compiti"); else url.searchParams.delete("tab");
      history.replaceState(history.state, "", url.pathname + url.search);
      mountPane();
    });

    /* ----- Agenda ----- */
    const weekKey = (ws) => ymd(ws);
    const eventsOf = (ws) => { const w = weeks.get(weekKey(ws)); return Array.isArray(w) ? w : []; };
    const dotsFor = (d) => {
      const evs = eventsOf(startOfWeek(d)).filter((e) => evDay(e) === ymd(d));
      return [...new Set(sortEvents(evs).map(kindOf))];
    };

    const drawStrip = (dir = "") => {
      const el = $("[data-weekcard]", pane);
      if (el) setHTML(el, weekStrip(weekStart, selected, dotsFor, dir));
    };
    const drawDay = () => {
      const el = $("[data-daylist]", pane);
      if (!el) return;
      const w = weeks.get(weekKey(weekStart));
      const rel = relativeDay(selected);
      const head = html`<div class="section-head agenda-dayhead"><p class="title-2">${cap(fmtDate(selected, { weekday: true }))}</p>
        ${rel === "Oggi" || rel === "Domani" || rel === "Ieri" ? html`<span class="chip ${rel === "Oggi" ? "chip-accent" : ""}">${rel}</span>` : ""}</div>`;
      if (w === undefined) {
        setHTML(el, html`${head}<div class="card list">${[0, 1].map(() => html`<div class="row"><div class="skeleton" style="width:38px;height:38px;border-radius:12px"></div>
          <div class="row-main stack-sm"><div class="skeleton-line" style="width:30%;height:11px"></div><div class="skeleton-line" style="width:70%"></div></div></div>`)}</div>`);
        return;
      }
      if (w?.error) {
        setHTML(el, html`${head}${errorState(w.error)}`);
        $("[data-retry]", el)?.addEventListener("click", () => { weeks.delete(weekKey(weekStart)); drawAgenda(); fetchWeek(weekStart); });
        return;
      }
      const evs = sortEvents(w.filter((e) => evDay(e) === ymd(selected)));
      if (!evs.length) {
        const later = sortEvents(w).find((e) => evDay(e) > ymd(selected));
        const isWeekend = selected.getDay() === 0 || selected.getDay() === 6;
        setHTML(el, html`${head}<div class="card agenda-empty">${emptyState({
          iconName: "calendar",
          title: isWeekend ? "Weekend libero" : "Giornata libera",
          text: rel === "Oggi" ? "Niente compiti né verifiche per oggi." : "Nessun compito, verifica o annotazione in questo giorno.",
        })}${later ? html`<button type="button" class="btn agenda-jump" data-jump="${evDay(later)}">Prossimo: ${relativeDay(parseDate(later.evtDatetimeBegin))} · ${evTitle(later)}${icon("chevronRight")}</button>` : ""}</div>`);
        return;
      }
      setHTML(el, html`${head}<ul class="card list agenda-events">${evs.map((ev) => {
        const k = kindOf(ev);
        return html`<li><button type="button" class="row agenda-ev" data-ev="${ev.evtId}">
          <span class="agenda-ev-icon k-${k}">${icon(KINDS[k].icon)}</span>
          <div class="row-main">
            <p class="agenda-ev-kind k-${k}">${kindLabel(ev)}<span class="faint"> · ${evTime(ev)}</span></p>
            <p class="row-title">${evTitle(ev)}</p>
            ${ev.notes ? html`<p class="agenda-ev-notes is-clamp3">${ev.notes}</p>` : ""}
            ${ev.authorName ? html`<p class="row-sub">${personName(ev.authorName)}</p>` : ""}
          </div>${icon("chevronRight", "chev")}</button></li>`;
      })}</ul>`);
    };
    const drawWeekList = () => {
      const el = $("[data-weeklist]", pane);
      if (!el) return;
      const w = weeks.get(weekKey(weekStart));
      if (!Array.isArray(w)) { setHTML(el, ""); return; }
      const evs = sortEvents(w);
      const hw = evs.filter((e) => kindOf(e) === "hw").length;
      const tests = evs.filter((e) => kindOf(e) === "test").length;
      const days = [];
      evs.forEach((e) => { const k = evDay(e); let g = days.find((x) => x.k === k); if (!g) days.push((g = { k, items: [] })); g.items.push(e); });
      setHTML(el, html`<div class="section-head"><p class="overline">In settimana</p>
          <p class="caption">${evs.length ? [hw ? `${hw} ${hw === 1 ? "compito" : "compiti"}` : "", tests ? `${tests} ${tests === 1 ? "verifica" : "verifiche"}` : "", evs.length - hw - tests ? `${evs.length - hw - tests} ${evs.length - hw - tests === 1 ? "altro evento" : "altri eventi"}` : ""].filter(Boolean).join(" · ") : "Niente in programma"}</p></div>
        ${days.length ? html`<div class="card agenda-week">${days.map((g) => {
          const d = parseDate(g.k);
          return html`<button type="button" class="agenda-week-day${sameDay(d, selected) ? " is-selected" : ""}" data-jump="${g.k}">
            <span class="agenda-week-date"><span class="caption">${DAY_SHORT[d.getDay()]}</span><span class="title-3 tnum">${d.getDate()}</span></span>
            <span class="agenda-week-items">${g.items.map((e) => html`<span class="agenda-week-item"><i class="agenda-dot k-${kindOf(e)}"></i><span class="agenda-week-subj">${evTitle(e)}</span><span class="faint agenda-week-note">${e.notes || ""}</span></span>`)}</span>
          </button>`;
        })}</div>` : html`<div class="card card-pad"><p class="body-2">Una settimana tranquilla: nessun evento in agenda.</p></div>`}`);
    };
    const drawAgenda = (dir = "") => { drawStrip(dir); drawDay(); drawWeekList(); };

    const fetchWeek = (ws) => {
      const start = ymd(ws), end = ymd(addDays(ws, 6));
      const key = weekKey(ws);
      return load(`agenda:${start}:${end}`, () => post("/agenda", { start, end }).catch((err) => {
        if (err.status === 422) return { agenda: { agenda: [] } };
        throw err;
      }), (data) => {
        const list = data?.agenda?.agenda || data?.agenda || [];
        weeks.set(key, Array.isArray(list) ? list : []);
        if (alive && tab === "agenda" && key === weekKey(weekStart)) drawAgenda();
      }, { maxAge: 120_000 }).catch((err) => {
        if (weeks.has(key) && Array.isArray(weeks.get(key))) return;
        weeks.set(key, { error: err });
        if (alive && tab === "agenda" && key === weekKey(weekStart)) drawAgenda();
      });
    };
    const goWeek = (ws, sel, dir) => {
      weekStart = ws;
      selected = sel;
      drawAgenda(dir);
      if (!weeks.has(weekKey(ws)) || weeks.get(weekKey(ws))?.error) { weeks.delete(weekKey(ws)); fetchWeek(ws).then(() => prefetch(ws)); }
      else fetchWeek(ws);
    };
    const prefetch = (ws) => { const n = addDays(ws, 7); if (!weeks.has(weekKey(n))) fetchWeek(n); };

    const mountAgenda = () => {
      setHTML(pane, html`<section class="card agenda-weekcard" data-weekcard></section>
        <div class="agenda-cols"><section class="agenda-daycol" data-daylist></section><aside class="agenda-weekcol" data-weeklist></aside></div>`);
      bindWeekStrip($("[data-weekcard]", pane), {
        onWeek: (w) => {
          if (w === "today") return goWeek(startOfWeek(new Date()), today0(), sameDay(weekStart, startOfWeek(new Date())) ? "" : weekStart > new Date() ? "left" : "right");
          const n = Number(w);
          const ws = addDays(weekStart, 7 * n);
          // Mantiene lo stesso giorno della settimana; se cade nella settimana corrente sceglie oggi.
          const sel = sameDay(ws, startOfWeek(new Date())) ? today0() : addDays(selected, 7 * n);
          goWeek(ws, sel, n > 0 ? "right" : "left");
        },
        onDay: (d, focus) => {
          if (!sameDay(startOfWeek(d), weekStart)) { goWeek(startOfWeek(d), d, d > weekStart ? "right" : "left"); }
          else { selected = d; drawStrip(); drawDay(); drawWeekList(); }
          if (focus) $(`[data-date="${ymd(d)}"]`, pane)?.focus();
        },
      });
      drawAgenda();
      if (!weeks.has(weekKey(weekStart))) fetchWeek(weekStart).then(() => prefetch(weekStart));
      else fetchWeek(weekStart);
    };

    pane.addEventListener("click", (e) => {
      if (tab !== "agenda") return;
      const j = e.target.closest("[data-jump]");
      if (j) { selected = parseDate(j.dataset.jump); drawStrip(); drawDay(); drawWeekList(); return; }
      const b = e.target.closest("[data-ev]");
      if (b) {
        const ev = eventsOf(weekStart).find((x) => String(x.evtId) === b.dataset.ev);
        if (ev) eventSheet(ev);
      }
    });

    /* ----- Compiti ----- */
    const hwById = (id) => (homework || []).find((h) => String(h.evtId) === String(id));
    const hwRow = (hw) => {
      const due = dueInfo(hw);
      const done = !!hw.homeworkMarkedDone;
      const files = (hw.teacherFiles || []).length;
      const tone = done ? "" : due.diff < 0 ? "is-late" : due.diff <= 1 ? "is-soon" : "";
      return html`<li class="row agenda-hw${done ? " is-done" : ""}" data-hwrow="${hw.evtId}">
        <button type="button" class="agenda-check" role="checkbox" aria-checked="${String(done)}" data-done="${hw.evtId}"
          aria-label="${done ? "Segna come da fare" : "Segna come fatto"}"><span>${icon("check")}</span></button>
        <button type="button" class="row-main agenda-hw-main" data-hw="${hw.evtId}">
          <p class="row-title">${subjectName(hw.subjectDesc) || "Compito"}</p>
          ${hw.homeworkDesc ? html`<p class="agenda-ev-notes clamp-2">${hw.homeworkDesc}</p>` : ""}
          <p class="agenda-hw-meta"><span class="agenda-due ${tone}">${icon("clock")}${due.text}</span>
            ${files ? html`<span>${icon("paperclip")}${files}</span>` : ""}
            ${hw.newMessages ? html`<span class="agenda-msg">${hw.newMessages} ${hw.newMessages === 1 ? "messaggio" : "messaggi"}</span>` : ""}
            ${hw.teacherName ? html`<span class="agenda-hw-teacher">${personName(hw.teacherName)}</span>` : ""}</p>
        </button>
      </li>`;
    };
    const drawCompiti = () => {
      if (tab !== "compiti") return;
      const note = $("[data-tabnote]", root);
      if (hwError && !homework) {
        setHTML(pane, errorState(hwError));
        $("[data-retry]", pane)?.addEventListener("click", () => { hwError = null; mountPane(); });
        return;
      }
      if (!homework) {
        setHTML(pane, html`<div class="card list">${[0, 1, 2].map(() => html`<div class="row"><div class="skeleton" style="width:28px;height:28px;border-radius:50%"></div>
          <div class="row-main stack-sm"><div class="skeleton-line" style="width:40%"></div><div class="skeleton-line" style="width:75%;height:11px"></div></div></div>`)}</div>`);
        return;
      }
      const g = groupHomework(homework);
      const pending = g.late.length + g.today.length + g.next.length;
      if (note) note.textContent = pending ? `${pending} da fare` : "";
      if (!homework.length) {
        setHTML(pane, html`<div class="card">${emptyState({ iconName: "homework", title: "Nessun compito con consegna", text: "Qui trovi i compiti assegnati con la funzione Compiti di ClasseViva, con file e scadenze." })}</div>`);
        return;
      }
      const section = (title, list, cls = "", extra = "") => list.length ? html`<section class="agenda-hwgroup ${cls}">
        <div class="section-head"><p class="overline">${title}</p><span class="caption tnum">${list.length}</span></div>
        <ul class="card list">${list.map(hwRow)}</ul>${extra}</section>` : "";
      setHTML(pane, html`
        ${!pending ? html`<div class="card card-pad agenda-alldone"><span class="row-icon">${icon("check")}</span><div><p class="title-3">Tutto fatto</p><p class="body-2">Non hai compiti in sospeso. Bel lavoro.</p></div></div>` : ""}
        ${section("In ritardo", g.late, "is-late")}
        ${section("Oggi", g.today, "is-today")}
        ${section("Prossimi", g.next)}
        ${section("Fatti", g.done, "is-donegroup")}`);
    };
    const scheduleRegroup = () => {
      clearTimeout(regroupTimer);
      regroupTimer = setTimeout(() => { if (alive) drawCompiti(); }, 700);
    };
    const setDone = async (hw, done) => {
      const prev = !!hw.homeworkMarkedDone;
      if (prev === done) return;
      hw.homeworkMarkedDone = done;
      $$(`[data-hwrow="${hw.evtId}"]`, pane).forEach((row) => {
        row.classList.toggle("is-done", done);
        const c = $("[data-done]", row);
        c.setAttribute("aria-checked", String(done));
        c.setAttribute("aria-label", done ? "Segna come da fare" : "Segna come fatto");
      });
      scheduleRegroup();
      try {
        await post(`/compiti/${hw.evtId}/fatto`, { done });
        invalidate("compiti");
      } catch (err) {
        hw.homeworkMarkedDone = prev;
        toast(err.message || "Impossibile aggiornare il compito.", { error: true });
        if (alive) drawCompiti();
        throw err;
      }
    };
    const homeworkSheet = (hw) => {
      const body = document.createElement("div");
      const draw = () => {
        const due = dueInfo(hw);
        const files = hw.teacherFiles || [];
        const links = (hw.teacherLinks || []).map(linkOf).filter((l) => /^https?:\/\//i.test(l.url));
        const assigned = parseDate(hw.assignmentDate);
        setHTML(body, html`<div class="agenda-sheet">
          <div class="hstack agenda-sheet-chips"><span class="chip agenda-chip k-hw">${icon("homework")}Compito</span>
            ${hw.homeworkMarkedDone ? html`<span class="chip chip-good">${icon("check")}Fatto</span>` : html`<span class="chip ${due.diff < 0 ? "chip-bad" : due.diff <= 1 ? "chip-ok" : ""}">${due.text}</span>`}</div>
          ${hw.homeworkDesc ? html`<div class="card card-pad agenda-notes">${hw.homeworkDesc}</div>` : ""}
          <ul class="card list agenda-sheet-info">
            ${hw.teacherName ? html`<li class="row"><span class="row-icon">${icon("person")}</span><div class="row-main"><p class="row-title">${personName(hw.teacherName)}</p><p class="row-sub">Docente</p></div></li>` : ""}
            ${assigned ? html`<li class="row"><span class="row-icon">${icon("calendar")}</span><div class="row-main"><p class="row-title">${cap(fmtDate(assigned, { weekday: true }))}</p><p class="row-sub">Assegnato</p></div></li>` : ""}
            ${hw.expiryDate ? html`<li class="row"><span class="row-icon">${icon("clock")}</span><div class="row-main"><p class="row-title">${cap(fmtDate(hw.expiryDate, { weekday: true }))}${hw.expiryTime ? ` · ${String(hw.expiryTime).slice(0, 5)}` : ""}</p><p class="row-sub">Consegna</p></div></li>` : ""}
          </ul>
          ${hw.newMessages ? html`<p class="chip chip-accent">${icon("bell")}${hw.newMessages} ${hw.newMessages === 1 ? "nuovo messaggio" : "nuovi messaggi"} dal docente su ClasseViva</p>` : ""}
          ${files.length || links.length ? html`<p class="overline agenda-sheet-label">Materiale del docente</p>
            <ul class="card list">${files.map((f) => html`<li><button type="button" class="row" data-file="${f.fileId}"><span class="row-icon">${icon("paperclip")}</span>
                <div class="row-main"><p class="row-title">${f.fileName || "File"}</p><p class="row-sub">Tocca per aprire</p></div>${icon("download", "chev")}</button></li>`)}
              ${links.map((l) => html`<li><a class="row" href="${l.url}" target="_blank" rel="noopener"><span class="row-icon">${icon("link")}</span>
                <div class="row-main"><p class="row-title clamp-2">${l.label}</p></div>${icon("chevronRight", "chev")}</a></li>`)}</ul>` : ""}
          <button type="button" class="btn ${hw.homeworkMarkedDone ? "" : "btn-primary"} btn-block btn-lg agenda-sheet-done" data-toggle>
            ${icon(hw.homeworkMarkedDone ? "refresh" : "check")}${hw.homeworkMarkedDone ? "Segna come da fare" : "Segna come fatto"}</button>
        </div>`);
      };
      draw();
      body.addEventListener("click", async (e) => {
        const f = e.target.closest("[data-file]");
        if (f) {
          f.disabled = true;
          try { await openFile({ kind: "compito", evt_id: String(hw.evtId), file_id: String(f.dataset.file) }); }
          catch (err) { toast(err.message || "Impossibile aprire il file.", { error: true }); }
          finally { f.disabled = false; }
          return;
        }
        if (e.target.closest("[data-toggle]")) {
          const p = setDone(hw, !hw.homeworkMarkedDone);
          draw();
          try { await p; } catch { draw(); }
        }
      });
      openSheet({ title: subjectName(hw.subjectDesc) || "Compito", content: body });
    };
    const fetchCompiti = () => load("compiti", () => get("/compiti"), (data) => {
      homework = Array.isArray(data?.items) ? data.items.map((h) => ({ ...h })) : [];
      hwError = null;
      if (alive) drawCompiti();
    }, { maxAge: 60_000 }).catch((err) => { hwError = err; if (alive) drawCompiti(); });

    const mountCompiti = () => {
      drawCompiti();
      fetchCompiti();
    };
    pane.addEventListener("click", (e) => {
      if (tab !== "compiti") return;
      const c = e.target.closest("[data-done]");
      if (c) { const hw = hwById(c.dataset.done); if (hw) setDone(hw, !hw.homeworkMarkedDone).catch(() => {}); return; }
      const m = e.target.closest("[data-hw]");
      if (m) { const hw = hwById(m.dataset.hw); if (hw) homeworkSheet(hw); }
    });

    const mountPane = () => {
      const note = $("[data-tabnote]", root);
      if (note) note.textContent = "";
      if (tab === "agenda") mountAgenda(); else mountCompiti();
    };
    mountPane();

    return () => { alive = false; clearTimeout(regroupTimer); };
  },
};
