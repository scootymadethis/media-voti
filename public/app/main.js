// Avvio, router e struttura (sidebar desktop, tab bar mobile, barra compatta).
import { get, post, onUnauthorized, clearCache, load } from "aulera/api";
import { state, applyPrefs, loadPrefs, loadYears, emit, on, store, setYear, yearLabel, DEFAULT_TABS } from "aulera/state";
import { startNotifications, stopNotifications } from "aulera/notify";
import { html, raw, icon, setHTML, $, $$, openSheet, openMenu, toast, staggerIndex, animateRings, miniMarkdown } from "aulera/ui";

// Le viste si caricano con la stessa versione dell'entry (vedi importmap in index.html).
const V = new URL(import.meta.url).searchParams.get("v") || "1";
const view = (name) => () => import(`./views/${name}.js?v=${V}`);
const DESKTOP = matchMedia("(hover: hover) and (pointer: fine)");

applyPrefs();
if (/Chrome\/|Chromium\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent)) {
  document.documentElement.classList.add("engine-chromium");
}

export const ROUTES = [
  { path: "/oggi", title: "Oggi", icon: "today", group: "Il tuo spazio", load: view("oggi") },
  { path: "/voti", title: "Voti", icon: "grades", group: "Registro", load: view("voti") },
  { path: "/agenda", title: "Agenda", icon: "calendar", group: "Registro", load: view("agenda") },
  { path: "/orario", title: "Orario", icon: "clock", group: "Registro", load: view("orario") },
  { path: "/assenze", title: "Assenze", icon: "absences", group: "Registro", load: view("assenze") },
  { path: "/lezioni", title: "Lezioni", icon: "lessons", group: "Registro", load: view("lezioni") },
  { path: "/bacheca", title: "Bacheca", icon: "megaphone", group: "Comunicazioni", load: view("bacheca") },
  { path: "/note", title: "Note", icon: "note", group: "Comunicazioni", load: view("note") },
  { path: "/didattica", title: "Didattica", icon: "folder", group: "Comunicazioni", load: view("didattica") },
  { path: "/documenti", title: "Documenti", icon: "doc", group: "Comunicazioni", load: view("documenti") },
  { path: "/libri", title: "Libri", icon: "books", group: "Comunicazioni", load: view("libri") },
  { path: "/classifica", title: "Classifica", icon: "trophy", group: "Community", load: view("classifica") },
  { path: "/amici", title: "Amici", icon: "friends", group: "Community", load: view("amici") },
  { path: "/notifiche", title: "Notifiche", icon: "bell", group: "Account", load: view("notifiche") },
  { path: "/dispositivi", title: "Dispositivi", icon: "devices", group: "Account", load: view("dispositivi") },
  { path: "/personalizza", title: "Personalizza", icon: "palette", group: "Account", load: view("personalizza") },
  { path: "/profilo", title: "Profilo", icon: "person", group: "Account", load: view("profilo") },
  { path: "/admin", title: "Admin", icon: "shield", group: "Account", admin: true, load: view("admin") },
];
// Le 4 sezioni della tab bar sono personalizzabili (Personalizza → Barra in basso).
let TABS = DEFAULT_TABS.slice();
function currentTabs() {
  const chosen = (state.prefs?.tabs || []).filter((p) => findRoute(p));
  const tabs = chosen.length === 4 ? chosen : DEFAULT_TABS;
  return tabs.slice(0, 4);
}
const ALIASES = { "/": "/oggi", "/dashboard": "/oggi", "/collega": "/dispositivi", "/home": "/oggi" };

const app = document.getElementById("app");
let current = null; // { route, module, cleanup }
let renderToken = 0;

/* ---------------- navigazione ---------------- */
function normalizePath(pathname) {
  let p = pathname.replace(/\/+$/, "") || "/";
  p = ALIASES[p] || p;
  return p;
}
export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.pathname + url.search === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"]({}, "", url.pathname + url.search);
  renderRoute();
}
window.addEventListener("popstate", () => renderRoute());
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.preventDefault();
  // Ancora nella stessa pagina (#sezione): scorrimento morbido, senza passare dal router.
  if (url.hash && url.pathname === location.pathname && url.search === location.search) {
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (target) target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    return;
  }
  navigate(url.pathname + url.search);
});

function findRoute(path) {
  return ROUTES.find((r) => r.path === path && (!r.admin || state.session?.is_admin));
}

