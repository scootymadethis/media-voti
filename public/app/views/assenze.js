// Presenze: riepilogo, calendario annuale a "heatmap" e cronologia con lo stato delle giustificazioni.
import { post, get, load } from "aulera/api";
import { state, yearQuery, isCurrentYear, on, yearLabel } from "aulera/state";
import {
  html, icon, setHTML, $, $$, segmented, bindSegmented, openSheet, emptyState, errorState,
  fmtDate, relativeDay, parseDate, isoDay, sameDay, subjectName, ymd, fmtNum,
} from "aulera/ui";
import { pageHeader, yearButton, bindYearPicker } from "aulera/main";

const TYPES = {
  ABA0: { k: "abs", label: "Assenza", icon: "absences", fem: true },
  ABR0: { k: "late", label: "Ritardo", icon: "clock", fem: false },
  ABR1: { k: "late", label: "Ritardo breve", icon: "clock", fem: false },
  ABU0: { k: "exit", label: "Uscita anticipata", icon: "logout", fem: true },
};
const typeOf = (e) => TYPES[e.evtCode] || { k: "other", label: "Evento", icon: "info", fem: false };
const PRIORITY = { abs: 0, exit: 1, late: 2, other: 3 };
const MONTHS = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
const DOW = ["L", "M", "M", "G", "V", "S", "D"];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function status(e) {
  const t = typeOf(e);
  if (e.isJustified) return { cls: "chip-good", text: t.fem ? "Giustificata" : "Giustificato", k: "ok" };
  if (Number(e.webJustifStatus) === 1) return { cls: "chip-accent", text: "In approvazione", k: "wait" };
  return { cls: "chip-ok", text: "Da giustificare", k: "todo" };
}
function detailOf(e) {
  const h = Number(e.evtHPos);
  if (e.evtCode === "ABR0") return h ? `Entrata alla ${h}ª ora` : "Entrata in ritardo";
  if (e.evtCode === "ABR1") return h ? `Entrata breve alla ${h}ª ora` : "Entro pochi minuti";
  if (e.evtCode === "ABU0") return h ? `Uscita alla ${h}ª ora` : "Uscita prima del termine";
  return "Tutta la giornata";
}
function schoolYearStart() {
  const m = String(state.year || "").match(/^(\d{4})/);
  if (m) return Number(m[1]);
  const t = new Date();
  return t.getMonth() >= 7 ? t.getFullYear() : t.getFullYear() - 1;
}

/* ---------------- ore di assenza ----------------
   Quante ore dura ogni giornata lo dicono le lezioni registrate della classe (le stesse da cui Orario
   ricava la settimana): un giorno con lezioni dalla 1ª alla 7ª ora vale 7 ore, uno con 5 lezioni 5.
   Se in un giorno non c'è nessuna lezione registrata si usa la durata tipica di quel giorno della
   settimana (la più frequente nell'anno) e, in mancanza anche di quella, 6 ore. */
const DOW_SHORT = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
const DEFAULT_DAY_HOURS = 6;
const SCHOOL_WEEKS = 33; // settimane di lezione in un anno (circa 200 giorni)
const MAX_ABSENCE_SHARE = 0.25; // validità dell'anno: almeno 3/4 dell'orario (DPR 122/2009, art. 14)

function lessonModel(lessons) {
  const perDay = new Map(); // "AAAA-MM-GG" -> Set delle ore di lezione
  (lessons || []).forEach((l) => {
    const k = String(l.evtDate || "").slice(0, 10);
    const h = Number(l.evtHPos);
    if (!k || !h) return;
    const dur = Math.max(1, Math.min(4, Math.round(Number(l.evtDuration) || 1)));
    if (!perDay.has(k)) perDay.set(k, new Set());
    for (let i = 0; i < dur; i++) perDay.get(k).add(h + i);
  });
  const freq = new Map(); // giorno della settimana -> Map(durata -> volte)
  perDay.forEach((set, k) => {
    const dow = parseDate(k).getDay();
    if (!freq.has(dow)) freq.set(dow, new Map());
    const m = freq.get(dow);
    m.set(set.size, (m.get(set.size) || 0) + 1);
  });
  const weekly = new Map();
  freq.forEach((m, dow) => weekly.set(dow, [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]));
  return { perDay, weekly, known: perDay.size > 0 };
}

