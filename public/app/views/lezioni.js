// Lezioni: argomenti del giorno (striscia settimana + filtro materia) e, per materia,
// gli ultimi argomenti trattati nelle ultime 4 settimane.
import { get, load } from "aulera/api";
import { store } from "aulera/state";
import {
  html, raw, icon, setHTML, $, segmented, bindSegmented, emptyState, errorState,
  fmtDate, relativeDay, parseDate, ymd, addDays, startOfWeek, sameDay, DAY_SHORT, subjectName, personName,
} from "aulera/ui";
import { pageHeader } from "aulera/main";

/* ---------------- date ---------------- */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const monthLong = (d) => cap(d.toLocaleDateString("it-IT", { month: "long" }));
const today0 = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
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

/* ---------------- striscia settimana (copia da agenda.js, stesse classi CSS) ---------------- */
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
          aria-selected="${String(sel)}" tabindex="${sel ? "0" : "-1"}" data-date="${ymd(d)}" aria-label="${fmtDate(d, { weekday: true })}${dots.length ? ", con lezioni" : ""}">
          <span class="agenda-day-name">${DAY_SHORT[d.getDay()]}</span>
          <span class="agenda-day-num tnum">${d.getDate()}</span>
          <span class="agenda-day-dots" aria-hidden="true">${dots.slice(0, 3).map((c) => html`<i style="--k:${raw(c)}"></i>`)}</span>
        </button>`;
      })}
    </div>`;
}
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