async function renderRoute() {
  const path = normalizePath(location.pathname);
  if (!state.session) return showLogin();
  if (path === "/login") return navigate("/oggi", { replace: true });
  const route = findRoute(path);
  if (!route) return navigate("/oggi", { replace: true });
  if (normalizePath(location.pathname) !== location.pathname.replace(/\/+$/, "")) {
    history.replaceState({}, "", route.path + location.search);
  }
  const token = ++renderToken;
  updateNav(route);
  let mod;
  try {
    mod = (await route.load()).default;
  } catch (err) {
    console.error(err);
    toast("Impossibile aprire la sezione. Aggiorna la pagina.", { error: true });
    return;
  }
  if (token !== renderToken) return;
  const swap = () => mountView(route, mod);
  // La View Transition fotografa tutta la pagina (vetro sfocato compreso): sui telefoni costa frame,
  // lì basta l'entrata della vista (.view-enter, solo transform/opacity). Resta sui computer.
  if (document.startViewTransition && current && DESKTOP.matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(swap);
  } else swap();
}

function mountView(route, mod) {
  try { current?.cleanup?.(); } catch { /* vista già smontata */ }
  const main = $("#view");
  main.replaceChildren();
  const root = document.createElement("div");
  root.className = "page view-enter";
  main.append(root);
  document.title = `${route.title} · Skoolio`;
  window.scrollTo({ top: 0 });
  const ctx = {
    route,
    params: new URLSearchParams(location.search),
    navigate,
    refresh: () => mountView(route, mod),
  };
  current = { route, mod, cleanup: null };
  Promise.resolve(mod.render(root, ctx)).then((cleanup) => {
    if (current?.route === route) current.cleanup = typeof cleanup === "function" ? cleanup : null;
  }).catch((err) => {
    console.error(err);
    setHTML(root, html`<div class="card card-pad error-box"><p class="title-3">Qualcosa è andato storto</p><p class="body-2">${err?.message || ""}</p></div>`);
  });
  observeTitle(root, route);
}

/* ---------------- shell ---------------- */
const BADGED = { "/bacheca": "bacheca", "/notifiche": "notifiche" };
function navItem(r) {
  return html`<a class="nav-item" href="${r.path}" data-path="${r.path}">${icon(r.icon)}<span>${r.title}</span>
    ${BADGED[r.path] ? raw(`<span class="nav-badge" data-unread="${BADGED[r.path]}" hidden></span>`) : ""}</a>`;
}
function buildShell() {
  TABS = currentTabs();
  const groups = [];
  ROUTES.filter((r) => !r.admin || state.session?.is_admin).forEach((r) => {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, items: [] }));
    g.items.push(r);
  });
  setHTML(app, html`
    <aside class="sidebar glass" aria-label="Navigazione">
      <div class="brand-row"><a class="brand" href="/oggi" aria-label="Skoolio"><img class="logo-img logo-on-dark" src="/assets/skoolio-logo.png" alt="Skoolio" width="771" height="160" /><img class="logo-img logo-on-light" src="/assets/skoolio-logo-dark.png" alt="Skoolio" width="771" height="160" /></a>
        <a class="bell-btn" href="/notifiche" aria-label="Notifiche">${icon("bell")}<span class="bell-badge" data-unread="notifiche" hidden></span></a></div>
      <nav>${groups.map((g) => html`<div class="nav-group"><p class="nav-group-label overline">${g.name}</p>${g.items.map(navItem)}</div>`)}</nav>
      <div class="sidebar-foot">
        <button type="button" class="nav-item" data-action="logout">${icon("logout")}<span>Esci</span></button>
      </div>
    </aside>
    <header class="topbar glass" aria-hidden="true">
      <div class="topbar-side"></div><div class="topbar-title"></div><div class="topbar-side end" data-topbar-actions></div>
    </header>
    <a class="bell-float glass" href="/notifiche" aria-label="Notifiche">${icon("bell")}<span class="bell-badge" data-unread="notifiche" hidden></span></a>
    <main class="main" id="view-wrap"><div id="view"></div></main>
    <nav class="tabbar glass glass-liquid" aria-label="Sezioni principali">
      <span class="tab-indicator" aria-hidden="true"></span>
      ${TABS.map((p) => { const r = findRoute(p); return html`<a class="tab" href="${r.path}" data-path="${r.path}">${icon(r.icon)}<span>${r.title}</span>${BADGED[p] ? raw(`<span class="tab-badge" data-unread="${BADGED[p]}" hidden></span>`) : ""}</a>`; })}
      <button type="button" class="tab" data-action="more" data-path="more">${icon("more")}<span>Altro</span></button>
    </nav>`);
  $("[data-action='logout']", app).addEventListener("click", logout);
  $("[data-action='more']", app).addEventListener("click", openMoreSheet);
}

