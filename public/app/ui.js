// Componenti UI condivisi: template sicuri, icone, sheet, menu, toast, segmented, anelli.
// Motion secondo le regole di Emil Kowalski (vedi styles/app.css).

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(String(value ?? ""));

/** Template HTML: le interpolazioni sono escapate, tranne raw()/array di raw. */
export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += renderValue(values[i]);
  });
  return raw(out);
}
function renderValue(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return esc(v);
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function setHTML(el, content) {
  el.innerHTML = content instanceof Raw ? content.value : esc(content);
  return el;
}

export function staggerIndex(root) {
  $$(".stagger", root).forEach((group) => {
    Array.from(group.children).forEach((child, i) => child.style.setProperty("--i", i));
  });
}

/* ---------------- icone (stile SF Symbols, tratto 1.7) ---------------- */
const P = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  grades: '<path d="M4.5 20V11M10 20V5M15.5 20v-7M21 20H3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  absences: '<path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z"/><path d="M8.5 15.5 15.5 8.5"/>',
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2l9 4.5V4.5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M19 9.5a3.5 3.5 0 0 1 0 5M7.5 15l1 4.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  note: '<path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5L15.5 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M20.5 15.5h-4a1 1 0 0 0-1 1v4M8 9h8M8 12.5h5"/>',
  lessons: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5ZM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
  doc: '<path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/>',
  books: '<rect x="4" y="4" width="4.5" height="16" rx="1"/><rect x="9.5" y="4" width="4.5" height="16" rx="1"/><path d="m15.5 5.2 3.9-1 3.1 15.4-3.9 1Z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 6H5a2.5 2.5 0 0 0 3 4M16 6h3a2.5 2.5 0 0 1-3 4M12 13v4M8.5 20.5h7M10 17h4"/>',
  devices: '<rect x="2.5" y="5" width="13" height="10" rx="1.6"/><path d="M6 19h6M9 15v4"/><rect x="17.5" y="8" width="4.5" height="11" rx="1.2"/>',
  person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.3 7.5-5.3s6.3 1.7 7.5 5.3"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.1 7.5 9.5 4.4-1.4 7.5-4.9 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  homework: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/>',
  more: '<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/>',
  chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chevronLeft: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  paperclip: '<path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5H14ZM18 18h2.5v2.5H18ZM18 14h2.5M14 18v2.5"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  sparkle: '<path d="M12 3c.7 4.4 2.6 6.3 7 7-4.4.7-6.3 2.6-7 7-.7-4.4-2.6-6.3-7-7 4.4-.7 6.3-2.6 7-7Z"/>',
  logout: '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16M10 6c.6-.1 1.3-.2 2-.2 6 0 9.5 6.2 9.5 6.2a16 16 0 0 1-3 3.6M6.4 7.4C3.9 9.1 2.5 12 2.5 12S6 18.2 12 18.2c1.5 0 2.9-.4 4.1-1"/>',
  flask: '<path d="M9.5 3.5h5M10 3.5v6L4.8 18.2A1.5 1.5 0 0 0 6.1 20.5h11.8a1.5 1.5 0 0 0 1.3-2.3L14 9.5v-6"/><path d="M7.5 14.5h9"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  friends: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.9-3.2 3.2-4.8 6-4.8s5.1 1.6 6 4.8"/><circle cx="16.8" cy="9.5" r="2.6"/><path d="M16.5 14.7c2.3.1 4 1.5 4.6 4"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 2-.8 2-1.8 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.4 0-1 .8-1.7 1.8-1.7H17a3.5 3.5 0 0 0 3.5-3.6C20.5 6.9 16.7 3.5 12 3.5Z"/><circle cx="7.6" cy="11" r="1.2"/><circle cx="10.2" cy="7.4" r="1.2"/><circle cx="14.6" cy="7.4" r="1.2"/>',
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  spid: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-3.8 3.7-5.5 7-5.5s6 1.7 7 5.5"/><path d="M17.5 3.5h3v3"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.6 16.2c.6-1.5 1.7-2.3 2.9-2.3s2.3.8 2.9 2.3M14 10h4M14 13.5h3"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 5v4h4M12 8v4.5l3 1.8"/>',
};
export function icon(name, cls = "") {
  return raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`);
}

/* ---------------- formattazione ---------------- */
const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const DAYS = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
export const DAY_SHORT = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  const t = s.match(/T(\d{2}):(\d{2})/);
  return new Date(+m[1], +m[2] - 1, +m[3], t ? +t[1] : 0, t ? +t[2] : 0);
}
export function ymd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}
export function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
export function startOfWeek(date) { const d = new Date(date); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); d.setHours(0, 0, 0, 0); return d; }
export function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export function fmtDate(value, { weekday = false, year = false } = {}) {
  const d = parseDate(value);
  if (!d) return "";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ""}`;
  return weekday ? `${DAYS[d.getDay()]} ${base}` : base;
}
export function fmtDayName(value) { const d = parseDate(value); return d ? DAYS[d.getDay()] : ""; }
export function fmtTime(value) { const m = String(value || "").match(/T(\d{2}):(\d{2})/); return m ? `${m[1]}:${m[2]}` : ""; }
export function relativeDay(value) {
  const d = parseDate(value);
  if (!d) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  if (diff === 0) return "Oggi";
  if (diff === 1) return "Domani";
  if (diff === -1) return "Ieri";
  if (diff > 1 && diff < 7) return DAYS[d.getDay()];
  return fmtDate(d);
}
export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}
// Nomi propri in "Title Case"; materie e frasi in "Sentence case" (come in italiano).
const SMALL = new Set(["e", "ed", "di", "del", "della", "dei", "delle", "degli", "da", "dal", "dalla", "a", "al", "alla", "ai", "in", "con", "per", "su", "tra", "fra", "il", "lo", "la", "le", "gli", "i", "o", "d'", "l'"]);
const KEEP_UPPER = new Set(["IRC", "TPSIT", "TPSI", "CLIL", "PCTO", "ICT", "IT", "UE", "ER"]);
export function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}
export function sentenceCase(s) {
  const words = String(s || "").trim().split(/\s+/);
  return words.map((w, i) => {
    if (KEEP_UPPER.has(w.toUpperCase()) && w === w.toUpperCase()) return w.toUpperCase();
    const lw = w.toLowerCase();
    if (i === 0) return lw.charAt(0).toUpperCase() + lw.slice(1);
    return SMALL.has(lw) ? lw : lw;
  }).join(" ");
}
/** Nome di materia leggibile: "LINGUA E LETTERATURA ITALIANA" → "Lingua e letteratura italiana". */
export const subjectName = (s) => sentenceCase(s);
/** Nome di persona: "ROSSI ANNA" → "Rossi Anna". */
export const personName = (s) => titleCase(s);
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

