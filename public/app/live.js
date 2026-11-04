// Aggiornamenti in tempo reale: un WebSocket per dispositivo (/api/ws/events, realtime.py).
// Il server manda solo "cosa è cambiato" ({type: "friends" | "notifiche" | "compiti" | "prefs" |
// "devices", ...}); qui diventano eventi "live" sul bus di state, e main.js / le viste ricaricano i
// dati che servono. Riconnessione automatica con attesa crescente; quando la connessione torna (o
// l'app torna in primo piano dopo un po') parte un evento {type: "resync"} per recuperare ciò che
// è successo nel frattempo.
import { emit } from "aulera/state";

const PING_MS = 25_000;
const RESYNC_AFTER_HIDDEN_MS = 20_000;

let wanted = false;
let ws = null;
let attempts = 0;
let retryTimer = 0;
let pingTimer = 0;
let everConnected = false;
let hiddenAt = 0;

function dispatch(event) {
  emit("live", event);
  emit(`live:${event.type}`, event);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!wanted || document.visibilityState === "hidden") return; // riprovo quando torna visibile
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)) + Math.random() * 500;
  attempts++;
  retryTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(retryTimer);
  if (!wanted || ws || !window.APP_CONFIG?.wsUrl || !("WebSocket" in window)) return;
  let socket;
  try { socket = new WebSocket(window.APP_CONFIG.wsUrl("/api/ws/events")); } catch { scheduleRetry(); return; }
  ws = socket;
  socket.onopen = () => {
    attempts = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (socket.readyState === 1) socket.send("ping"); }, PING_MS);
    if (everConnected) dispatch({ type: "resync", reason: "reconnect" });
    everConnected = true;
  };
  socket.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    if (!event?.type || event.type === "ready" || event.type === "pong") return;
    dispatch(event);
  };
  socket.onclose = (e) => {
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (e.code === 4401) return; // sessione non valida: ci pensa il logout
    scheduleRetry();
  };
  socket.onerror = () => { try { socket.close(); } catch { /* già chiuso */ } };
}

function onVisibility() {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (!ws) { attempts = 0; connect(); }
  if (away > RESYNC_AFTER_HIDDEN_MS) dispatch({ type: "resync", reason: "visible" });
}
const onOnline = () => { attempts = 0; connect(); };

export function startLive() {
  if (wanted) return;
  wanted = true;
  everConnected = false;
  connect();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
}

export function stopLive() {
  wanted = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("online", onOnline);
  if (ws) { try { ws.close(1000); } catch { /* niente */ } }
  ws = null;
}

export const isLive = () => ws?.readyState === 1;