function updateNav(route) {
  $$(".nav-item[data-path], .tab[data-path]", app).forEach((el) => {
    const active = el.dataset.path === route.path || (el.dataset.path === "more" && !TABS.includes(route.path));
    if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
  const idx = TABS.includes(route.path) ? TABS.indexOf(route.path) : 4;
  const ind = $(".tab-indicator", app);
  if (ind) ind.style.transform = `translateX(${idx * 100}%)`;
}

function openMoreSheet() {
  const items = ROUTES.filter((r) => !TABS.includes(r.path) && (!r.admin || state.session?.is_admin));
  const sheet = openSheet({
    title: "Altro",
    content: html`<div class="more-grid">${items.map((r) => html`<a class="more-tile pressable" href="${r.path}">
      <span class="row-icon">${icon(r.icon)}</span><span class="title-3">${r.title}</span></a>`)}</div>
      <button type="button" class="btn btn-block" data-action="logout" style="margin-top:16px">${icon("logout")}Esci</button>`,
  });
  sheet.body.addEventListener("click", (e) => {
    if (e.target.closest("a")) sheet.close();
    if (e.target.closest("[data-action='logout']")) { sheet.close(); logout(); }
  });
}

/* Il titolo grande scorre via → compare la barra compatta col titolo. */
let titleObserver = null;
function observeTitle(root, route) {
  titleObserver?.disconnect();
  const bar = $(".topbar", app);
  if (!bar) return;
  $(".topbar-title", bar).textContent = route.title;
  bar.classList.remove("is-visible");
  requestAnimationFrame(() => {
    const title = $(".large-title", root);
    if (!title) return;
    titleObserver = new IntersectionObserver(([entry]) => {
      bar.classList.toggle("is-visible", !entry.isIntersecting && entry.boundingClientRect.top < 0);
    }, { rootMargin: "-60px 0px 0px 0px" });
    titleObserver.observe(title);
  });
}

/* ---------------- intestazione vista + selettore anno ---------------- */
export function pageHeader({ eyebrow = "", title, subtitle = "", actions = "" }) {
  return html`<header class="page-header">
    <div>${eyebrow ? html`<p class="overline eyebrow">${eyebrow}</p>` : ""}<h1 class="large-title">${title}</h1>
      ${subtitle ? html`<p class="body-2 subtitle">${subtitle}</p>` : ""}</div>
    ${actions ? html`<div class="header-actions">${actions}</div>` : ""}
  </header>`;
}
export function yearButton() {
  if (!state.years?.years?.length) return "";
  return html`<button type="button" class="btn year-btn" data-year-picker aria-haspopup="menu">${icon("history")}<span>${yearLabel()}</span>${icon("chevronDown")}</button>`;
}
export function bindYearPicker(root, onChange) {
  $$("[data-year-picker]", root).forEach((btn) => btn.addEventListener("click", () => {
    openMenu(btn, state.years.years.map((y) => ({ value: y.id, label: y.is_current ? `${y.label} · in corso` : y.label, checked: y.id === state.year })), (id) => {
      setYear(id);
      onChange?.(id);
    });
  }));
}
export { staggerIndex, animateRings };

/* ---------------- login / logout ---------------- */
async function showLogin() {
  titleObserver?.disconnect();
  document.title = "Skoolio — Il tuo registro, finalmente chiaro";
  const mod = (await import(`./views/login.js?v=${V}`)).default;
  app.replaceChildren();
  const root = document.createElement("div");
  app.append(root);
  current = { route: { path: "/login" }, mod, cleanup: await mod.render(root, { onLoggedIn: boot, params: new URLSearchParams(location.search) }) };
}

export async function logout() {
  stopNotifications();
  try { await post("/logout"); } catch { /* sessione già chiusa */ }
  clearCache();
  state.session = null;
  store.remove("lbSync");
  history.replaceState({}, "", "/");
  showLogin();
}

onUnauthorized(() => {
  if (!state.session) return;
  stopNotifications();
  state.session = null;
  clearCache();
  toast("Sessione scaduta: accedi di nuovo con SPID o CIE.", { error: true });
  history.replaceState({}, "", "/");
  showLogin();
});

/* ---------------- avvio ---------------- */
async function boot() {
  try {
    state.session = await get("/session/me", { quiet401: true });
  } catch (err) {
    state.session = null;
    if (err.status && err.status >= 500) {
      setHTML(app, html`<div class="empty" style="min-height:100dvh">${icon("refresh")}<p class="title-3">ClasseViva non risponde</p>
        <p class="body-2">Riprova tra qualche istante.</p><button class="btn btn-primary" onclick="location.reload()">Riprova</button></div>`);
      return;
    }
  }
  if (!state.session) return showLogin();
  await Promise.all([loadYears(), loadPrefs()]);
  buildShell();
  if (normalizePath(location.pathname) === "/" || location.pathname === "/login") history.replaceState({}, "", "/oggi" + location.search);
  current = null;
  await renderRoute();
  afterBoot();
}

function afterBoot() {
  refreshUnread();
  // App Android: permesso per le notifiche di sistema (una sola volta, dopo il primo accesso).
  const native = window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.SpaggiariLogin?.requestNotifications;
  if (native && !store.get("notifAsked")) {
    store.set("notifAsked", true);
    setTimeout(() => window.Capacitor.Plugins.SpaggiariLogin.requestNotifications().catch(() => {}), 1500);
  }
  try { startNotifications(); } catch (err) { console.warn("[notifiche]", err); }
  showAnnouncement();
  syncLeaderboards();
  registerServiceWorker();
  prefetchViews();
}

/** Scarica in sottofondo il codice di tutte le sezioni: al primo tocco si aprono subito. */
function prefetchViews() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 200));
  const queue = ROUTES.filter((r) => !r.admin || state.session?.is_admin).map((r) => r.load);
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    load().catch(() => {}).finally(() => idle(next, { timeout: 2000 }));
  };
  setTimeout(() => idle(next, { timeout: 2000 }), 600);
}

