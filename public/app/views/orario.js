// Orario: settimana compatta in una schermata (ore × giorni, materie abbreviate e colorate,
// ora in corso evidenziata) o vista "Giorno". Fonte: orario ufficiale Marconi oppure
// ricostruzione dalle lezioni firmate delle ultime settimane.
import { get, load } from "aulera/api";
import { state, store, isMarconi } from "aulera/state";
import {
  html, raw, icon, setHTML, $, segmented, bindSegmented, openSheet, emptyState, errorState,
  fmtDate, parseDate, ymd, addDays, startOfWeek, subjectName, personName, titleCase,
} from "aulera/ui";
import { pageHeader } from "aulera/main";

const DAY_NAMES = ["", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const DAY_ABBR = ["", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
const MARCONI_BELLS = {
  1: ["08:00", "08:50"], 2: ["08:50", "09:40"], 3: ["09:50", "10:50"], 4: ["10:50", "11:45"],
  5: ["12:00", "12:50"], 6: ["12:50", "13:40"], 7: ["13:40", "14:30"],
};
const PALETTE = 12;

/* ---------------- materie: abbreviazioni intelligenti ---------------- */
// [regola, breve, nome esteso, chiave colore]. L'ordine conta: prima le più specifiche.
const SUBJECTS = [
  [/^SOS\b|SOSTEGNO/, "Sost", "Sostegno", "sos"],
  [/ALTERNATIV/, "Alt", "Attività alternativa", "alt"],
  [/EDUCAZIONE CIVICA|^ED\.? ?CIV/, "Civica", "Educazione civica", "civ"],
  [/STORIA DELL.?ARTE|DISEGNO|^ARTE/, "Arte", "Disegno e storia dell'arte", "art"],
  [/^TPS|TECNOLOGIE E PROG|PROGETTAZIONE DI SISTEMI/, "TPSIT", "Tecnologie e progettazione di sistemi", "tps"],
  [/^GPO|GESTIONE PROGETTO|GESTIONE DEL PROGETTO/, "GPOI", "Gestione progetto e organizzazione d'impresa", "gpo"],
  [/TECNOLOGIE INFORMATICHE|^TIC\b/, "TIC", "Tecnologie informatiche", "tic"],
  [/RAPPRESENTAZIONE GRAFICA|^TTRG/, "TTRG", "Tecnologie e tecniche di rappresentazione grafica", "ttr"],
  [/SCIENZE E TECNOLOGIE APPLICATE|^STA\b/, "STA", "Scienze e tecnologie applicate", "sta"],
  [/MOTORI|EDUCAZIONE FISICA|^ED\.? ?FIS|^SC\.? ?MOT/, "Motor", "Scienze motorie", "mot"],
  [/MATEMAT|^MATE?\b/, "Mat", "Matematica", "mat"],
  [/ITALIAN|^LETTERE|^ITA\b/, "Ita", "Italiano", "ita"],
  [/INGLES|^ENGLISH|^INGL?\b/, "Ingl", "Inglese", "ing"],
  [/SPAGNOL/, "Spa", "Spagnolo", "spa"],
  [/FRANCES/, "Fra", "Francese", "fra"],
  [/TEDESC/, "Ted", "Tedesco", "ted"],
  [/LATIN/, "Lat", "Latino", "lat"],
  [/GREC/, "Greco", "Greco", "gre"],
  [/STORIA|^STO\b/, "Storia", "Storia", "sto"],
  [/FILOSOF/, "Filo", "Filosofia", "fil"],
  [/SISTEM/, "Sist", "Sistemi e reti", "sis"],
  [/INFORMAT/, "Info", "Informatica", "inf"],
  [/TELECOMUNIC/, "Tlc", "Telecomunicazioni", "tlc"],
  [/ELETTROTEC/, "Eltec", "Elettrotecnica", "elt"],
  [/ELETTRON/, "Eltr", "Elettronica", "eln"],
  [/AUTOMAZ/, "Autom", "Automazione", "aut"],
  [/MECCANIC/, "Mecc", "Meccanica", "mec"],
  [/RELIGION|^IRC\b|^REL\b/, "Rel", "Religione", "rel"],
  [/FISICA/, "Fis", "Fisica", "fis"],
  [/CHIMIC/, "Chim", "Chimica", "chi"],
  [/BIOLOG|SCIENZE NATURALI|SCIENZE DELLA TERRA|SCIENZE INTEGRATE/, "Sci", "Scienze", "sci"],
  [/GEOGRAF/, "Geo", "Geografia", "geo"],
  [/DIRITTO/, "Dir", "Diritto ed economia", "dir"],
  [/ECONOMI/, "Eco", "Economia", "eco"],
  [/MUSIC/, "Musica", "Musica", "mus"],
  [/LABORATORI|^LAB\b/, "Lab", "Laboratorio", "lab"],
];
const SMALL = new Set(["E", "ED", "DI", "DEL", "DELLA", "DEI", "DELLE", "DEGLI", "DA", "A", "AL", "IN", "CON", "PER", "IL", "LA", "LE", "LO", "GLI", "I", "D", "L"]);
const subjCache = new Map();
/** { key, short, full } da un nome di materia del registro o del Marconi. */
function subjectInfo(rawName) {
  const name = String(rawName || "").trim();
  if (subjCache.has(name)) return subjCache.get(name);
  const up = name.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
  let out = null;
  for (const [re, short, full, key] of SUBJECTS) {
    if (re.test(up)) {
      // Se il registro dà il nome completo lo usiamo; se è un codice/troncato usiamo quello esteso.
      const words = up.split(" ").length;
      out = { key, short, full: words >= 2 && name.length > full.length - 4 ? subjectName(name) : full };
      break;
    }
  }
  if (!out) {
    const words = up.replace(/[^A-Z0-9' ]/g, " ").split(" ").filter((w) => w && !SMALL.has(w));
    let short;
    if (!words.length) short = name.slice(0, 5);
    else if (words.length >= 3) short = words.slice(0, 4).map((w) => w[0]).join("");
    else if (words[0].length <= 5) short = words[0].length <= 4 && /^[A-Z]+$/.test(name) && words.length === 1 ? words[0] : titleCase(words[0]);
    else short = `${titleCase(words[0]).slice(0, 4)}.`;
    out = { key: up.toLowerCase(), short, full: subjectName(name) };
  }
  subjCache.set(name, out);
  return out;
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
/** Colori unici per materia nello stesso orario (partendo dall'hash: stabili tra le viste). */
function assignColors(keys) {
  const out = new Map(), taken = new Set();
  [...new Set(keys)].filter((k) => k !== "sos").sort().forEach((k) => {
    let i = hash(k) % PALETTE, n = 0;
    while (taken.has(i) && n < PALETTE) { i = (i + 1) % PALETTE; n++; }
    taken.add(i);
    out.set(k, i);
  });
  return out;
}
const colorVar = (model, key) => (key === "sos" || !model.colors.has(key) ? "var(--text-3)" : `var(--reg-c${model.colors.get(key)})`);

/* ---------------- classi Marconi ---------------- */
function normClasses(meta) {
  const list = Array.isArray(meta?.classes) ? meta.classes : Array.isArray(meta) ? meta : [];
  const names = list.map((c) => (typeof c === "string" ? c : c?.name || c?.classe || c?.class || c?.code || c?.nome || ""))
    .map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
}
/** "5EI INFORMATICA" → "5EI"; tollera spazi e suffissi. */
function matchClass(classes, code) {
  const raw0 = String(code || "").toUpperCase().trim();
  if (!raw0 || !classes.length) return null;
  const token = raw0.split(/[\s\-_/.]+/)[0].replace(/[^A-Z0-9]/g, "");
  const compact = raw0.replace(/[^A-Z0-9]/g, "");
  const exact = classes.find((c) => c === token) || classes.find((c) => c === compact);
  if (exact) return exact;
  const prefix = classes.filter((c) => /\d/.test(c) && c.length >= 2 && compact.startsWith(c)).sort((a, b) => b.length - a.length)[0];
  return prefix || classes.find((c) => token && c.startsWith(token)) || null;
}

/* ---------------- modello comune ---------------- */
function fromMarconi(entries) {
  const cells = new Map();
  (entries || []).forEach((r) => {
    const giorno = Number(r.giorno ?? r["3"]), ora = Number(r.ora ?? r["4"]);
    const materia = String(r.materia ?? r["1"] ?? "").trim();
    const aula = String(r.aula ?? r["2"] ?? "").trim();
    if (!(giorno >= 1 && giorno <= 6 && ora >= 1 && ora <= 12 && materia)) return;
    const k = `${giorno}:${ora}`;
    if (!cells.has(k)) cells.set(k, { day: giorno, hour: ora, items: [] });
    const subj = subjectInfo(materia);
    const cell = cells.get(k);
    if (!cell.items.some((i) => i.subj.key === subj.key && i.aula === aula)) cell.items.push({ subj, aula, raw: materia });
  });
  return finishModel(cells, "marconi");
}
function fromLessons(lessons) {
  const daysSeen = new Map(); // giorno settimana -> Set date
  const slots = new Map();
  (lessons || []).forEach((l) => {
    const d = parseDate(l.evtDate);
    if (!d || d.getDay() === 0) return;
    const wd = d.getDay(), date = ymd(d);
    if (!daysSeen.has(wd)) daysSeen.set(wd, new Set());
    daysSeen.get(wd).add(date);
    const h0 = Number(l.evtHPos);
    if (!h0 || !l.subjectDesc) return;
    const dur = Math.max(1, Math.min(4, Math.round(Number(l.evtDuration) || 1)));
    const subj = subjectInfo(l.subjectDesc);
    for (let h = h0; h < h0 + dur; h++) {
      const k = `${wd}:${h}`;
      if (!slots.has(k)) slots.set(k, new Map());
      const m = slots.get(k);
      if (!m.has(subj.key)) m.set(subj.key, { subj, dates: new Set(), teachers: new Set(), lastArg: "", lastArgDate: "", lastDate: "" });
      const e = m.get(subj.key);
      e.dates.add(date);
      if (l.authorName) e.teachers.add(personName(l.authorName));
      if (date > e.lastDate) e.lastDate = date;
      if (l.lessonArg && date >= e.lastArgDate) { e.lastArg = l.lessonArg; e.lastArgDate = date; }
    }
  });
  const cells = new Map();
  slots.forEach((m, k) => {
    const [wd, h] = k.split(":").map(Number);
    const ranked = [...m.values()].sort((a, b) => b.dates.size - a.dates.size || b.lastDate.localeCompare(a.lastDate));
    const best = ranked[0];
    const total = daysSeen.get(wd)?.size || best.dates.size;
    cells.set(k, {
      day: wd, hour: h,
      items: [{ subj: best.subj, aula: "", teachers: [...best.teachers], count: best.dates.size, total, lastArg: best.lastArg, lastArgDate: best.lastArgDate }],
      alts: ranked.slice(1).map((r) => ({ subj: r.subj, count: r.dates.size })),
      unsure: total >= 2 && best.dates.size / total < 0.5,
    });
  });
  return finishModel(cells, "lessons");
}
function finishModel(cells, source) {
  const all = [...cells.values()];
  const hasSat = all.some((c) => c.day === 6);
  const days = hasSat ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  const hours = Math.max(source === "marconi" ? 5 : 4, ...all.map((c) => c.hour));
  const colors = assignColors(all.flatMap((c) => c.items.map((i) => i.subj.key)));
  // Ore settimanali per materia (escluso sostegno)
  const weekly = new Map();
  all.forEach((c) => {
    const main = primary(c);
    if (!main) return;
    const w = weekly.get(main.subj.key) || { subj: main.subj, hours: 0 };
    w.hours++;
    weekly.set(main.subj.key, w);
  });
  return { source, cells, days, hours, colors, bells: source === "marconi" ? MARCONI_BELLS : null, weekly };
}
const primary = (cell) => cell?.items.find((i) => i.subj.key !== "sos") || cell?.items[0] || null;
const hasSos = (cell) => cell?.items.some((i) => i.subj.key === "sos") && cell.items.some((i) => i.subj.key !== "sos");
const signature = (cell) => (cell ? cell.items.map((i) => `${i.subj.key}|${i.aula}`).join(",") : "");

/** Celle unite: ore consecutive uguali nello stesso giorno diventano un blocco. */
function blocksOf(model) {
  const out = [];
  model.days.forEach((day) => {
    let cur = null;
    for (let h = 1; h <= model.hours; h++) {
      const cell = model.cells.get(`${day}:${h}`);
      if (cell && cur && signature(cur.cell) === signature(cell) && cur.to === h - 1) { cur.to = h; cur.cells.push(cell); continue; }
      cur = cell ? { day, from: h, to: h, cell, cells: [cell] } : null;
      if (cur) out.push(cur);
    }
  });
  return out;
}

/* ---------------- tempo ---------------- */
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
function nowInfo(model) {
  const d = new Date();
  const day = d.getDay();
  const res = { day: day >= 1 && day <= 6 ? day : 0, hour: 0, next: 0 };
  if (!model.bells || !res.day) return res;
  const m = d.getHours() * 60 + d.getMinutes();
  for (let h = 1; h <= model.hours; h++) {
    const b = model.bells[h];
    if (!b) continue;
    if (m >= toMin(b[0]) && m < toMin(b[1])) { res.hour = h; break; }
    if (m < toMin(b[0])) { res.next = h; break; }
  }
  return res;
}
const blockTime = (model, b) => (model.bells?.[b.from] && model.bells?.[b.to] ? `${model.bells[b.from][0]}–${model.bells[b.to][1]}` : "");
const hourLabel = (b) => (b.from === b.to ? `${b.from}ª ora` : `${b.from}ª–${b.to}ª ora`);

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    let mode = store.get("orario:mode", "week") === "day" ? "day" : "week";
    let source = null; // "marconi" | "lessons"
    let classes = [];
    let cls = null;
    let model = null;
    let range = null;
    let selDay = null;
    let timer = null;
    let alive = true;
    let lastNowKey = "";

    const header = () => pageHeader({
      eyebrow: "Registro",
      title: "Orario",
      actions: source === "marconi" && cls ? html`<button type="button" class="btn orario-classbtn" data-pick-class aria-haspopup="dialog">
        <span class="orario-classlabel">Classe</span><strong>${cls}</strong>${icon("chevronDown")}</button>` : "",
    });
    setHTML(root, html`<div data-head>${header()}</div>
      <div class="orario-toolbar">${segmented("orario-mode", [{ value: "week", label: "Settimana" }, { value: "day", label: "Giorno" }], mode)}
        <p class="caption orario-source" data-source></p></div>
      <div data-body><div class="card card-pad"><div class="skeleton" style="height:min(60vh,420px)"></div></div></div>`);
    const body = $("[data-body]", root);
    bindSegmented(root, "orario-mode", (v) => { mode = v; store.set("orario:mode", v); draw(); });
    const drawHead = () => setHTML($("[data-head]", root), header());

    /* ----- settimana ----- */
    const cellHTML = (b, now) => {
      const p = primary(b.cell);
      const more = b.cell.items.filter((i) => i.subj.key !== "sos").length - 1;
      const isNow = now.day === b.day && now.hour >= b.from && now.hour <= b.to;
      const isToday = now.day === b.day;
      const aula = b.cell.items.map((i) => i.aula).filter(Boolean)[0] || "";
      const label = `${DAY_NAMES[b.day]}, ${hourLabel(b)}: ${p.subj.full}${aula ? `, aula ${aula}` : ""}`;
      return html`<button type="button" class="orario-cell${isNow ? " is-now" : ""}${isToday ? " is-today" : ""}${b.cell.unsure ? " is-unsure" : ""}${p.subj.key === "sos" ? " is-sos" : ""}"
        style="--c:${raw(colorVar(model, p.subj.key))};grid-column:${model.days.indexOf(b.day) + 2};grid-row:${b.from + 1} / span ${b.to - b.from + 1}"
        data-block="${b.day}:${b.from}" aria-label="${label}">
        <span class="orario-cell-short">${p.subj.short}${more > 0 ? html`<small>+${more}</small>` : ""}</span>
        <span class="orario-cell-full">${p.subj.full}${more > 0 ? html` <small>+${more}</small>` : ""}</span>
        ${aula ? html`<span class="orario-cell-room">${aula}</span>` : ""}
        ${hasSos(b.cell) ? html`<span class="orario-sos" title="Con sostegno" aria-hidden="true">S</span>` : ""}
        ${isNow ? html`<span class="orario-nowdot" aria-hidden="true"></span>` : ""}
      </button>`;
    };
    const nowLine = (now) => {
      if (!model.bells || !now.day) return "";
      const todayBlocks = blocksOf(model).filter((b) => b.day === now.day);
      if (!todayBlocks.length) return "";
      if (now.hour) {
        const b = todayBlocks.find((x) => now.hour >= x.from && now.hour <= x.to);
        if (!b) return "";
        const p = primary(b.cell);
        return html`<p class="orario-now"><span class="orario-live" aria-hidden="true"></span><span class="orario-now-text">Adesso <strong>${p.subj.full}</strong>${b.cell.items[0]?.aula ? ` in ${b.cell.items[0].aula}` : ""} · fino alle ${model.bells[b.to][1]}</span></p>`;
      }
      if (now.next) {
        const b = todayBlocks.find((x) => x.from >= now.next) || null;
        if (!b) return "";
        const p = primary(b.cell);
        const first = now.next === todayBlocks[0].from;
        return html`<p class="orario-now"><span class="orario-live is-idle" aria-hidden="true"></span><span class="orario-now-text">${first ? "Oggi si comincia" : "Dopo l'intervallo"} alle ${model.bells[b.from][0]} con <strong>${p.subj.full}</strong></span></p>`;
      }
      return "";
    };
    const drawWeek = () => {
      const now = nowInfo(model);
      const blocks = blocksOf(model);
      const filled = new Set(blocks.flatMap((b) => Array.from({ length: b.to - b.from + 1 }, (_, i) => `${b.day}:${b.from + i}`)));
      const empties = [];
      model.days.forEach((d) => { for (let h = 1; h <= model.hours; h++) if (!filled.has(`${d}:${h}`)) empties.push([d, h]); });
      const weekly = [...model.weekly.values()].sort((a, b) => b.hours - a.hours || a.subj.full.localeCompare(b.subj.full));
      setHTML(body, html`${nowLine(now)}
        <div class="card orario-gridcard">
          <div class="orario-grid" style="--cols:${model.days.length};--rows:${model.hours}" role="grid" aria-label="Orario settimanale">
            <span class="orario-corner" aria-hidden="true"></span>
            ${model.days.map((d, i) => html`<span class="orario-dayhead${now.day === d ? " is-today" : ""}" style="grid-column:${i + 2}" role="columnheader">
              <span class="orario-dayabbr">${DAY_ABBR[d]}</span><span class="orario-dayname">${DAY_NAMES[d]}</span></span>`)}
            ${Array.from({ length: model.hours }, (_, i) => i + 1).map((h) => html`<span class="orario-hour${now.day && now.hour === h ? " is-now" : ""}" style="grid-row:${h + 1}" role="rowheader">
              <span class="tnum">${h}</span>${model.bells?.[h] ? html`<small class="tnum">${model.bells[h][0].replace(/^0/, "")}</small>` : ""}</span>`)}
            ${empties.map(([d, h]) => html`<span class="orario-empty${now.day === d ? " is-today" : ""}" style="grid-column:${model.days.indexOf(d) + 2};grid-row:${h + 1}" aria-hidden="true"></span>`)}
            ${blocks.map((b) => cellHTML(b, now))}
          </div>
        </div>
        ${weekly.length ? html`<section class="section orario-weekly">
          <div class="section-head"><p class="overline">Ore settimanali</p><p class="caption tnum">${weekly.reduce((s, w) => s + w.hours, 0)} ore</p></div>
          <ul class="orario-legend">${weekly.map((w) => html`<li style="--c:${raw(colorVar(model, w.subj.key))}"><i aria-hidden="true"></i><span class="orario-legend-name">${w.subj.full}</span><span class="tnum faint">${w.hours} h</span></li>`)}</ul>
        </section>` : ""}`);
    };

    /* ----- giorno ----- */
    const drawDay = () => {
      const now = nowInfo(model);
      if (!selDay || !model.days.includes(selDay)) selDay = model.days.includes(now.day) ? now.day : model.days[0];
      const blocks = blocksOf(model).filter((b) => b.day === selDay);
      const rows = [];
      blocks.forEach((b, i) => {
        const prev = blocks[i - 1];
        if (prev && model.bells) {
          const gapStart = model.bells[prev.to]?.[1], gapEnd = model.bells[b.from]?.[0];
          if (gapStart && gapEnd && toMin(gapEnd) > toMin(gapStart)) rows.push(html`<li class="orario-break"><span class="tnum">${gapStart}</span><span>${b.from - prev.to > 1 ? "Ore libere" : "Intervallo"}</span></li>`);
        } else if (prev && b.from - prev.to > 1) rows.push(html`<li class="orario-break"><span></span><span>Ora libera</span></li>`);
        const p = primary(b.cell);
        const isNow = now.day === b.day && now.hour >= b.from && now.hour <= b.to;
        const t = blockTime(model, b);
        const it = b.cell.items[0];
        const sub = [b.cell.items.map((x) => x.aula).filter(Boolean).join(" · ") && `Aula ${b.cell.items.map((x) => x.aula).filter(Boolean).join(", ")}`,
          it?.teachers?.length ? it.teachers.slice(0, 2).join(", ") : "", hasSos(b.cell) ? "con sostegno" : ""].filter(Boolean).join(" · ");
        rows.push(html`<li><button type="button" class="row orario-dayrow${isNow ? " is-now" : ""}" data-block="${b.day}:${b.from}" style="--c:${raw(colorVar(model, p.subj.key))}">
          <span class="orario-daytime tnum">${t ? html`<span>${t.split("–")[0]}</span><small>${t.split("–")[1]}</small>` : html`<span>${b.from}ª</span>${b.to > b.from ? html`<small>${b.to}ª</small>` : ""}`}</span>
          <span class="orario-daybar" aria-hidden="true"></span>
          <span class="row-main"><span class="row-title">${p.subj.full}${b.cell.items.length > 1 && !hasSos(b.cell) ? html` <span class="faint">+ ${b.cell.items.slice(1).map((x) => x.subj.short).join(", ")}</span>` : ""}</span>
            ${sub ? html`<span class="row-sub">${sub}</span>` : ""}</span>
          <span class="row-trail">${isNow ? html`<span class="chip chip-accent">Adesso</span>` : html`<span class="caption tnum">${hourLabel(b).replace(" ora", "")}</span>`}</span>
        </button></li>`);
      });
      const first = blocks[0], last = blocks[blocks.length - 1];
      const summary = blocks.length ? `${blocks.reduce((s, b) => s + b.to - b.from + 1, 0)} ore${model.bells && first && last ? ` · ${model.bells[first.from]?.[0]}–${model.bells[last.to]?.[1]}` : ""}` : "";
      setHTML(body, html`<div class="orario-daypick">${segmented("orario-day", model.days.map((d) => ({ value: String(d), label: DAY_ABBR[d] })), String(selDay))}</div>
        <div class="section-head orario-dayhead2"><p class="title-2">${DAY_NAMES[selDay]}${now.day === selDay ? html` <span class="chip chip-accent">Oggi</span>` : ""}</p><p class="caption tnum">${summary}</p></div>
        ${blocks.length ? html`<ul class="card list orario-daylist">${rows}</ul>` : html`<div class="card">${emptyState({ iconName: "clock", title: "Nessuna lezione", text: "In questo giorno non risultano ore di lezione." })}</div>`}`);
      bindSegmented(body, "orario-day", (v) => { selDay = Number(v); drawDay(); });
    };

    const draw = () => {
      if (!alive || !model) return;
      const src = $("[data-source]", root);
      if (src) {
        if (model.source === "lessons" && range) setHTML(src, html`${icon("info")}<span>Ricostruito dalle lezioni firmate dal ${fmtDate(range.start)} a oggi</span>`);
        else setHTML(src, "");
      }
      if (!model.cells.size) {
        setHTML(body, html`<div class="card">${emptyState({
          iconName: "clock",
          title: model.source === "marconi" ? "Orario non disponibile" : "Orario non ancora ricostruibile",
          text: model.source === "marconi" ? `Per la classe ${cls} non è pubblicato un orario. Prova a sceglierne un'altra.` : "Servono le lezioni firmate delle ultime settimane: torna dopo qualche giorno di scuola.",
        })}</div>`);
        return;
      }
      lastNowKey = JSON.stringify(nowInfo(model));
      if (mode === "day") drawDay(); else drawWeek();
    };

    const blockSheet = (key) => {
      const [day, from] = key.split(":").map(Number);
      const b = blocksOf(model).find((x) => x.day === day && x.from === from);
      if (!b) return;
      const p = primary(b.cell);
      const t = blockTime(model, b);
      const weekly = model.weekly.get(p.subj.key)?.hours || 0;
      const items = b.cell.items;
      const it = items[0];
      openSheet({
        title: p.subj.full,
        content: html`<div class="orario-sheet" style="--c:${raw(colorVar(model, p.subj.key))}">
          <div class="orario-sheet-hero"><span class="orario-sheet-badge">${p.subj.short}</span>
            <div><p class="title-3">${DAY_NAMES[b.day]} · ${hourLabel(b)}</p><p class="body-2 tnum">${t || (b.to > b.from ? `${b.to - b.from + 1} ore di fila` : "1 ora")}</p></div></div>
          <ul class="card list">
            ${items.map((x) => html`<li class="row"><span class="row-icon" style="--c:${raw(colorVar(model, x.subj.key))}">${icon(x.subj.key === "sos" ? "person" : "lessons")}</span>
              <div class="row-main"><p class="row-title">${x.subj.full}</p><p class="row-sub">${x.aula ? `Aula ${x.aula}` : model.source === "marconi" ? "Aula non indicata" : (x.teachers || []).join(", ") || "Docente non indicato"}</p></div></li>`)}
            ${weekly ? html`<li class="row"><span class="row-icon">${icon("clock")}</span><div class="row-main"><p class="row-title">${weekly} ${weekly === 1 ? "ora" : "ore"} a settimana</p><p class="row-sub">di ${p.subj.full.toLowerCase()}</p></div></li>` : ""}
          </ul>
          ${model.source === "lessons" && it ? html`<div class="card card-pad orario-sheet-note">
            <p class="overline">Come l'abbiamo ricavato</p>
            <p class="body-2">Firmata in quest'ora ${it.count} ${it.count === 1 ? "volta" : "volte"} su ${it.total} ${DAY_NAMES[b.day].toLowerCase()} delle ultime settimane${b.cell.alts?.length ? html`; a volte anche ${b.cell.alts.slice(0, 2).map((a) => a.subj.full.toLowerCase()).join(", ")}` : ""}.</p>
            ${it.lastArg ? html`<p class="overline" style="margin-top:14px">Ultimo argomento · ${fmtDate(it.lastArgDate)}</p><p class="body-2" style="color:var(--text)">${it.lastArg}</p>` : ""}
          </div>` : ""}
          ${hasSos(b.cell) ? html`<p class="caption">In quest'ora è prevista anche un'insegnante di sostegno.</p>` : ""}
        </div>`,
      });
    };
    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-block]");
      if (b && model) blockSheet(b.dataset.block);
    });

    /* ----- classi ----- */
    const classSheet = () => {
      const content = document.createElement("div");
      const drawList = (q = "") => {
        const f = q.trim().toUpperCase().replace(/\s+/g, "");
        const list = classes.filter((c) => !f || c.replace(/\s+/g, "").includes(f));
        const groups = new Map();
        list.forEach((c) => { const g = /^\d/.test(c) ? `${c[0]}ª` : "Altre"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); });
        setHTML($("[data-classes]", content), list.length ? html`${[...groups.entries()].map(([g, cs]) => html`<p class="overline orario-classgroup">${g === "Altre" ? g : `Classi ${g}`}</p>
          <div class="orario-classgrid">${cs.map((c) => html`<button type="button" class="orario-classchip${c === cls ? " is-active" : ""}" data-class="${c}">${c}</button>`)}</div>`)}`
          : html`<p class="body-2 orario-classnone">Nessuna classe trovata.</p>`);
      };
      setHTML(content, html`<label class="search orario-classsearch">${icon("search")}<input class="field" type="search" inputmode="search" autocomplete="off" placeholder="Cerca una classe" aria-label="Cerca una classe" /></label>
        ${state.session?.class_code ? html`<p class="caption orario-classmine">La tua classe: <strong>${matchClass(classes, state.session.class_code) || state.session.class_code}</strong></p>` : ""}
        <div data-classes></div>`);
      drawList();
      const sheet = openSheet({ title: "Scegli la classe", content });
      $("input", content).addEventListener("input", (e) => drawList(e.target.value));
      content.addEventListener("click", (e) => {
        const c = e.target.closest("[data-class]");
        if (!c) return;
        sheet.close();
        if (c.dataset.class === cls) return;
        cls = c.dataset.class;
        store.set("orario:class", cls);
        drawHead();
        loadClass();
      });
    };
    root.addEventListener("click", (e) => { if (e.target.closest("[data-pick-class]")) classSheet(); });

    /* ----- caricamento ----- */
    const showError = (err, retry) => {
      setHTML(body, errorState(err));
      $("[data-retry]", body)?.addEventListener("click", retry);
    };
    const loadClass = async () => {
      model = null;
      setHTML(body, html`<div class="card card-pad"><div class="skeleton" style="height:min(60vh,420px)"></div></div>`);
      const wanted = cls;
      try {
        await load(`orario:class:${wanted}`, () => get(`/orario/class?class=${encodeURIComponent(wanted)}`), (data) => {
          if (wanted !== cls) return;
          model = fromMarconi(data?.entries);
          draw();
        }, { maxAge: 30 * 60_000 });
      } catch (err) { if (wanted === cls) showError(err, loadClass); }
    };
    const loadLessons = async () => {
      const today = new Date();
      const start = addDays(startOfWeek(today), -14);
      range = { start, end: today };
      const s = ymd(start), e = ymd(today);
      try {
        await load(`lezioni:${s}:${e}`, () => get(`/lezioni?start=${s}&end=${e}`), (data) => {
          model = fromLessons(data?.lessons);
          draw();
        }, { maxAge: 30 * 60_000 });
      } catch (err) { showError(err, loadLessons); }
    };
    const start = async () => {
      if (ctx.params.get("fonte") === "lezioni") source = "lessons";
      else if (isMarconi()) source = "marconi";
      else {
        try {
          const r = await load("orario:eligible", () => get("/orario/eligible"), () => {}, { maxAge: 6 * 3600_000 });
          source = r?.eligible ? "marconi" : "lessons";
        } catch { source = "lessons"; }
      }
      if (source === "marconi") {
        try {
          await load("orario:meta", () => get("/orario/meta"), (data) => { classes = normClasses(data?.meta); }, { maxAge: 6 * 3600_000 });
        } catch (err) {
          // Orario ufficiale non raggiungibile: ripiega sulle lezioni.
          source = "lessons";
        }
      }
      if (source === "marconi") {
        const saved = store.get("orario:class");
        cls = (saved && classes.includes(saved) && saved) || matchClass(classes, state.session?.class_code) || classes[0] || null;
        drawHead();
        if (!cls) { setHTML(body, html`<div class="card">${emptyState({ iconName: "clock", title: "Nessuna classe disponibile", text: "L'orario della scuola non elenca ancora le classi." })}</div>`); return; }
        await loadClass();
      } else {
        drawHead();
        await loadLessons();
      }
    };
    await start();

    // L'ora in corso si aggiorna da sola (ridisegna solo quando cambia ora).
    timer = setInterval(() => {
      if (!model || document.hidden) return;
      if (JSON.stringify(nowInfo(model)) !== lastNowKey) draw();
    }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  },
};
