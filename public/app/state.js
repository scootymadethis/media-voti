// Stato globale: sessione, anno scolastico selezionato, tema, preferenze.
import { get } from "aulera/api";

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

/* ---------------- tema ---------------- */
const media = window.matchMedia("(prefers-color-scheme: light)");
export function applyTheme(pref = store.get("theme", "auto")) {
  state.theme = pref;
  const light = pref === "light" || (pref === "auto" && media.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? "#f2f3f7" : "#05070b";
}
export function setTheme(pref) { store.set("theme", pref); applyTheme(pref); emit("theme", pref); }
media.addEventListener?.("change", () => { if (state.theme === "auto") applyTheme("auto"); });

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