/** File statici sul dispositivo (Android e browser; su iPhone il WebView non lo supporta e si salta). */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:" && location.hostname !== "127.0.0.1") return;
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    const post = () => (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "version", v: V });
    if (reg.active) post(); else navigator.serviceWorker.ready.then(post);
  }).catch(() => { /* facoltativo */ });
}

export async function refreshUnread() {
  try {
    await load("bacheca", () => get("/bacheca"), (data) => {
      const n = (data.items || []).filter((i) => !i.readStatus).length;
      state.unread.bacheca = n;
      $$("[data-unread='bacheca']", app).forEach((b) => { b.textContent = n > 99 ? "99+" : String(n); b.hidden = !n; });
    }, { maxAge: 120_000 });
  } catch { /* opzionale */ }
}
on("unread", refreshUnread);

async function showAnnouncement() {
  try {
    const a = await get("/announcement/me");
    if (!a?.should_show) return;
    const sheet = openSheet({
      title: a.title || "Novità",
      content: html`<div class="md">${miniMarkdown(a.body_markdown)}</div><button type="button" class="btn btn-primary btn-block" data-ok style="margin-top:20px">Ho capito</button>`,
      onClose: () => post("/announcement/dismiss", { content_version: a.content_version }).catch(() => {}),
    });
    $("[data-ok]", sheet.body).addEventListener("click", () => sheet.close());
  } catch { /* nessun annuncio */ }
}

/* Tiene aggiornate le classifiche (una volta ogni 6 ore), rispettando la visibilità scelta. */
async function syncLeaderboards() {
  const last = store.get("lbSync", 0);
  if (Date.now() - last < 6 * 3600_000) return;
  store.set("lbSync", Date.now());
  try {
    const [abs, avg] = await Promise.all([get("/leaderboard/me").catch(() => null), get("/average-leaderboard/me?subject_name=Media%20generale&period_key=generale").catch(() => null)]);
    const visAbs = abs?.item ? abs.item.visible_in_leaderboard !== false : abs?.default_visible_in_leaderboard !== false;
    const visAvg = avg?.item ? avg.item.visible_in_leaderboard !== false : avg?.default_visible_in_leaderboard !== false;
    await Promise.allSettled([
      post("/leaderboard/update", { hours: 0, visible_in_leaderboard: visAbs }),
      post("/average-leaderboard/update", { subject_name: "Media generale", period_key: "generale", period_label: "Media generale", average: 0, visible_in_leaderboard: visAvg }),
    ]);
  } catch { /* non bloccante */ }
}

// Cambiate le sezioni della tab bar: ricostruisce la shell mantenendo la vista corrente.
on("prefs", (p) => {
  if (!state.session || !$(".tabbar", app)) return;
  const next = currentTabs();
  if (next.join() === TABS.join()) return;
  buildShell();
  current = null;
  renderRoute();
  refreshUnread();
});

boot();
export { state, emit, on };