/* ---------------- voti ---------------- */
// Verde: buono (≥ 6,5) · Giallo: sufficienza al limite (6–6,49) · Rosso: insufficiente (< 6)
// Sotto il 4: "rosso fuoco" (pastiglia con le fiamme).
export function gradeClass(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "g-none";
  if (value >= 6.5) return "g-good";
  if (value >= 6) return "g-ok";
  if (value < 4) return "g-bad g-fire";
  return "g-bad";
}
export function gradeColor(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "var(--blue)";
  if (value >= 6.5) return "var(--good)";
  if (value >= 6) return "var(--ok)";
  return "var(--bad)";
}

/** Anello SVG con valore 0–10. */
export function ring(value, { size = 96, stroke = 9, label = "", sub = "" } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value / 10));
  return html`<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
      <circle class="ring-value" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round"
        stroke="${gradeColor(value)}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-offset="${c * (1 - pct)}"/>
    </svg>
    <div class="ring-label"><div class="ring-num" style="font-size:${Math.round(size * 0.3)}px">${label || fmtNum(value, 2)}</div>${sub ? html`<div class="caption" style="margin-top:2px">${sub}</div>` : ""}</div>
  </div>`;
}
/** Avvia l'animazione degli anelli appena montati (rara: una volta per vista). */
export function animateRings(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$(".ring-value[data-offset]", root).forEach((el) => { el.style.strokeDashoffset = el.dataset.offset; });
  }));
}

