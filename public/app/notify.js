// Notifiche lato client: polling leggero del conteggio, badge, toast per le novità arrivate
// con l'app aperta e (sul web, se l'utente lo ha permesso) notifiche di sistema a scheda in
// background. Nell'app Android le notifiche di sistema le fa un worker nativo (GET /notifiche).
// main.js chiama startNotifications() dopo il login e stopNotifications() al logout.
import { get, post, invalidate } from "aulera/api";
import { state, emit, store } from "aulera/state";
import { toast, $, $$ } from "aulera/ui";
import { navigate } from "aulera/main";

const POLL_MS = 60_000;
const VISIBLE_REPOLL_MS = 15_000;
// Cache client delle viste da svuotare quando arriva una novità di quel tipo.
const CACHE_PREFIX = { voti: "voti:", bacheca: "bacheca", note: "note", agenda: "agenda", assenze: "assenze", didattica: "didattica" };

let running = false;
let timer = null;
let latestId = null; // ultimo id noto in questa apertura dell'app (null = non ancora letto)
let lastPoll = 0;
let inflight = null;

export const isNativeApp = () => !!window.Capacitor?.isNativePlatform?.();

function setBadges(n) {
  state.unread.notifiche = n;
  const label = n > 99 ? "99+" : String(n);
  $$("[data-unread='notifiche']").forEach((b) => { b.textContent = label; b.hidden = !n; });
}

/* ---------------- notifiche di sistema (solo web) ---------------- */
/** "native" (ci pensa l'app) | "unsupported" | "default" | "granted" | "denied". */
export function systemPermission() {
  if (isNativeApp()) return "native";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}
/** Notifiche di sistema attive: permesso concesso e non disattivate dall'utente. */
export function systemEnabled() {
  return systemPermission() === "granted" && store.get("notif:system", true) !== false;
}
export function setSystemEnabled(on) { store.set("notif:system", !!on); }

/** Da chiamare SOLO dopo un'azione esplicita dell'utente (es. tocco su "Attiva"). */
export async function requestSystemNotifications() {
  const current = systemPermission();
  if (current === "native" || current === "unsupported") return current;
  let result = current;
  if (current === "default") {
    try { result = await Notification.requestPermission(); } catch { result = Notification.permission; }
  }
  if (result === "granted") setSystemEnabled(true);
  return result;
}

function showSystem(item) {
  try {
    const n = new Notification(item.title, {
      body: item.body || "",
      tag: `ardesia-${item.id}`,
      icon: "/assets/apple-touch-icon.png",
      lang: "it",
    });
    n.onclick = () => { window.focus(); n.close(); openNotification(item); };
  } catch { /* alcuni browser (Android web) richiedono il service worker: niente */ }
}

/* ---------------- toast cliccabile ---------------- */
function showToast(item) {
  toast(item.title, { duration: 6000 });
  const el = $(".toaster")?.lastElementChild;
  if (!el) return;
  el.classList.add("notif-toast");
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const text = el.querySelector("span:not(.dot)");
  if (text) {
    text.className = "notif-toast-text";
    text.replaceChildren();
    const t = document.createElement("strong");
    t.textContent = item.title;
    text.append(t);
    if (item.body) {
      const b = document.createElement("small");
      b.textContent = item.body;
      text.append(b);
    }
  }
  const open = () => { el.dataset.removed = "true"; openNotification(item); };
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
}

/** Segna letta e apre la sezione collegata. */
export function openNotification(item) {
  if (!item.read && item.id) markRead([item.id]).catch(() => {});
  item.read = true;
  navigate(item.url || "/notifiche");
}

/* ---------------- API usate anche dalla vista ---------------- */
export async function markRead(ids) {
  const body = ids === "all" ? { all: true } : { ids };
  const res = await post("/notifiche/letto", body);
  setBadges(res.unread);
  emit("notifiche", { unread: res.unread, latest_id: res.latest_id, local: true });
  return res;
}

/** Forza un controllo di ClasseViva ora (max 1 al minuto, lato server). */
export async function syncNow() {
  const res = await post("/notifiche/sincronizza");
  const prev = latestId;
  if (res.latest_id > (prev ?? 0)) await afterNew(prev ?? 0, { announce: false });
  latestId = Math.max(latestId ?? 0, res.latest_id);
  setBadges(res.unread);
  emit("notifiche", { unread: res.unread, latest_id: res.latest_id, local: true });
  return res;
}

export function refreshCount() { return poll(); }

/* ---------------- polling ---------------- */
async function afterNew(prev, { announce }) {
  let items = [];
  try { items = (await get("/notifiche?limit=20")).items || []; } catch { return; }
  const fresh = items.filter((it) => it.id > prev).sort((a, b) => a.id - b.id);
  const kinds = new Set(fresh.map((it) => it.kind));
  kinds.forEach((k) => CACHE_PREFIX[k] && invalidate(CACHE_PREFIX[k]));
  if (kinds.has("bacheca")) emit("unread"); // aggiorna anche il badge della bacheca
  if (!announce) return;
  const unread = fresh.filter((it) => !it.read);
  if (!unread.length) return;
  if (document.visibilityState === "visible") {
    if (location.pathname.startsWith("/notifiche")) return; // l'elenco si aggiorna da solo
    if (unread.length > 2) showToast({ title: `${unread.length} nuove notifiche`, body: unread.map((i) => i.title).slice(0, 2).join(" · "), url: "/notifiche", read: true });
    else unread.forEach(showToast);
  } else if (systemEnabled()) {
    if (unread.length > 3) showSystem({ id: unread.at(-1).id, title: `${unread.length} nuove notifiche`, body: unread.map((i) => i.title).slice(0, 3).join(" · "), url: "/notifiche", read: true });
    else unread.forEach(showSystem);
  }
}

function poll({ announce = true } = {}) {
  if (!running || !state.session) return Promise.resolve(null);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = await get("/notifiche/conteggio");
      lastPoll = Date.now();
      setBadges(c.unread);
      if (latestId === null) latestId = c.latest_id;
      else if (c.latest_id > latestId) {
        const prev = latestId;
        latestId = c.latest_id;
        await afterNew(prev, { announce });
      }
      emit("notifiche", c);
      return c;
    } catch {
      return null; // rete assente: riprovo al prossimo giro (i 401 li gestisce api.js)
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function onVisible() {
  if (document.visibilityState === "visible" && Date.now() - lastPoll > VISIBLE_REPOLL_MS) poll();
}
const onOnline = () => poll();

export function startNotifications() {
  if (running) return;
  running = true;
  latestId = null;
  poll({ announce: false });
  timer = setInterval(() => poll(), POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
}

export function stopNotifications() {
  running = false;
  clearInterval(timer);
  timer = null;
  latestId = null;
  inflight = null;
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("online", onOnline);
  state.unread.notifiche = 0;
}