/** Ore di lezione di quel giorno: {set (ore note o null), n, source: "lessons" | "weekly" | "default"}. */
function dayInfo(model, key) {
  const set = model?.perDay.get(key);
  if (set?.size) return { set, n: set.size, source: "lessons" };
  const w = model?.weekly.get(parseDate(key).getDay());
  if (w) return { set: null, n: w, source: "weekly" };
  return { set: null, n: DEFAULT_DAY_HOURS, source: "default" };
}

/** Ore perse per un evento. Ritardo alla h-esima ora: le ore prima; uscita alla h-esima: da quella in poi. */
function eventHours(e, model) {
  const listed = new Set((e.hoursAbsence || []).map((x) => Number(x?.hPos)).filter(Boolean));
  const day = dayInfo(model, String(e.evtDate).slice(0, 10));
  if (listed.size) return { hours: listed.size, source: "registro", day };
  const h = Number(e.evtHPos);
  const hoursList = day.set ? [...day.set] : Array.from({ length: day.n }, (_, i) => i + 1);
  let hours = 0;
  if (e.evtCode === "ABA0") hours = day.n;
  else if (e.evtCode === "ABR0") hours = h ? hoursList.filter((x) => x < h).length : 1;
  else if (e.evtCode === "ABU0") hours = h ? hoursList.filter((x) => x >= h).length : 1;
  // ABR1 (ritardo breve, entro pochi minuti) non conta come ora persa
  return { hours, source: day.source, day };
}
const hoursText = (n) => `${fmtNum(n, 0)} ${n === 1 ? "ora" : "ore"}`;

/** Assenze di giorni scolastici consecutivi (weekend in mezzo compreso) diventano un solo blocco. */
function mergeRuns(events) {
  const sorted = events.slice().sort((a, b) => String(b.evtDate).localeCompare(String(a.evtDate)));
  const out = [];
  sorted.forEach((e) => {
    const last = out[out.length - 1];
    if (e.evtCode === "ABA0" && last && last.code === "ABA0" && status(last.events[0]).k === status(e).k) {
      const d = parseDate(e.evtDate), first = parseDate(last.events[last.events.length - 1].evtDate);
      const gap = Math.round((first - d) / 86400000);
      const bridgesWeekend = gap <= 3 && d.getDay() === 5 && first.getDay() === 1;
      if (gap === 1 || bridgesWeekend || (gap === 2 && d.getDay() === 6)) { last.events.push(e); return; }
    }
    out.push({ code: e.evtCode, events: [e] });
  });
  return out;
}