/* ---------------- segmented control ---------------- */
export function segmented(name, options, active) {
  return html`<div class="segmented" role="group" data-seg="${name}">
    <span class="seg-indicator" aria-hidden="true"></span>
    ${options.map((o) => html`<button type="button" data-value="${o.value}" aria-pressed="${String(o.value === active)}">${o.label}</button>`)}
  </div>`;
}
export function bindSegmented(root, name, onChange) {
  const seg = $(`[data-seg="${name}"]`, root);
  if (!seg) return;
  const indicator = $(".seg-indicator", seg);
  const place = (instant = false) => {
    const btn = $('button[aria-pressed="true"]', seg);
    if (!btn) return;
    if (instant) indicator.style.transition = "none";
    indicator.style.width = `${btn.offsetWidth}px`;
    indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (instant) { indicator.offsetWidth; indicator.style.transition = ""; }
  };
  place(true);
  new ResizeObserver(() => place(true)).observe(seg);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn || btn.getAttribute("aria-pressed") === "true") return;
    $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    place();
    onChange(btn.dataset.value);
  });
}

/* ---------------- sheet (pannello dal basso / modale su desktop) ---------------- */
let openSheets = 0;
export function openSheet({ title = "", content, onClose, wide = false } = {}) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const sheet = document.createElement("div");
  sheet.className = "sheet glass glass-strong";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  if (wide) sheet.classList.add("sheet-wide");
  setHTML(sheet, html`<div class="sheet-grabber" aria-hidden="true"></div>
    <div class="sheet-head"><h2 class="title-2">${title}</h2>
      <button type="button" class="btn btn-icon" data-close aria-label="Chiudi">${icon("close")}</button></div>
    <div class="sheet-body"></div>`);
  const body = $(".sheet-body", sheet);
  if (content instanceof Node) body.append(content);
  else setHTML(body, content ?? "");
  document.body.append(scrim, sheet);
  openSheets++;
  document.documentElement.style.overflow = "hidden";
  const prevFocus = document.activeElement;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.classList.remove("is-open");
    scrim.classList.remove("is-open");
    sheet.style.transform = "";
    const done = () => { sheet.remove(); scrim.remove(); };
    sheet.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 520);
    openSheets--;
    if (!openSheets) document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", close);
  $("[data-close]", sheet).addEventListener("click", close);
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add("is-open"); scrim.classList.add("is-open"); }));
  setTimeout(() => $("[data-close]", sheet)?.focus({ preventScroll: true }), 60);
  enableDragToDismiss(sheet, close);
  return { el: sheet, body, close };
}