/* ---------------- materie e colori (stessa logica dell'orario) ---------------- */
const SUBJECT_KEYS = [
  [/^SOS\b|SOSTEGNO/, "sos"], [/ALTERNATIV/, "alt"], [/EDUCAZIONE CIVICA|^ED\.? ?CIV/, "civ"], [/STORIA DELL.?ARTE|DISEGNO|^ARTE/, "art"],
  [/^TPS|TECNOLOGIE E PROG|PROGETTAZIONE DI SISTEMI/, "tps"], [/^GPO|GESTIONE PROGETTO|GESTIONE DEL PROGETTO/, "gpo"],
  [/TECNOLOGIE INFORMATICHE|^TIC\b/, "tic"], [/RAPPRESENTAZIONE GRAFICA|^TTRG/, "ttr"], [/SCIENZE E TECNOLOGIE APPLICATE|^STA\b/, "sta"],
  [/MOTORI|EDUCAZIONE FISICA|^ED\.? ?FIS|^SC\.? ?MOT/, "mot"], [/MATEMAT|^MATE?\b/, "mat"], [/ITALIAN|^LETTERE|^ITA\b/, "ita"],
  [/INGLES|^ENGLISH|^INGL?\b/, "ing"], [/SPAGNOL/, "spa"], [/FRANCES/, "fra"], [/TEDESC/, "ted"], [/LATIN/, "lat"], [/GREC/, "gre"],
  [/STORIA|^STO\b/, "sto"], [/FILOSOF/, "fil"], [/SISTEM/, "sis"], [/INFORMAT/, "inf"], [/TELECOMUNIC/, "tlc"], [/ELETTROTEC/, "elt"],
  [/ELETTRON/, "eln"], [/AUTOMAZ/, "aut"], [/MECCANIC/, "mec"], [/RELIGION|^IRC\b|^REL\b/, "rel"], [/FISICA/, "fis"], [/CHIMIC/, "chi"],
  [/BIOLOG|SCIENZE NATURALI|SCIENZE DELLA TERRA|SCIENZE INTEGRATE/, "sci"], [/GEOGRAF/, "geo"], [/DIRITTO/, "dir"], [/ECONOMI/, "eco"],
  [/MUSIC/, "mus"], [/LABORATORI|^LAB\b/, "lab"],
];
const normSubject = (s) => String(s || "").trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
function colorKey(desc) {
  const up = normSubject(desc);
  const hit = SUBJECT_KEYS.find(([re]) => re.test(up));
  return hit ? hit[1] : up.toLowerCase();
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
let colorMap = new Map();
function assignColors(descs) {
  const out = new Map(), taken = new Set();
  [...new Set(descs.map(colorKey))].filter((k) => k !== "sos").sort().forEach((k) => {
    let i = hash(k) % 12, n = 0;
    while (taken.has(i) && n < 12) { i = (i + 1) % 12; n++; }
    taken.add(i);
    out.set(k, i);
  });
  colorMap = out;
}
const colorOf = (desc) => {
  const k = colorKey(desc);
  if (k === "sos") return "var(--text-3)";
  return `var(--reg-c${colorMap.has(k) ? colorMap.get(k) : hash(k) % 12})`;
};

/* ---------------- lezioni ---------------- */
const hourText = (g) => (g.from ? (g.to > g.from ? `${g.from}ª–${g.to}ª ora` : `${g.from}ª ora`) : "");
const isPlainType = (t) => !t || /^lezione$/i.test(String(t).trim());
/** Unisce ore consecutive della stessa materia/argomento e le compresenze nella stessa ora. */
function groupLessons(lessons) {
  const sorted = lessons.slice().sort((a, b) => (Number(a.evtHPos) || 0) - (Number(b.evtHPos) || 0));
  const out = [];
  sorted.forEach((l) => {
    const key = normSubject(l.subjectDesc);
    const h = Number(l.evtHPos) || 0;
    const dur = Math.max(1, Math.round(Number(l.evtDuration) || 1));
    const arg = String(l.lessonArg || "").trim();
    const teacher = l.authorName ? personName(l.authorName) : "";
    const same = out.find((g) => g.key === key && h >= g.from && h <= g.to);
    const last = out[out.length - 1];
    const target = same || (last && last.key === key && h === last.to + 1 && (!arg || !last.args.length || last.args.includes(arg)) ? last : null);
    if (target) {
      target.to = Math.max(target.to, h + dur - 1);
      if (teacher && !target.teachers.includes(teacher)) target.teachers.push(teacher);
      if (arg && !target.args.includes(arg)) target.args.push(arg);
      if (!isPlainType(l.lessonType) && !target.types.includes(l.lessonType)) target.types.push(l.lessonType);
      return;
    }
    out.push({ key, desc: l.subjectDesc, date: l.evtDate, from: h, to: h + dur - 1, args: arg ? [arg] : [], teachers: teacher ? [teacher] : [], types: isPlainType(l.lessonType) ? [] : [l.lessonType], type: l.lessonType || "" });
  });
  return out;
}
const lessonDay = (l) => String(l.evtDate || "").slice(0, 10).replace(/-/g, "");

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    let mode = ctx.params.get("materia") ? "subject" : store.get("lezioni:mode", "day") === "subject" ? "subject" : "day";
    let weekStart = startOfWeek(new Date());
    let selected = today0();
    let filter = ctx.params.get("materia") ? normSubject(ctx.params.get("materia")) : null; // chiave materia
    const weeks = new Map(); // ymd(lunedì) -> lessons[] | {error}
    let recent = null; // ultime 4 settimane: lessons[] | {error}
    let alive = true;
    const rStart = addDays(today0(), -27), rEnd = today0();

    setHTML(root, html`${pageHeader({ eyebrow: "Registro", title: "Lezioni" })}
      <div class="agenda-toolbar">${segmented("lezioni-mode", [{ value: "day", label: "Giorno" }, { value: "subject", label: "Per materia" }], mode)}</div>
      <div data-pane></div>`);
    const pane = $("[data-pane]", root);
    bindSegmented(root, "lezioni-mode", (v) => { mode = v; store.set("lezioni:mode", v); mountPane(); });

    const weekKey = (ws) => ymd(ws);
    const lessonsOf = (ws) => { const w = weeks.get(weekKey(ws)); return Array.isArray(w) ? w : []; };
    const subjectsFrom = (list) => {
      const m = new Map();
      list.forEach((l) => { const k = normSubject(l.subjectDesc); if (!k) return; const e = m.get(k) || { key: k, desc: l.subjectDesc, n: 0, last: "" }; e.n++; if (lessonDay(l) > e.last) e.last = lessonDay(l); m.set(k, e); });
      return [...m.values()];
    };
    const chipsHTML = (subjects, { all = true } = {}) => html`<div class="lezioni-chips" role="toolbar" aria-label="Filtra per materia" data-chips>
      ${all ? html`<button type="button" class="lezioni-chip${!filter ? " is-active" : ""}" data-subject="" aria-pressed="${String(!filter)}">Tutte</button>` : ""}
      ${subjects.map((s) => html`<button type="button" class="lezioni-chip${filter === s.key ? " is-active" : ""}" data-subject="${s.key}" aria-pressed="${String(filter === s.key)}" style="--c:${raw(colorOf(s.desc))}"><i aria-hidden="true"></i>${subjectName(s.desc)}</button>`)}
    </div>`;
    const keepChipInView = () => {
      const row = $("[data-chips]", pane);
      const act = row && $(".lezioni-chip.is-active", row);
      if (row && act && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, act.offsetLeft - 16);
    };

    /* ----- Giorno ----- */
    const dotsFor = (d) => {
      const ls = lessonsOf(startOfWeek(d)).filter((l) => lessonDay(l) === ymd(d) && (!filter || normSubject(l.subjectDesc) === filter));
      if (!ls.length) return [];
      return filter ? [colorOf(ls[0].subjectDesc)] : ["var(--text-3)"];
    };
    const drawStrip = (dir = "") => { const el = $("[data-weekcard]", pane); if (el) setHTML(el, weekStrip(weekStart, selected, dotsFor, dir)); };
    const drawChipsDay = () => {
      const el = $("[data-chipwrap]", pane);
      if (!el) return;
      const subs = subjectsFrom([...lessonsOf(weekStart), ...(Array.isArray(recent) ? recent : [])]).sort((a, b) => b.n - a.n);
      if (filter && !subs.some((s) => s.key === filter)) subs.unshift({ key: filter, desc: filter, n: 0 });
      setHTML(el, subs.length ? chipsHTML(subs) : "");
      keepChipInView();
    };
    const drawDayList = () => {
      const el = $("[data-daylist]", pane);
      if (!el) return;
      const w = weeks.get(weekKey(weekStart));
      const rel = relativeDay(selected);
      const head = html`<div class="section-head agenda-dayhead"><p class="title-2">${cap(fmtDate(selected, { weekday: true }))}</p>
        ${rel === "Oggi" || rel === "Ieri" || rel === "Domani" ? html`<span class="chip ${rel === "Oggi" ? "chip-accent" : ""}">${rel}</span>` : ""}</div>`;
      if (w === undefined) {
        setHTML(el, html`${head}<div class="card list">${[0, 1, 2].map(() => html`<div class="row"><div class="skeleton" style="width:34px;height:34px;border-radius:10px"></div>
          <div class="row-main stack-sm"><div class="skeleton-line" style="width:35%"></div><div class="skeleton-line" style="width:80%;height:11px"></div></div></div>`)}</div>`);
        return;
      }
      if (w?.error) {
        setHTML(el, html`${head}${errorState(w.error)}`);
        $("[data-retry]", el)?.addEventListener("click", () => { weeks.delete(weekKey(weekStart)); drawDay(); fetchWeek(weekStart); });
        return;
      }
      const all = w.filter((l) => lessonDay(l) === ymd(selected));
      const shown = filter ? all.filter((l) => normSubject(l.subjectDesc) === filter) : all;
      if (!shown.length) {
        const weekend = selected.getDay() === 0 || selected.getDay() === 6;
        const future = selected > today0();
        const fname = filter ? subjectName(subjectsFrom([...w, ...(Array.isArray(recent) ? recent : [])]).find((s) => s.key === filter)?.desc || filter) : "";
        setHTML(el, html`${head}<div class="card agenda-empty">${filter && all.length
          ? emptyState({ iconName: "lessons", title: `Niente ${fname.toLowerCase()} in questo giorno`, text: `Ci sono altre ${all.length} lezioni registrate.` })
          : emptyState({
            iconName: "lessons",
            title: weekend && !all.length ? "Nessuna lezione nel weekend" : future ? "Lezioni non ancora firmate" : "Nessuna lezione registrata",
            text: future ? "Gli argomenti compaiono qui quando i docenti firmano il registro." : weekend ? "Goditi la pausa." : "In questo giorno il registro non riporta lezioni.",
          })}${filter && all.length ? html`<button type="button" class="btn agenda-jump" data-subject="">Mostra tutte le lezioni</button>` : ""}</div>`);
        return;
      }
      const groups = groupLessons(shown);
      setHTML(el, html`${head}<ul class="card list lezioni-list">${groups.map((g) => html`<li><button type="button" class="row lezioni-item" data-open="${g.key}" style="--c:${raw(colorOf(g.desc))}">
          <span class="lezioni-hour tnum"><span>${g.from ? `${g.from}ª` : "–"}</span>${g.to > g.from ? html`<small>${g.to}ª</small>` : ""}</span>
          <span class="row-main lezioni-main">
            <span class="lezioni-subj"><i aria-hidden="true"></i>${subjectName(g.desc)}${g.types.map((t) => html`<span class="chip chip-accent lezioni-type">${t}</span>`)}</span>
            ${g.args.length ? g.args.map((a) => html`<span class="lezioni-arg">${a}</span>`) : html`<span class="lezioni-arg is-empty">Argomento non indicato</span>`}
            <span class="row-sub">${[g.teachers.join(", "), isPlainType(g.type) ? (g.type || "") : ""].filter(Boolean).join(" · ")}</span>
          </span>${icon("chevronRight", "chev")}
        </button></li>`)}</ul>`);
    };
    const drawWeekSummary = () => {
      const el = $("[data-weeklist]", pane);
      if (!el) return;
      const w = weeks.get(weekKey(weekStart));
      if (!Array.isArray(w) || !w.length) { setHTML(el, ""); return; }
      const subs = subjectsFrom(w).sort((a, b) => b.n - a.n);
      const total = groupLessons(w).length ? w.reduce((s, l) => s + Math.max(1, Math.round(Number(l.evtDuration) || 1)), 0) : 0;
      setHTML(el, html`<div class="section-head"><p class="overline">In settimana</p><p class="caption tnum">${total} ${total === 1 ? "ora" : "ore"} firmate</p></div>
        <ul class="card list lezioni-weeksum">${subs.map((s) => html`<li><button type="button" class="row" data-open="${s.key}" style="--c:${raw(colorOf(s.desc))}">
          <i class="lezioni-dot" aria-hidden="true"></i><span class="row-main"><span class="row-title">${subjectName(s.desc)}</span></span>
          <span class="row-trail tnum">${s.n} h${icon("chevronRight", "chev")}</span></button></li>`)}</ul>`);
    };
    const drawDay = (dir = "") => { drawStrip(dir); drawChipsDay(); drawDayList(); drawWeekSummary(); };

    const fetchWeek = (ws) => {
      const s = ymd(ws), e = ymd(addDays(ws, 6));
      const key = weekKey(ws);
      return load(`lezioni:${s}:${e}`, () => get(`/lezioni?start=${s}&end=${e}`), (data) => {
        weeks.set(key, Array.isArray(data?.lessons) ? data.lessons : []);
        if (alive && mode === "day" && key === weekKey(weekStart)) drawDay();
      }, { maxAge: 5 * 60_000 }).catch((err) => {
        if (Array.isArray(weeks.get(key))) return;
        weeks.set(key, { error: err });
        if (alive && mode === "day" && key === weekKey(weekStart)) drawDay();
      });
    };
    const goWeek = (ws, sel, dir) => {
      weekStart = ws;
      selected = sel;
      if (weeks.get(weekKey(ws))?.error) weeks.delete(weekKey(ws));
      drawDay(dir);
      fetchWeek(ws);
    };

    const mountDay = () => {
      setHTML(pane, html`<section class="card agenda-weekcard" data-weekcard></section>
        <div class="lezioni-chipwrap" data-chipwrap></div>
        <div class="agenda-cols lezioni-cols"><section data-daylist></section><aside data-weeklist></aside></div>`);
      bindWeekStrip($("[data-weekcard]", pane), {
        onWeek: (w) => {
          const thisWeek = startOfWeek(new Date());
          if (w === "today") return goWeek(thisWeek, today0(), sameDay(weekStart, thisWeek) ? "" : weekStart > thisWeek ? "left" : "right");
          const n = Number(w);
          const ws = addDays(weekStart, 7 * n);
          goWeek(ws, sameDay(ws, thisWeek) ? today0() : addDays(selected, 7 * n), n > 0 ? "right" : "left");
        },
        onDay: (d, focus) => {
          if (!sameDay(startOfWeek(d), weekStart)) goWeek(startOfWeek(d), d, d > weekStart ? "right" : "left");
          else { selected = d; drawStrip(); drawDayList(); }
          if (focus) $(`[data-date="${ymd(d)}"]`, pane)?.focus();
        },
      });
      drawDay();
      fetchWeek(weekStart);
    };

    /* ----- Per materia ----- */
    const drawSubject = () => {
      if (mode !== "subject") return;
      if (recent === null) {
        setHTML(pane, html`<div class="lezioni-chips">${[0, 1, 2, 3].map(() => html`<span class="skeleton" style="width:96px;height:38px;border-radius:999px;flex:none"></span>`)}</div>
          <div class="card card-pad" style="margin-top:16px"><div class="skeleton-line" style="width:40%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>`);
        return;
      }
      if (recent?.error) {
        setHTML(pane, errorState(recent.error));
        $("[data-retry]", pane)?.addEventListener("click", () => { recent = null; drawSubject(); fetchRecent(); });
        return;
      }
      const subs = subjectsFrom(recent).sort((a, b) => b.n - a.n || a.desc.localeCompare(b.desc));
      if (!subs.length) {
        setHTML(pane, html`<div class="card">${emptyState({ iconName: "lessons", title: "Nessuna lezione recente", text: "Nelle ultime 4 settimane il registro non riporta lezioni." })}</div>`);
        return;
      }
      if (!filter || !subs.some((s) => s.key === filter)) {
        filter = filter && !subs.some((s) => s.key === filter) ? filter : subs.slice().sort((a, b) => b.last.localeCompare(a.last))[0].key;
      }
      const cur = subs.find((s) => s.key === filter);
      const list = recent.filter((l) => normSubject(l.subjectDesc) === filter);
      const byDate = new Map();
      list.forEach((l) => { const k = lessonDay(l); if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(l); });
      const days = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
      const hours = list.reduce((s, l) => s + Math.max(1, Math.round(Number(l.evtDuration) || 1)), 0);
      const teachers = [...new Set(list.map((l) => l.authorName).filter(Boolean).map(personName))];
      const withArg = list.filter((l) => String(l.lessonArg || "").trim()).length;
      // Gruppi per settimana
      const weeksG = [];
      days.forEach(([k, ls]) => {
        const ws = startOfWeek(parseDate(k));
        let g = weeksG.find((x) => sameDay(x.ws, ws));
        if (!g) weeksG.push((g = { ws, days: [] }));
        g.days.push([k, ls]);
      });
      setHTML(pane, html`${chipsHTML(subs, { all: false })}
        ${cur ? html`<section class="card card-pad lezioni-subjcard" style="--c:${raw(colorOf(cur.desc))}">
          <div class="lezioni-subjhead"><span class="lezioni-subjbadge" aria-hidden="true">${icon("lessons")}</span>
            <div class="row-main"><p class="title-2">${subjectName(cur.desc)}</p><p class="body-2">${teachers.join(", ") || "Docente non indicato"}</p></div></div>
          <div class="stats-row cols-3 lezioni-stats">
            <div class="stat"><span class="stat-num">${hours}</span><span class="stat-label">${hours === 1 ? "ora firmata" : "ore firmate"}</span></div>
            <div class="stat"><span class="stat-num">${withArg}</span><span class="stat-label">con argomento</span></div>
            <div class="stat"><span class="stat-num lezioni-last">${days.length ? relativeDay(parseDate(days[0][0])) : "—"}</span><span class="stat-label">ultima lezione</span></div>
          </div>
        </section>` : ""}
        ${weeksG.map((g) => html`<p class="overline lezioni-weeklabel">${weekRelative(g.ws)} <span class="faint">· ${fmtDate(g.ws)} – ${fmtDate(addDays(g.ws, 6))}</span></p>
          <ul class="card list lezioni-hist" style="--c:${raw(colorOf(cur.desc))}">${g.days.map(([k, ls]) => {
            const d = parseDate(k);
            const groups = groupLessons(ls);
            return html`<li class="row lezioni-histrow">
              <span class="lezioni-date"><small>${DAY_SHORT[d.getDay()]}</small><span class="tnum">${d.getDate()}</span></span>
              <div class="row-main stack-sm">${groups.map((gr) => html`<div>
                ${gr.args.length ? gr.args.map((a) => html`<p class="lezioni-arg">${a}</p>`) : html`<p class="lezioni-arg is-empty">Argomento non indicato</p>`}
                <p class="row-sub">${[hourText(gr), gr.teachers.join(", "), ...(gr.types.length ? gr.types : [])].filter(Boolean).join(" · ")}</p></div>`)}</div>
            </li>`;
          })}</ul>`)}`);
      keepChipInView();
    };
    const fetchRecent = () => {
      const s = ymd(rStart), e = ymd(rEnd);
      return load(`lezioni:${s}:${e}`, () => get(`/lezioni?start=${s}&end=${e}`), (data) => {
        recent = Array.isArray(data?.lessons) ? data.lessons : [];
        assignColors(recent.map((l) => l.subjectDesc));
        if (!alive) return;
        if (mode === "subject") drawSubject(); else { drawChipsDay(); drawDayList(); drawWeekSummary(); drawStrip(); }
      }, { maxAge: 10 * 60_000 }).catch((err) => {
        if (Array.isArray(recent)) return;
        recent = { error: err };
        if (alive && mode === "subject") drawSubject();
      });
    };

    /* ----- eventi ----- */
    pane.addEventListener("click", (e) => {
      const c = e.target.closest("[data-subject]");
      if (c) {
        const k = c.dataset.subject || null;
        if (mode === "subject") { if (k && k !== filter) { filter = k; drawSubject(); } return; }
        filter = filter === k ? null : k;
        drawStrip(); drawChipsDay(); drawDayList();
        return;
      }
      const o = e.target.closest("[data-open]");
      if (o) {
        filter = o.dataset.open;
        mode = "subject";
        store.set("lezioni:mode", mode);
        const seg = $('[data-seg="lezioni-mode"] button[data-value="subject"]', root);
        seg?.click();
        if (!seg) mountPane();
      }
    });

    const mountPane = () => {
      if (mode === "day") mountDay();
      else { drawSubject(); }
      if (recent === null || recent?.error) { if (recent?.error) recent = null; fetchRecent(); }
      window.scrollTo({ top: 0 });
    };
    mountPane();
    return () => { alive = false; };
  },
};
