// Stato globale: sessione, anno scolastico selezionato, tema, preferenze.
import { get, put } from "aulera/api";

const listeners = new Map();
export const state = {
  session: null, // risposta di /session/me
  years: null, // { current, years: [{id,label,is_current}] }
  year: null, // anno selezionato (id, es. "2026/27")
  theme: "auto",
  unread: { bacheca: 0, note: 0 },
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) { listeners.get(event)?.forEach((fn) => fn(payload)); }

const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(`aulera:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`aulera:${key}`, JSON.stringify(value)); } catch { /* storage non disponibile */ } },
  remove(key) { try { localStorage.removeItem(`aulera:${key}`); } catch { /* niente */ } },
};
export { store };

/* ---------------- preferenze (aspetto e layout) ---------------- */
// Salvate sul server (sincronizzate tra telefono e PC) e in locale per applicarle subito.
export const DEFAULT_TABS = ["/oggi", "/voti", "/agenda", "/bacheca"];
export const HOME_CARDS = [
  { id: "media", label: "Media generale" },
  { id: "lezioni", label: "Lezioni di oggi" },
  { id: "agenda", label: "Prossimi giorni" },
  { id: "voti", label: "Ultimi voti" },
  { id: "bacheca", label: "Bacheca" },
  { id: "assenze", label: "Presenze" },
];
export const ACCENTS = [
  { id: "red", label: "Rosso", color: "#ff453a" },
  { id: "orange", label: "Arancio", color: "#ff9f0a" },
  { id: "pink", label: "Rosa", color: "#ff375f" },
  { id: "purple", label: "Viola", color: "#bf5af2" },
  { id: "blue", label: "Blu", color: "#0a84ff" },
  { id: "teal", label: "Turchese", color: "#40c8e0" },
  { id: "green", label: "Verde", color: "#30d158" },
  { id: "graphite", label: "Grafite", color: "#98989d" },
];
const DEFAULT_PREFS = { theme: "auto", accent: "red", density: "comfortable", background: true, tabs: DEFAULT_TABS, home_order: HOME_CARDS.map((c) => c.id), home_hidden: [] };
state.prefs = { ...DEFAULT_PREFS, ...store.get("prefs", {}) };
// Migrazione: tema salvato dalla versione precedente.
if (store.get("theme") && !store.get("prefs")) state.prefs.theme = store.get("theme");

const media = window.matchMedia("(prefers-color-scheme: light)");
export function applyTheme(pref = state.prefs.theme) {
  state.theme = pref;
  const light = pref === "light" || (pref === "auto" && media.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? "#f2f2f7" : "#1c1c1e";
}
export function applyPrefs(p = state.prefs) {
  applyTheme(p.theme);
  const root = document.documentElement;
  if (p.accent && p.accent !== "red") root.dataset.accent = p.accent; else delete root.dataset.accent;
  root.classList.toggle("density-compact", p.density === "compact");
  root.classList.toggle("no-aurora", p.background === false);
}
let saveTimer = null;
export function setPrefs(partial, { sync = true } = {}) {
  state.prefs = { ...state.prefs, ...partial };
  store.set("prefs", state.prefs);
  store.set("theme", state.prefs.theme);
  applyPrefs();
  emit("prefs", state.prefs);
  if (sync && state.session) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => put("/preferenze", partial).catch(() => {}), 400);
  }
}
/** Dopo il login: le preferenze del server (se esistono) vincono su quelle locali. */
export async function loadPrefs() {
  try {
    const { prefs } = await get("/preferenze");
    if (prefs && Object.keys(prefs).length) setPrefs(prefs, { sync: false });
    else put("/preferenze", state.prefs).catch(() => {}); // primo accesso: carica quelle locali
  } catch { /* offline: restano quelle locali */ }
}
export function setTheme(pref) { setPrefs({ theme: pref }); emit("theme", pref); }
media.addEventListener?.("change", () => { if (state.prefs.theme === "auto") applyTheme("auto"); });

/* ---------------- anno scolastico ---------------- */
export async function loadYears() {
  try {
    state.years = await get("/school-years");
  } catch {
    state.years = state.years || null;
  }
  const current = state.years?.current || null;
  const saved = store.get("year");
  const valid = state.years?.years?.some((y) => y.id === saved);
  state.year = valid ? saved : current;
  return state.years;
}
export function isCurrentYear() { return !state.years || state.year === state.years.current; }
export function yearLabel(id = state.year) { return state.years?.years?.find((y) => y.id === id)?.label || id || ""; }
export function setYear(id) {
  if (id === state.year) return;
  state.year = id;
  store.set("year", id);
  emit("year", id);
}
export function yearQuery(id = state.year) { return id ? `school_year=${encodeURIComponent(id)}` : ""; }

/* ---------------- sessione ---------------- */
export function firstName() {
  const full = state.session?.full_name || "";
  const name = full.trim().split(/\s+/)[0] || "";
  return name ? name[0].toUpperCase() + name.slice(1).toLowerCase() : "";
}
export function isMarconi() {
  return ["VRIT0007", "VRTF03000V"].includes(String(state.session?.school_code || "").toUpperCase());
}