export default {
  async render(root) {
    let events = [];
    let model = null; // ore di lezione per giorno (dalle lezioni registrate)
    let modelState = "loading"; // loading | ok | none
    let snapshot = false;
    let filter = "all";
    let empty404 = false;

    setHTML(root, html`${pageHeader({ eyebrow: "Registro", title: "Assenze", actions: yearButton() })}
      <div data-body>
        <div class="assenze-stats">${[0, 1, 2, 3].map(() => html`<div class="card assenze-stat"><div class="skeleton-line" style="width:50%"></div><div class="skeleton" style="height:36px;width:40%;margin-top:14px"></div></div>`)}</div>
        <div class="card card-pad section"><div class="skeleton" style="height:180px"></div></div>
      </div>`);
    const body = $("[data-body]", root);
    bindYearPicker(root, () => fetchData());

    const byDay = () => {
      const m = new Map();
      events.forEach((e) => { const k = String(e.evtDate).slice(0, 10); if (!m.has(k)) m.set(k, []); m.get(k).push(e); });
      m.forEach((list) => list.sort((a, b) => PRIORITY[typeOf(a).k] - PRIORITY[typeOf(b).k]));
      return m;
    };
    const dayClass = (list) => {
      if (!list?.length) return "";
      const k = typeOf(list[0]).k;
      const pending = list.some((e) => !e.isJustified);
      return ` has-ev k-${k}${pending ? " is-pending" : ""}`;
    };

    /* ----- calendario di un mese ----- */
    const monthGrid = (y, m, days, { big = false } = {}) => {
      const first = new Date(y, m, 1);
      const lead = (first.getDay() + 6) % 7;
      const n = new Date(y, m + 1, 0).getDate();
      const today = new Date();
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push(html`<span class="assenze-d is-blank" aria-hidden="true"></span>`);
      for (let d = 1; d <= n; d++) {
        const date = new Date(y, m, d);
        const k = isoDay(date);
        const list = days.get(k);
        const cls = `assenze-d${dayClass(list)}${date.getDay() === 0 ? " is-sunday" : ""}${date > today ? " is-future" : ""}${sameDay(date, today) ? " is-today" : ""}`;
        if (big && list) cells.push(html`<button type="button" class="${cls}" data-pick="${k}" aria-label="${fmtDate(date, { weekday: true })}: ${list.map((e) => typeOf(e).label).join(", ")}">${d}</button>`);
        else cells.push(html`<span class="${cls}">${d}</span>`);
      }
      return html`<div class="assenze-cal${big ? " is-big" : ""}">${big ? DOW.map((x) => html`<span class="assenze-dow">${x}</span>`) : ""}${cells}</div>`;
    };
    const monthCounts = (list) => {
      const c = { abs: 0, late: 0, exit: 0 };
      list.forEach((e) => { const k = typeOf(e).k; if (k in c) c[k]++; });
      return c;
    };
    const countsLine = (c) => [c.abs && plural(c.abs, "assenza", "assenze"), c.late && plural(c.late, "ritardo", "ritardi"), c.exit && plural(c.exit, "uscita", "uscite")].filter(Boolean).join(" · ");

    /* ----- righe cronologia ----- */
    const rowHTML = (run) => {
      const e = run.events[0];
      const t = typeOf(e);
      const st = status(e);
      const last = parseDate(run.events[0].evtDate), firstD = parseDate(run.events[run.events.length - 1].evtDate);
      const multi = run.events.length > 1;
      const hours = (e.hoursAbsence || []).filter((h) => h?.subject).map((h) => subjectName(h.subject));
      const lost = modelState === "loading" ? null : run.events.reduce((sum, ev) => sum + eventHours(ev, model).hours, 0);
      const sub = multi ? `${cap(fmtDate(firstD, { weekday: true }))} – ${fmtDate(last, { weekday: true }).toLowerCase()}` : `${cap(fmtDate(last, { weekday: true }))}${t.k === "abs" ? "" : ` · ${detailOf(e)}`}`;
      return html`<li><button type="button" class="row assenze-row" data-day="${String(e.evtDate).slice(0, 10)}">
        <span class="assenze-date k-${t.k}${multi ? " is-range" : ""}"><span class="tnum">${multi ? `${firstD.getDate()}–${last.getDate()}` : last.getDate()}</span><small>${MONTHS[last.getMonth()].slice(0, 3)}</small></span>
        <div class="row-main">
          <p class="row-title">${t.label}${multi ? html` <span class="faint">· ${run.events.length} giorni</span>` : ""}${lost ? html` <span class="assenze-row-hours tnum">${hoursText(lost)}</span>` : ""}</p>
          <p class="row-sub">${sub}</p>
          ${hours.length && !multi ? html`<p class="row-sub faint clamp-2">${hours.join(", ")}</p>` : ""}
          <p class="assenze-meta"><span class="chip ${st.cls}">${st.k === "ok" ? icon("check") : ""}${st.text}</span>${e.isJustified && e.justifReasonDesc ? html`<span class="caption">${e.justifReasonDesc}</span>` : ""}</p>
        </div>${icon("chevronRight", "chev")}
      </button></li>`;
    };
    const eventCard = (e) => {
      const t = typeOf(e);
      const st = status(e);
      const hours = (e.hoursAbsence || []).filter((h) => h && (h.subject || h.hPos));
      return html`<div class="card card-pad assenze-evcard">
        <div class="spread"><span class="chip assenze-chip k-${t.k}">${icon(t.icon)}${t.label}</span><span class="chip ${st.cls}">${st.k === "ok" ? icon("check") : ""}${st.text}</span></div>
        <p class="title-3 assenze-evdetail">${detailOf(e)}</p>
        ${modelState !== "loading" ? (() => {
          const x = eventHours(e, model);
          const why = x.source === "registro" ? "indicate dal registro"
            : x.source === "lessons" ? `quel giorno la classe aveva ${hoursText(x.day.n)} di lezione`
            : x.source === "weekly" ? `di solito il ${DOW_SHORT[parseDate(e.evtDate).getDay()].toLowerCase()} la classe ha ${hoursText(x.day.n)}`
            : `orario non disponibile: stimate ${hoursText(x.day.n)} al giorno`;
          return html`<p class="assenze-evhours"><strong class="tnum">${hoursText(x.hours)}</strong> di lezione ${x.hours === 1 ? "persa" : "perse"} <span class="caption">· ${why}</span></p>`;
        })() : ""}
        ${hours.length ? html`<ul class="assenze-hours">${hours.map((h) => html`<li><span class="tnum">${h.hPos ? `${h.hPos}ª` : ""}</span><span>${h.subject ? subjectName(h.subject) : "Ora di lezione"}</span></li>`)}</ul>` : ""}
        ${e.isJustified ? html`<p class="body-2">${e.justifReasonDesc ? `Motivo: ${e.justifReasonDesc}` : "Giustificazione registrata."}</p>`
          : st.k === "wait" ? html`<p class="body-2">La giustificazione inviata online è in attesa di approvazione da parte del docente.</p>`
          : html`<p class="body-2">Puoi giustificarla dal libretto web di ClasseViva o con il libretto cartaceo.</p>`}
      </div>`;
    };
    const daySheet = (k) => {
      const list = byDay().get(k) || [];
      if (!list.length) return;
      const d = parseDate(k);
      const rel = relativeDay(d);
      openSheet({
        title: cap(fmtDate(d, { weekday: true })),
        content: html`<div class="assenze-sheet">${rel === "Oggi" || rel === "Ieri" ? html`<p class="caption">${rel}</p>` : ""}${list.map(eventCard)}</div>`,
      });
    };
    const monthSheet = (y, m) => {
      const days = byDay();
      const content = document.createElement("div");
      const inMonth = events.filter((e) => { const d = parseDate(e.evtDate); return d && d.getFullYear() === y && d.getMonth() === m; });
      let picked = null;
      const draw = () => {
        const shown = picked ? inMonth.filter((e) => String(e.evtDate).slice(0, 10) === picked) : inMonth;
        setHTML(content, html`<div class="assenze-sheet">
          <div class="card card-pad">${monthGrid(y, m, days, { big: true })}${legend()}</div>
          <div class="section-head" style="margin:6px 4px 0"><p class="overline">${picked ? cap(fmtDate(picked, { weekday: true })) : countsLine(monthCounts(inMonth)) || "Nessun evento"}</p>
            ${picked ? html`<button type="button" class="btn btn-ghost assenze-clear" data-clear>Tutto il mese</button>` : ""}</div>
          <ul class="card list">${mergeRuns(shown).map(rowHTML)}</ul>
        </div>`);
        $$("[data-pick]", content).forEach((b) => b.classList.toggle("is-picked", b.dataset.pick === picked));
      };
      draw();
      content.addEventListener("click", (e) => {
        const p = e.target.closest("[data-pick]");
        if (p) { picked = picked === p.dataset.pick ? null : p.dataset.pick; draw(); return; }
        if (e.target.closest("[data-clear]")) { picked = null; draw(); return; }
        const r = e.target.closest("[data-day]");
        if (r) daySheet(r.dataset.day);
      });
      openSheet({ title: `${MONTHS[m]} ${y}`, content });
    };
    const legend = () => html`<ul class="assenze-legend" aria-label="Legenda">
      <li><i class="assenze-d has-ev k-abs"></i>Assenza</li><li><i class="assenze-d has-ev k-late"></i>Ritardo</li>
      <li><i class="assenze-d has-ev k-exit"></i>Uscita</li><li><i class="assenze-d is-pending-sample"></i>Da giustificare</li></ul>`;

    /* ----- vista ----- */
    const draw = () => {
      if (empty404 || !events.length) {
        setHTML(body, html`${snapshot ? snapshotChip() : ""}<div class="card">${empty404
          ? emptyState({ iconName: "history", title: "Nessun dato salvato", text: `Per l'${yearLabel().replace(/^A\.S\./, "anno")} non ci sono presenze salvate su Skoolio.` })
          : emptyState({ iconName: "absences", title: "Nessuna assenza", text: isCurrentYear() ? "Finora nessuna assenza, ritardo o uscita: continua così." : "In quest'anno non risultano assenze, ritardi o uscite." })}</div>`);
        return;
      }
      const c = monthCounts(events);
      const short = events.filter((e) => e.evtCode === "ABR1").length;
      const todo = events.filter((e) => !e.isJustified);
      const waiting = todo.filter((e) => Number(e.webJustifStatus) === 1).length;
      const days = byDay();
      const y0 = schoolYearStart();
      const months = Array.from({ length: 10 }, (_, i) => { const d = new Date(y0, 8 + i, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
      const today = new Date();
      const runs = mergeRuns(filter === "all" ? events : events.filter((e) => typeOf(e).k === filter));
      const groups = [];
      runs.forEach((r) => {
        const d = parseDate(r.events[0].evtDate);
        const k = `${d.getFullYear()}-${d.getMonth()}`;
        let g = groups.find((x) => x.k === k);
        if (!g) groups.push((g = { k, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, runs: [] }));
        g.runs.push(r);
      });

      setHTML(body, html`
        ${snapshot ? snapshotChip() : ""}
        <div class="assenze-stats">
          <div class="card assenze-stat k-abs"><p class="assenze-stat-label"><i></i>Assenze</p><p class="stat-num">${c.abs}</p><p class="caption">${c.abs === 1 ? "giorno" : "giorni"}</p></div>
          <div class="card assenze-stat k-late"><p class="assenze-stat-label"><i></i>Ritardi</p><p class="stat-num">${c.late}</p><p class="caption">${short ? `di cui ${short} ${short === 1 ? "breve" : "brevi"}` : "entrate posticipate"}</p></div>
          <div class="card assenze-stat k-exit"><p class="assenze-stat-label"><i></i>Uscite</p><p class="stat-num">${c.exit}</p><p class="caption">anticipate</p></div>
          <div class="card assenze-stat ${todo.length ? "is-todo" : "is-clear"}"><p class="assenze-stat-label">${todo.length ? html`<i></i>` : icon("check")}Da giustificare</p><p class="stat-num">${todo.length}</p>
            <p class="caption">${todo.length ? (waiting ? `${waiting} in approvazione` : "da sistemare") : "tutto in regola"}</p></div>
        </div>

        ${hoursCard()}

        <section class="section">
          <div class="section-head"><p class="overline">Calendario</p>${legend()}</div>
          <div class="assenze-months" data-months>${months.map(({ y, m }) => {
            const list = events.filter((e) => { const d = parseDate(e.evtDate); return d && d.getFullYear() === y && d.getMonth() === m; });
            const mc = monthCounts(list);
            const future = new Date(y, m, 1) > today;
            const current = today.getFullYear() === y && today.getMonth() === m;
            const inner = html`<div class="assenze-month-head"><p class="title-3">${MONTHS[m]}</p>
                <span class="assenze-month-dots">${["abs", "late", "exit"].filter((k) => mc[k]).map((k) => html`<span class="k-${k}"><i></i>${mc[k]}</span>`)}</span></div>
              ${monthGrid(y, m, days)}`;
            return list.length
              ? html`<button type="button" class="card assenze-month pressable${current ? " is-current" : ""}" data-month="${y}-${m}" aria-label="${MONTHS[m]} ${y}: ${countsLine(mc)}">${inner}</button>`
              : html`<div class="card assenze-month${future ? " is-future" : ""}${current ? " is-current" : ""}">${inner}</div>`;
          })}</div>
        </section>

        <section class="section">
          <div class="section-head assenze-histhead"><p class="overline">Cronologia</p>
            ${segmented("assenze-filter", [{ value: "all", label: "Tutto" }, { value: "abs", label: "Assenze" }, { value: "late", label: "Ritardi" }, { value: "exit", label: "Uscite" }], filter)}</div>
          <div data-history>${historyHTML(groups)}</div>
        </section>`);

      bindSegmented(body, "assenze-filter", (v) => {
        filter = v;
        const rs = mergeRuns(filter === "all" ? events : events.filter((e) => typeOf(e).k === filter));
        const gs = [];
        rs.forEach((r) => {
          const d = parseDate(r.events[0].evtDate);
          const k = `${d.getFullYear()}-${d.getMonth()}`;
          let g = gs.find((x) => x.k === k);
          if (!g) gs.push((g = { k, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, runs: [] }));
          g.runs.push(r);
        });
        setHTML($("[data-history]", body), historyHTML(gs));
      });
      // Il mese corrente resta in vista nella striscia scorrevole (mobile).
      const strip = $("[data-months]", body);
      const cur = $(".assenze-month.is-current", strip) || $$(".assenze-month:not(.is-future)", strip).pop();
      if (strip && cur && strip.scrollWidth > strip.clientWidth) {
        strip.scrollLeft = Math.max(0, cur.offsetLeft + cur.offsetWidth - strip.clientWidth + 24);
      }
    };
    /* ----- ore di assenza (contatore) ----- */
    const hoursCard = () => {
      if (modelState === "loading") {
        return html`<section class="card card-pad section assenze-hours-card"><p class="overline">Ore di assenza</p>
          <div class="skeleton" style="height:44px;width:40%;margin-top:12px"></div><div class="skeleton-line" style="width:70%;margin-top:14px"></div></section>`;
      }
      const by = { abs: 0, late: 0, exit: 0 };
      let estimated = false;
      events.forEach((e) => {
        const x = eventHours(e, model);
        const k = typeOf(e).k;
        if (k in by) by[k] += x.hours;
        if (x.source === "weekly" || x.source === "default") estimated = estimated || x.hours > 0;
      });
      const total = by.abs + by.late + by.exit;
      const today = isoDay(new Date());
      let held = 0;
      model?.perDay.forEach((set, k) => { if (k <= today) held += set.size; });
      const weeklyHours = [1, 2, 3, 4, 5, 6].reduce((s2, d) => s2 + (model?.weekly.get(d) || 0), 0);
      const yearly = weeklyHours * SCHOOL_WEEKS;
      const limit = Math.round(yearly * MAX_ABSENCE_SHARE);
      const share = held ? total / held : null;
      const usedOfLimit = limit ? Math.min(1, total / limit) : null;
      const pattern = [1, 2, 3, 4, 5, 6].filter((d) => model?.weekly.get(d)).map((d) => `${DOW_SHORT[d]} ${model.weekly.get(d)}`).join(" · ");
      const tone = usedOfLimit === null ? "" : usedOfLimit >= 0.8 ? " is-bad" : usedOfLimit >= 0.5 ? " is-warn" : "";
      return html`<section class="card card-pad section assenze-hours-card${tone}">
        <div class="spread"><p class="overline">Ore di assenza</p>${estimated || modelState === "none" ? html`<span class="chip">stima</span>` : ""}</div>
        <div class="assenze-hours-main">
          <p class="stat-num tnum">${fmtNum(total, 0)}</p>
          <div><p class="title-3">${total === 1 ? "ora di lezione persa" : "ore di lezione perse"}</p>
            <p class="caption">${[by.abs && `${hoursText(by.abs)} di assenze`, by.late && `${hoursText(by.late)} di ritardi`, by.exit && `${hoursText(by.exit)} di uscite`].filter(Boolean).join(" · ") || "nessuna ora persa"}</p></div>
        </div>
        ${usedOfLimit !== null ? html`<div class="assenze-limit" role="img" aria-label="${Math.round(usedOfLimit * 100)}% del limite di assenze">
          <div class="bar"><span style="width:${Math.max(2, usedOfLimit * 100)}%"></span></div>
          <p class="caption">${share !== null ? html`${fmtNum(share * 100, 1)}% delle ${fmtNum(held, 0)} ore di lezione finora. ` : ""}Per la validità dell'anno puoi mancare al massimo il 25% delle ore: circa <strong>${fmtNum(limit, 0)}</strong> su ${fmtNum(yearly, 0)}${limit > total ? html`, te ne restano circa <strong>${fmtNum(limit - total, 0)}</strong>` : html`: <strong>limite raggiunto</strong>, parlane con la scuola`}.</p>
        </div>` : ""}
        <p class="caption faint assenze-pattern">${modelState === "ok" && pattern
          ? html`${icon("clock")}Orario della classe, dalle lezioni registrate: ${pattern} ore.`
          : html`${icon("info")}Orario della classe non disponibile: ogni giornata è contata ${DEFAULT_DAY_HOURS} ore.`}</p>
      </section>`;
    };

    /** Lezioni dell'anno (dal 1° settembre a oggi): una richiesta sola, a mesi se il registro la rifiuta. */
    const loadModel = async () => {
      const y0 = schoolYearStart();
      const start = new Date(y0, 8, 1);
      const end = new Date(Math.min(Date.now(), new Date(y0 + 1, 7, 31).getTime()));
      if (end < start) { model = lessonModel([]); modelState = "none"; return; }
      const fmt = (d) => ymd(d).replace(/-/g, "");
      const fetchRange = (a, b) => load(`lezioni:${fmt(a)}:${fmt(b)}`, () => get(`/lezioni?start=${fmt(a)}&end=${fmt(b)}`), () => {}, { maxAge: 30 * 60_000 });
      let lessons = [];
      try {
        lessons = (await fetchRange(start, end))?.lessons || [];
      } catch {
        for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
          const last = new Date(Math.min(end.getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime()));
          try { lessons = lessons.concat((await fetchRange(d, last))?.lessons || []); } catch { /* mese non disponibile */ }
        }
      }
      model = lessonModel(lessons);
      modelState = model.known ? "ok" : "none";
    };

    const historyHTML = (groups) => (groups.length ? html`${groups.map((g) => html`<p class="overline assenze-monthlabel">${g.label}</p><ul class="card list">${g.runs.map(rowHTML)}</ul>`)}`
      : html`<div class="card">${emptyState({ iconName: "check", title: "Niente da mostrare", text: "Nessun evento di questo tipo nell'anno." })}</div>`);
    const snapshotChip = () => html`<p class="chip chip-accent assenze-snap">${icon("history")}Dati salvati per l'${yearLabel().replace(/^A\.S\./, "anno")}</p>`;

    body.addEventListener("click", (e) => {
      const m = e.target.closest("[data-month]");
      if (m) { const [y, mo] = m.dataset.month.split("-").map(Number); monthSheet(y, mo); return; }
      const r = e.target.closest("[data-day]");
      if (r) daySheet(r.dataset.day);
    });

    const skeleton = body.innerHTML;
    let first = true;
    const fetchData = async () => {
      empty404 = false;
      const year = state.year;
      if (!first) body.innerHTML = skeleton;
      first = false;
      try {
        await load(`assenze:${year}`, () => post(`/assenze?${yearQuery()}`), (data) => {
          if (year !== state.year) return;
          const list = data?.assenze?.events || data?.events || [];
          events = (Array.isArray(list) ? list : []).filter((e) => parseDate(e.evtDate));
          snapshot = !!data?.from_snapshot;
          draw();
        }, { maxAge: 120_000 });
      } catch (err) {
        if (year !== state.year) return;
        if (err.status === 404) { events = []; empty404 = true; draw(); return; }
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", fetchData);
      }
    };
    await fetchData();
    const refreshModel = () => {
      modelState = "loading";
      loadModel().catch(() => { model = lessonModel([]); modelState = "none"; }).then(() => { if (root.isConnected) draw(); });
    };
    refreshModel();
    const offYear = on("year", () => refreshModel());
    const offTitle = on("year", () => {
      const span = $("[data-year-picker] span", root);
      if (span) span.textContent = yearLabel();
    });
    return () => { offYear(); offTitle(); };
  },
};
