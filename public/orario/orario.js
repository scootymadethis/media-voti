const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

const ORARIO_CLASS_STORAGE_KEY = "orario_selected_class";
const MARCONI_MIUR_SCHOOL_CODE = "VRTF03000V";
const ORARIO_ACCESS_MESSAGE =
  "Al momento la funzione orario è disponibile solo per gli studenti dell'Istituto Marconi.";

class OrarioAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrarioAccessError";
  }
}
const DAY_NAMES = ["", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì"];

const LESSON_SLOTS = [
  { ora: "01", num: 1, start: [8, 0], end: [8, 50] },
  { ora: "02", num: 2, start: [8, 50], end: [9, 40] },
  { ora: "03", num: 3, start: [9, 50], end: [10, 50] },
  { ora: "04", num: 4, start: [10, 50], end: [11, 45] },
  { ora: "05", num: 5, start: [12, 0], end: [12, 50] },
  { ora: "06", num: 6, start: [12, 50], end: [13, 40] },
  { ora: "07", num: 7, start: [13, 40], end: [14, 30] },
];

let allClasses = [];
let selectedClass = null;
let currentHighlight = { day: null, ora: null };
let highlightTimer = null;
let comboboxOpen = false;
let comboboxActiveIndex = -1;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatSlotTime(slot) {
  const [sh, sm] = slot.start;
  const [eh, em] = slot.end;
  return `${slot.num} (${pad2(sh)}.${pad2(sm)}-${pad2(eh)}.${pad2(em)})`;
}

function normalizeMateria(raw) {
  return String(raw || "")
    .replace(/\s*-\s*$/g, "")
    .trim();
}

function matchMarconiClass(hint, classes) {
  if (!hint || !classes?.length) return null;
  const compact = String(hint).trim().toUpperCase().replace(/\s+/g, "");
  if (classes.includes(compact)) return compact;

  let best = null;
  for (const code of classes) {
    if (code === "ALT") continue;
    if (compact === code || compact.includes(code)) {
      if (!best || code.length > best.length) best = code;
    }
  }
  if (best) return best;

  const match = compact.match(/(\d{1,2})([A-Z]{2,4})/);
  if (match) {
    const candidate = `${match[1]}${match[2]}`;
    if (classes.includes(candidate)) return candidate;
  }

  return null;
}

function getWeekStartDate(offsetWeeks = 0) {
  const date = new Date();
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff + offsetWeeks * 7);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}${m}${d}`;
}

async function fetchAgendaInterval(startYYYYMMDD, endYYYYMMDD) {
  const res = await fetch(apiUrl("/api/agenda"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: startYYYYMMDD, end: endYYYYMMDD }),
  });
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("agenda fetch failed");
  }
  return res.json();
}

async function loadAgendaWeek(offsetWeeks) {
  const startDate = getWeekStartDate(offsetWeeks);
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);
  return fetchAgendaInterval(formatDateYYYYMMDD(startDate), formatDateYYYYMMDD(endDate));
}

function extractEvents(agendaData) {
  if (!agendaData) return [];
  if (Array.isArray(agendaData)) return agendaData;
  if (Array.isArray(agendaData.agenda)) return agendaData.agenda;
  if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda)) {
    return agendaData.agenda.agenda;
  }
  for (const key of Object.keys(agendaData)) {
    if (Array.isArray(agendaData[key])) return agendaData[key];
  }
  return [];
}

async function detectClassFromAgenda(classes) {
  for (let offset = 0; offset < 52; offset++) {
    try {
      const agendaData = await loadAgendaWeek(offset);
      const events = extractEvents(agendaData);
      for (const ev of events) {
        const classDesc = ev?.classDesc;
        if (typeof classDesc !== "string" || !classDesc.trim()) continue;
        const matched = matchMarconiClass(classDesc, classes);
        if (matched) return matched;
        const firstChunk = classDesc.split(" ")[0]?.trim();
        const fallback = matchMarconiClass(firstChunk, classes);
        if (fallback) return fallback;
      }
    } catch (err) {
      console.warn("[orario] agenda week failed:", offset, err);
    }
  }
  return null;
}

function extractCardFields(cardPayload) {
  if (!cardPayload || typeof cardPayload !== "object") return {};
  let inner = cardPayload.card ?? cardPayload;
  if (inner?.card && typeof inner.card === "object") inner = inner.card;
  return inner && typeof inner === "object" ? inner : {};
}

function isMarconiStudentFromCard(cardPayload) {
  const fields = extractCardFields(cardPayload);
  const miur = String(
    fields.miurSchoolCode || fields.miurDivisionCode || "",
  )
    .trim()
    .toUpperCase();
  const label = [
    fields.schName,
    fields.schDedication,
    fields.schCity,
    fields.schProv,
    fields.schCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const nameOk = label.includes("marconi");
  const miurOk = miur === MARCONI_MIUR_SCHOOL_CODE;

  if (miur && !miurOk) return false;
  if (miurOk) return true;
  return nameOk;
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchStudentCard() {
  const res = await fetch(apiUrl("/api/card"), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 401) {
    await handleAuthFail(res);
    throw new Error("card fetch unauthorized");
  }
  if (!res.ok) throw new Error("card fetch failed");
  const data = await readJsonSafe(res);
  return data?.card ?? data;
}

async function checkOrarioSchoolAccess() {
  try {
    const res = await fetch(apiUrl("/api/orario/eligible"), {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 401) {
      await handleAuthFail(res);
      return false;
    }
    const data = await readJsonSafe(res);
    if (res.status === 403 || data?.eligible === false) {
      return { eligible: false, detail: data?.detail || ORARIO_ACCESS_MESSAGE };
    }
    if (!res.ok) {
      const card = await fetchStudentCard();
      const eligible = isMarconiStudentFromCard(card);
      return {
        eligible,
        detail: eligible ? null : ORARIO_ACCESS_MESSAGE,
      };
    }
    const eligible = data?.eligible === true;
    return {
      eligible,
      detail: eligible ? null : data?.detail || ORARIO_ACCESS_MESSAGE,
    };
  } catch (err) {
    console.warn("[orario] eligibility check failed, fallback to card:", err);
    try {
      const card = await fetchStudentCard();
      const eligible = isMarconiStudentFromCard(card);
      return {
        eligible,
        detail: eligible ? null : ORARIO_ACCESS_MESSAGE,
      };
    } catch (cardErr) {
      console.error("[orario] card fallback failed:", cardErr);
      return { eligible: false, detail: ORARIO_ACCESS_MESSAGE };
    }
  }
}

function showOrarioSchoolGate(message) {
  const gate = document.getElementById("orarioSchoolGate");
  const app = document.getElementById("orarioAppContent");
  const text = document.getElementById("orarioSchoolGateText");
  if (text) text.textContent = message || ORARIO_ACCESS_MESSAGE;
  gate?.classList.remove("hidden");
  app?.classList.add("hidden");
}

function hideOrarioSchoolGate() {
  document.getElementById("orarioSchoolGate")?.classList.add("hidden");
  document.getElementById("orarioAppContent")?.classList.remove("hidden");
}

async function handleOrarioApiError(res) {
  if (res.status === 401) {
    await handleAuthFail(res);
    throw new Error("unauthorized");
  }
  if (res.status === 403) {
    const data = await readJsonSafe(res);
    throw new OrarioAccessError(data?.detail || ORARIO_ACCESS_MESSAGE);
  }
}

async function fetchOrarioMeta() {
  const res = await fetch(apiUrl("/api/orario/meta"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    await handleOrarioApiError(res);
    throw new Error("meta fetch failed");
  }
  const data = await res.json();
  return data?.meta ?? data;
}

async function fetchOrarioClass(classCode) {
  const params = new URLSearchParams({ class: classCode });
  const res = await fetch(apiUrl(`/api/orario/class?${params}`), {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    await handleOrarioApiError(res);
    throw new Error("class schedule fetch failed");
  }
  return res.json();
}

function buildScheduleGrid(entries) {
  const grid = {};
  for (let day = 1; day <= 5; day++) {
    grid[day] = {};
    for (const slot of LESSON_SLOTS) {
      grid[day][slot.ora] = [];
    }
  }

  for (const row of entries || []) {
    const day = parseInt(String(row.giorno ?? row["3"] ?? ""), 10);
    const ora = pad2(parseInt(String(row.ora ?? row["4"] ?? ""), 10));
    if (!day || day < 1 || day > 5 || !grid[day]?.[ora]) continue;

    const materia = normalizeMateria(row.materia ?? row["1"]);
    const aula = String(row.aula ?? row["2"] ?? "").trim();
    if (!materia && !aula) continue;

    const key = `${aula}|${materia}`;
    const bucket = grid[day][ora];
    if (bucket.some((item) => item.key === key)) continue;
    bucket.push({ key, materia, aula, isSupport: materia === "SOS" });
  }

  return grid;
}

function getRomeNowParts() {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayRaw = (map.weekday || "").toLowerCase();
  const weekdayMap = {
    lun: 1,
    mar: 2,
    mer: 3,
    gio: 4,
    ven: 5,
  };
  const day = weekdayMap[weekdayRaw.slice(0, 3)] ?? null;
  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second || "0", 10);
  return {
    day,
    minutes: hour * 60 + minute,
    seconds: hour * 3600 + minute * 60 + second,
  };
}

function msUntilNextHighlightChange() {
  const { seconds } = getRomeNowParts();
  const totalSec = seconds % 86_400;
  const boundaries = new Set();

  for (const slot of LESSON_SLOTS) {
    boundaries.add(slot.start[0] * 3600 + slot.start[1] * 60);
    boundaries.add(slot.end[0] * 3600 + slot.end[1] * 60);
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  for (const boundary of sorted) {
    if (boundary > totalSec) {
      return Math.max(50, (boundary - totalSec) * 1000);
    }
  }

  const untilMidnight = 86_400 - totalSec;
  return Math.max(50, untilMidnight * 1000);
}

function startHighlightClock() {
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }

  const tick = () => {
    refreshCurrentHighlight();
    highlightTimer = window.setTimeout(tick, msUntilNextHighlightChange());
  };

  tick();
}

function computeCurrentSlot() {
  const { day, minutes } = getRomeNowParts();
  if (!day) return { day: null, ora: null };

  for (const slot of LESSON_SLOTS) {
    const start = slot.start[0] * 60 + slot.start[1];
    const end = slot.end[0] * 60 + slot.end[1];
    if (minutes >= start && minutes < end) {
      return { day, ora: slot.ora };
    }
  }
  return { day, ora: null };
}

function renderLessonCell(items) {
  const main = items.filter((item) => !item.isSupport);
  const support = items.filter((item) => item.isSupport);
  const display = main.length ? main : items;

  if (!display.length) {
    return `<div class="orario-slot-body">—</div>`;
  }

  const lines = display.map((item) => {
    const room = item.aula ? `${escapeHtml(item.aula)} - ` : "";
    const subject = escapeHtml(item.materia || "—");
    return `${room}${subject}`;
  });

  const supportLine =
    support.length > 0
      ? `<div class="orario-slot-support">${escapeHtml(
          support.map((s) => s.materia).join(" · "),
        )}</div>`
      : "";

  return `<div class="orario-slot-body">${lines.join("<br>")}</div>${supportLine}`;
}

function renderSchedule(classCode, entries) {
  const grid = buildScheduleGrid(entries);
  const titleEl = document.getElementById("orarioClassTitle");
  if (titleEl) titleEl.textContent = classCode;

  const mount = document.getElementById("orarioGridMount");
  if (!mount) return;

  const { day: today, ora: nowOra } = currentHighlight;
  const cols = [];

  for (let day = 1; day <= 5; day++) {
    const isToday = today === day;
    const slotsHtml = LESSON_SLOTS.map((slot) => {
      const items = grid[day][slot.ora] || [];
      const isNow = isToday && nowOra === slot.ora;
      const timeLabel = formatSlotTime(slot);
      return `
        <article class="orario-slot${items.length ? "" : " is-empty"}${isNow ? " is-now" : ""}" data-day="${day}" data-ora="${slot.ora}">
          <div class="orario-slot-time">${escapeHtml(timeLabel)}</div>
          ${renderLessonCell(items)}
        </article>
      `;
    }).join("");

    cols.push(`
      <section class="orario-day-col${isToday ? " is-today" : ""}" aria-label="${DAY_NAMES[day]}">
        <header class="orario-day-head">${DAY_NAMES[day]}</header>
        ${slotsHtml}
      </section>
    `);
  }

  mount.innerHTML = `
    <div class="orario-grid-scroll">
      <div class="orario-grid" role="grid" aria-label="Orario ${escapeHtml(classCode)}">
        ${cols.join("")}
      </div>
    </div>
  `;
}

function setStatus(message, isError = false) {
  const el = document.getElementById("orarioStatus");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("is-error", Boolean(isError));
}

function setLoading(active, message) {
  if (window.LoadingScreen) {
    if (active) window.LoadingScreen.show(message || "Caricamento in corso…");
    else window.LoadingScreen.hide();
    return;
  }
  const overlay = document.getElementById("loading-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !active);
  document.body.classList.toggle("is-loading", Boolean(active));
}

function filterClassSuggestions(query) {
  const q = query.trim().toUpperCase();
  if (!q) return allClasses.slice(0, 40);
  return allClasses.filter((code) => code.includes(q)).slice(0, 40);
}

function getComboboxEls() {
  return {
    root: document.getElementById("orarioClassCombobox"),
    input: document.getElementById("orarioClassInput"),
    menu: document.getElementById("orarioClassMenu"),
    toggle: document.getElementById("orarioClassToggle"),
  };
}

function setComboboxOpen(open) {
  const { root, menu, toggle, input } = getComboboxEls();
  comboboxOpen = open;
  if (root) root.classList.toggle("is-open", open);
  if (menu) menu.hidden = !open;
  const expanded = open ? "true" : "false";
  if (toggle) toggle.setAttribute("aria-expanded", expanded);
  if (input) input.setAttribute("aria-expanded", expanded);
}

function renderComboboxOptions(items) {
  const { menu } = getComboboxEls();
  if (!menu) return;

  if (!items.length) {
    menu.innerHTML = `<li class="orario-combobox-empty">Nessuna classe trovata</li>`;
    comboboxActiveIndex = -1;
    return;
  }

  menu.innerHTML = items
    .map((code, index) => {
      const active = index === comboboxActiveIndex ? " is-active" : "";
      return `<li role="presentation"><button type="button" class="orario-combobox-option${active}" data-class="${escapeHtml(code)}" role="option">${escapeHtml(code)}</button></li>`;
    })
    .join("");

  menu.querySelectorAll(".orario-combobox-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-class");
      const { input } = getComboboxEls();
      if (input) input.value = code;
      setComboboxOpen(false);
      loadScheduleForClass(code);
    });
  });
}

function updateComboboxList() {
  const { input } = getComboboxEls();
  const query = input?.value || "";
  const items = filterClassSuggestions(query);
  if (comboboxActiveIndex >= items.length) comboboxActiveIndex = items.length - 1;
  renderComboboxOptions(items);
}

async function loadScheduleForClass(classCode, { persist = true } = {}) {
  const normalized = String(classCode || "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    setStatus("Seleziona una classe valida.", true);
    return;
  }
  if (!allClasses.includes(normalized)) {
    setStatus("Classe non trovata nell'elenco Marconi.", true);
    return;
  }

  selectedClass = normalized;
  const input = document.getElementById("orarioClassInput");
  if (input && input.value.toUpperCase() !== normalized) {
    input.value = normalized;
  }
  if (persist) {
    localStorage.setItem(ORARIO_CLASS_STORAGE_KEY, normalized);
  }

  setLoading(true);
  setStatus("Caricamento orario…");
  try {
    const data = await fetchOrarioClass(normalized);
    renderSchedule(normalized, data.entries || []);
    setStatus(`Orario aggiornato · ${normalized}`);
  } catch (err) {
    if (err instanceof OrarioAccessError) {
      showOrarioSchoolGate(err.message);
      return;
    }
    console.error("[orario] load failed:", err);
    setStatus("Impossibile caricare l'orario. Riprova.", true);
  } finally {
    setLoading(false);
  }
}

function refreshCurrentHighlight() {
  const next = computeCurrentSlot();
  const { day, ora } = next;
  currentHighlight = next;
  document.querySelectorAll(".orario-day-col").forEach((col, index) => {
    col.classList.toggle("is-today", day === index + 1);
  });
  document.querySelectorAll(".orario-slot").forEach((slot) => {
    const slotDay = parseInt(slot.dataset.day, 10);
    const slotOra = slot.dataset.ora;
    slot.classList.toggle("is-now", day === slotDay && ora === slotOra);
  });
}

function bindClassPicker() {
  const { root, input, menu, toggle } = getComboboxEls();
  if (!input || !menu) return;

  const selectActiveOption = () => {
    const items = filterClassSuggestions(input.value);
    const code = items[comboboxActiveIndex];
    if (!code) return;
    input.value = code;
    setComboboxOpen(false);
    loadScheduleForClass(code);
  };

  input.addEventListener("focus", () => {
    comboboxActiveIndex = 0;
    updateComboboxList();
    setComboboxOpen(true);
  });

  input.addEventListener("input", () => {
    comboboxActiveIndex = 0;
    updateComboboxList();
    setComboboxOpen(true);
  });

  input.addEventListener("keydown", (e) => {
    const items = filterClassSuggestions(input.value);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setComboboxOpen(true);
      comboboxActiveIndex = Math.min(items.length - 1, comboboxActiveIndex + 1);
      updateComboboxList();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      comboboxActiveIndex = Math.max(0, comboboxActiveIndex - 1);
      updateComboboxList();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (comboboxOpen && comboboxActiveIndex >= 0 && items[comboboxActiveIndex]) {
        selectActiveOption();
      } else {
        loadScheduleForClass(input.value);
      }
      return;
    }
    if (e.key === "Escape") {
      setComboboxOpen(false);
    }
  });

  toggle?.addEventListener("click", () => {
    if (comboboxOpen) {
      setComboboxOpen(false);
      return;
    }
    updateComboboxList();
    setComboboxOpen(true);
    input.focus();
  });

  document.addEventListener("click", (e) => {
    if (!root?.contains(e.target)) setComboboxOpen(false);
  });
}

async function resolveInitialClass() {
  const saved = localStorage.getItem(ORARIO_CLASS_STORAGE_KEY);
  if (saved && allClasses.includes(saved.toUpperCase())) {
    return saved.toUpperCase();
  }
  setStatus("Rilevo la tua classe dall'agenda…");
  return detectClassFromAgenda(allClasses);
}

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/";
    return;
  }

  setLoading(true, "Verifica scuola…");
  try {
    const access = await checkOrarioSchoolAccess();
    if (!access.eligible) {
      showOrarioSchoolGate(access.detail);
      return;
    }
    hideOrarioSchoolGate();

    bindClassPicker();
    currentHighlight = computeCurrentSlot();
    startHighlightClock();

    window.LoadingScreen?.setMessage("Caricamento orario…");
    const meta = await fetchOrarioMeta();
    allClasses = Array.isArray(meta?.classes) ? meta.classes : [];
    if (!allClasses.length) {
      setStatus("Elenco classi non disponibile.", true);
      return;
    }
    updateComboboxList();

    const initial = await resolveInitialClass();
    const input = document.getElementById("orarioClassInput");
    if (initial) {
      if (input) input.value = initial;
      await loadScheduleForClass(initial, { persist: false });
    } else {
      setStatus("Classe non rilevata: scegiline una dal menu.", true);
      if (input) input.placeholder = "Es. 4EI";
    }
  } catch (err) {
    if (err instanceof OrarioAccessError) {
      showOrarioSchoolGate(err.message);
      return;
    }
    console.error("[orario] init failed:", err);
    setStatus("Errore di caricamento. Ricarica la pagina.", true);
  } finally {
    setLoading(false);
  }
});

async function handleAuthFail(res) {
  try {
    await res.json();
  } catch {
    /* ignore */
  }
  localStorage.removeItem("loggedIn");
  window.location.href = "/";
}

function goToHome() {
  window.location.href = "/dashboard/";
}

function goToOrario() {
  window.location.href = "/orario/";
}

function goToVoti() {
  window.location.href = "/voti/";
}

function goToAssenze() {
  window.location.href = "/assenze/";
}

function logout() {
  localStorage.removeItem("loggedIn");
  localStorage.removeItem("username");
  window.location.href = "/";
}

function initMobileMenu() {
  const toggle = document.getElementById("navToggle");
  const drawer = document.getElementById("mobileNavDrawer");
  const backdrop = document.getElementById("mobileNavBackdrop");
  const closeBtn = document.getElementById("navDrawerClose");
  if (!toggle || !drawer || !backdrop) return;

  const openMenu = () => {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    document.body.classList.add("menu-open");
    toggle.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    drawer.setAttribute("aria-hidden", "false");
  };

  const closeMenu = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    document.body.classList.remove("menu-open");
    toggle.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
  };

  toggle.addEventListener("click", () =>
    drawer.classList.contains("open") ? closeMenu() : openMenu(),
  );
  backdrop.addEventListener("click", closeMenu);
  closeBtn?.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  drawer
    .querySelectorAll("button")
    .forEach((btn) => btn.addEventListener("click", closeMenu));
}
