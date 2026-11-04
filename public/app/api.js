// Client API: fetch con cookie, errori leggibili, cache "stale-while-revalidate".
// Le viste mostrano subito l'ultimo dato noto (memoria o sessionStorage) e si aggiornano
// quando arriva quello fresco: navigare tra le sezioni è istantaneo.

const apiBase = () => window.APP_CONFIG?.HTTP_BASE ?? "";
export const apiUrl = (path) => `${apiBase()}/api${path}`;

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const listeners = new Set();
/** Notifica quando il server dice che la sessione non è più valida (401). */
export function onUnauthorized(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function request(path, { method = "GET", body, signal, quiet401 = false } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError(0, "Connessione assente o server non raggiungibile.");
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : null;
    if (res.status === 401 && !quiet401) listeners.forEach((fn) => fn(detail));
    const fallback = res.status >= 500 ? "ClasseViva non risponde in questo momento. Riprova tra poco." : `Errore ${res.status}`;
    throw new ApiError(res.status, detail || fallback, data);
  }
  return data;
}

export const get = (path, opts) => request(path, { ...opts, method: "GET" });
export const post = (path, body, opts) => request(path, { ...opts, method: "POST", body: body ?? {} });
export const put = (path, body, opts) => request(path, { ...opts, method: "PUT", body: body ?? {} });
export const patch = (path, body, opts) => request(path, { ...opts, method: "PATCH", body: body ?? {} });
export const del = (path, opts) => request(path, { ...opts, method: "DELETE" });

/* ---------------- cache ---------------- */
const memory = new Map(); // key -> { value, at }
const inflight = new Map();
const STORE_PREFIX = "aulera:c:";

// Nell'app (telefono personale) i dati restano anche chiudendola: alla riapertura ogni sezione mostra
// subito l'ultimo dato noto e lo aggiorna in sottofondo. Sul sito (magari un PC condiviso) solo per la
// scheda aperta. Il logout svuota tutto.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
function storage() {
  try { return NATIVE ? localStorage : sessionStorage; } catch { return null; }
}
function readStore(key) {
  try {
    const raw = storage()?.getItem(STORE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeStore(key, entry) {
  try { storage()?.setItem(STORE_PREFIX + key, JSON.stringify(entry)); } catch { /* quota / privata */ }
}
function dropStored(prefix) {
  for (const s of [() => sessionStorage, () => localStorage]) {
    try {
      const st = s();
      Object.keys(st).filter((k) => k.startsWith(prefix)).forEach((k) => st.removeItem(k));
    } catch { /* niente */ }
  }
}
export function clearCache() {
  memory.clear();
  dropStored(STORE_PREFIX);
}
export function invalidate(prefix) {
  for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
  dropStored(STORE_PREFIX + prefix);
}

/**
 * Restituisce { cached, fresh }: `cached` è il valore noto (o null), `fresh` una Promise.
 * Con maxAge (ms) il valore in cache più giovane non viene ricaricato.
 */
export function cached(key, loader, { maxAge = 60_000 } = {}) {
  const entry = memory.get(key) || readStore(key);
  if (entry && !memory.has(key)) memory.set(key, entry);
  const young = entry && Date.now() - entry.at < maxAge;
  let fresh;
  if (young) fresh = Promise.resolve(entry.value);
  else if (inflight.has(key)) fresh = inflight.get(key);
  else {
    fresh = loader().then((value) => {
      const e = { value, at: Date.now() };
      memory.set(key, e);
      writeStore(key, e);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, fresh);
  }
  return { cached: entry ? entry.value : null, fresh, isFresh: !!young };
}

/** Carica con cache e chiama render(data, {stale}) prima col dato noto e poi col nuovo. */
export async function load(key, loader, render, opts) {
  const { cached: c, fresh, isFresh } = cached(key, loader, opts);
  if (c !== null && c !== undefined) render(c, { stale: !isFresh });
  try {
    const value = await fresh;
    if (!isFresh || c === null || c === undefined) render(value, { stale: false });
    return value;
  } catch (err) {
    if (c === null || c === undefined) throw err;
    return c; // resta il dato noto
  }
}

/** Apre un file del registro (allegato, materiale, documento) tramite link temporaneo. */
export async function openFile(params) {
  const { url } = await post("/file-link", params);
  const full = `${apiBase()}${url}`;
  const nativeOpen = window.Capacitor?.Plugins?.SpaggiariLogin?.openExternal;
  if (window.Capacitor?.isNativePlatform?.() && nativeOpen) {
    // Nell'app: il browser di sistema scarica/apre il file (il link non richiede cookie).
    const absolute = full.startsWith("http") ? full : `${location.origin}${full}`;
    await nativeOpen({ url: absolute });
    return;
  }
  // Con "noopener" window.open restituisce sempre null: lo stacco a mano.
  const w = window.open(full, "_blank");
  if (w) w.opener = null;
  else location.href = full;
}