// Trascinamento stile Vaul: soglia distanza o velocità, rubber-band verso l'alto.
function enableDragToDismiss(sheet, close) {
  const handle = sheet;
  let startY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false, pointerId = null;
  handle.addEventListener("pointerdown", (e) => {
    if (window.matchMedia("(min-width: 720px)").matches) return;
    const body = $(".sheet-body", sheet);
    const fromHead = e.target.closest(".sheet-grabber, .sheet-head");
    if (!fromHead && body.scrollTop > 0) return;
    if (e.target.closest("button, a, input, textarea, select, [data-no-drag]")) return;
    dragging = true; pointerId = e.pointerId; startY = lastY = e.clientY; lastT = performance.now(); velocity = 0;
    sheet.style.transition = "none";
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4 && !sheet.hasPointerCapture?.(e.pointerId)) sheet.setPointerCapture?.(e.pointerId);
    const now = performance.now();
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY; lastT = now;
    const offset = dy > 0 ? dy : (dy * 40 * 0.55) / (40 + 0.55 * Math.abs(dy)); // rubber-band
    sheet.style.transform = `translateY(${offset}px)`;
  });
  const end = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    sheet.style.transition = "";
    const dy = e.clientY - startY;
    if (dy > sheet.offsetHeight * 0.25 || velocity > 0.4) close();
    else sheet.style.transform = "";
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* ---------------- menu a comparsa (origine sul pulsante) ---------------- */
export function openMenu(anchor, items, onPick) {
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu glass glass-strong";
  menu.setAttribute("role", "menu");
  setHTML(menu, html`${items.map((it) => html`<button type="button" class="menu-item" role="menuitemradio" aria-checked="${String(!!it.checked)}" data-value="${it.value}">
    <span>${it.label}</span>${it.checked ? icon("check") : ""}</button>`)}`);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(menu.offsetWidth, r.width);
  let left = Math.min(Math.max(12, r.right - w), window.innerWidth - w - 12);
  let top = r.bottom + 8;
  const below = top + menu.offsetHeight < window.innerHeight - 12;
  if (!below) top = r.top - menu.offsetHeight - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${r.left + r.width / 2 - left}px ${below ? "0" : "100%"}`;
  requestAnimationFrame(() => menu.classList.add("is-open"));
  const close = () => {
    menu.classList.remove("is-open");
    setTimeout(() => menu.remove(), 200);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key);
  };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === "Escape") { close(); anchor.focus(); } };
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
  document.addEventListener("keydown", key);
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-value]");
    if (!b) return;
    close();
    onPick(b.dataset.value);
  });
  $(".menu-item", menu)?.focus({ preventScroll: true });
}

/* ---------------- toast (stile Sonner) ---------------- */
let toaster = null;
const toasts = [];
export function toast(message, { error = false, duration = 4000, onClick = null } = {}) {
  if (!toaster) {
    toaster = document.createElement("div");
    toaster.className = "toaster";
    toaster.setAttribute("aria-live", "polite");
    document.body.append(toaster);
  }
  let remaining = duration, started = Date.now(), timer = null;
  const el = document.createElement("div");
  el.className = `toast glass glass-strong${error ? " is-error" : ""}`;
  el.dataset.mounted = "false";
  setHTML(el, html`<span class="dot"></span><span>${message}</span>`);
  if (typeof onClick === "function") {
    el.classList.add("is-clickable");
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("click", () => { onClick(); remove(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { onClick(); remove(); } });
  }
  toaster.append(el);
  toasts.unshift(el);
  layoutToasts();
  requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.mounted = "true"; layoutToasts(); }));
  function remove() {
    if (el.dataset.removed === "true") return;
    clearTimeout(timer);
    el.dataset.removed = "true";
    toasts.splice(toasts.indexOf(el), 1);
    layoutToasts();
    setTimeout(() => el.remove(), 400);
  }
  const run = () => { started = Date.now(); timer = setTimeout(remove, remaining); };
  el.addEventListener("pointerenter", () => { clearTimeout(timer); remaining -= Date.now() - started; });
  el.addEventListener("pointerleave", run);
  run();
  return el;
}
function layoutToasts() {
  toasts.forEach((t, i) => {
    t.style.setProperty("--offset", `${i * 14}px`);
    t.style.setProperty("--scale", String(1 - i * 0.05));
    t.style.zIndex = String(100 - i);
    t.style.opacity = i > 2 ? "0" : "";
  });
}

/* ---------------- stati vuoti / errori / caricamento ---------------- */
export function emptyState({ iconName = "sparkle", title = "Niente da mostrare", text = "" } = {}) {
  return html`<div class="empty">${icon(iconName)}<p class="title-3">${title}</p>${text ? html`<p class="body-2" style="max-width:42ch">${text}</p>` : ""}</div>`;
}
export function errorState(err, retry = true) {
  const msg = err?.message || "Qualcosa non ha funzionato.";
  return html`<div class="card card-pad error-box"><div class="spread"><div><p class="title-3">Impossibile caricare</p><p class="body-2">${msg}</p></div>
    ${retry ? html`<button type="button" class="btn" data-retry>${icon("refresh")}Riprova</button>` : ""}</div></div>`;
}
export function skeletonList(rows = 4) {
  return html`<div class="card list">${Array.from({ length: rows }, () => html`<div class="row"><div class="skeleton" style="width:44px;height:44px;border-radius:14px"></div>
    <div class="row-main stack-sm"><div class="skeleton-line" style="width:55%"></div><div class="skeleton-line" style="width:35%;height:11px"></div></div></div>`)}</div>`;
}

/** Markdown minimale e sicuro (titoli, grassetto, corsivo, link, elenchi, paragrafi). */
export function miniMarkdown(text) {
  const lines = esc(text || "").split(/\r?\n/);
  let out = "", inList = false;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="link">$1</a>');
  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { out += "<ul class='md-list'>"; inList = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) out += `<p class="title-3" style="margin-top:12px">${inline(h[2])}</p>`;
    else if (line.trim()) out += `<p style="margin-top:8px">${inline(line)}</p>`;
  }
  if (inList) out += "</ul>";
  return raw(out);
}
