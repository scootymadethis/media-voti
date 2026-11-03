// Pannello admin: panoramica in tempo reale, classifiche, badge, annuncio.
import { get, post, put, patch, del } from "aulera/api";
import { state } from "aulera/state";
import { html, icon, setHTML, $, $$, segmented, bindSegmented, emptyState, errorState, openSheet, toast, titleCase, initials, fmtDate, fmtNum, miniMarkdown, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

// Tutte le chiamate admin: un 401 qui vuol dire "sessione admin scaduta", non logout globale.
const Q = { quiet401: true };
const A = {
  get: (p) => get(p, Q),
  post: (p, b) => post(p, b, Q),
  put: (p, b) => put(p, b, Q),
  patch: (p, b) => patch(p, b, Q),
  del: (p) => del(p, Q),
};

const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\))$/i;
const safeColor = (v) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : null);
const badgeStyle = (b) => [["color", safeColor(b?.text_color)], ["background", safeColor(b?.background_color)], ["border-color", safeColor(b?.border_color)]]
  .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(";");
const badgeChip = (b, extra = "") => html`<span class="account-badge ${extra}" style="${badgeStyle(b)}">${b?.label || ""}</span>`;
const badgeChips = (list) => (list?.length ? html`<span class="account-badges">${list.map((b) => badgeChip(b))}</span>` : "");

const PRESETS = ["#3fd6c6", "#6b9cff", "#a78bfa", "#f472b6", "#fb7185", "#fbbf24", "#34d399", "#94a3b8"];
const hexToRgb = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const fromBase = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return { text_color: hex, background_color: `rgba(${r}, ${g}, ${b}, 0.16)`, border_color: `rgba(${r}, ${g}, ${b}, 0.38)` };
};

const nameOf = (it) => {
  const n = String(it?.full_name || "").trim();
  return n && n !== it?.username ? titleCase(n) : n || it?.username || "—";
};
function ago(epoch) {
  if (!epoch) return "";
  const diff = Math.max(0, Date.now() / 1000 - epoch);
  if (diff < 60) return "ora";
  if (diff < 3600) return `${Math.round(diff / 60)} min fa`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h fa`;
  return fmtDate(new Date(epoch * 1000));
}

function confirmSheet({ title, text, action = "Elimina" }) {
  return new Promise((resolve) => {
    let done = false;
    const sheet = openSheet({
      title,
      content: html`<p class="body-2">${text}</p><div class="admin-sheet-actions"><button type="button" class="btn" data-no>Annulla</button>
        <button type="button" class="btn btn-danger" data-yes>${action}</button></div>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $("[data-no]", sheet.body).addEventListener("click", () => sheet.close());
    $("[data-yes]", sheet.body).addEventListener("click", () => { done = true; resolve(true); sheet.close(); });
  });
}

export default {
  async render(root) {
    if (!state.session?.is_admin) {
      setHTML(root, html`${pageHeader({ eyebrow: "Account", title: "Admin" })}<div class="card">${emptyState({ iconName: "lock", title: "Accesso riservato", text: "Questa sezione è solo per gli amministratori." })}</div>`);
      return;
    }

    let section = "overview";
    let lbKind = "assenze";
    let lbFilter = "";
    let lbLimit = 60;
    const data = { overview: null, sessions: [], logins: [], lb: { assenze: null, media: null }, badges: null, users: null, announcement: null, views: 0 };
    let ws = null, wsTries = 0, wsTimer = null, pollTimer = null, wsState = "off";
    let closed = false;
    let selectedBadge = null;
    const selectedUsers = new Set();
    let userQuery = "", userTimer = null, userReq = 0;
    let draft = null; // annuncio in modifica
    let badgeForm = { label: "", ...fromBase(PRESETS[0]), base: PRESETS[0] };

    setHTML(root, html`${pageHeader({ eyebrow: "Account", title: "Admin", subtitle: "Gestisci classifiche, badge e annunci di Aulera.", actions: html`<span data-head-actions></span>` })}<div data-body></div>`);
    const body = $("[data-body]", root);
    const headActions = $("[data-head-actions]", root);

    /* ---------------- accesso ---------------- */
    async function gate(password) {
      if (password === undefined) setHTML(body, html`<div class="card card-pad admin-gate"><div class="skeleton-line" style="width:40%"></div><div class="skeleton" style="height:48px;margin-top:16px"></div></div>`);
      try {
        await A.post("/admin/login", password === undefined ? {} : { password });
        panel();
      } catch (err) {
        if (err.status === 401 && /password/i.test(err.message)) return passwordForm(password !== undefined);
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => gate());
      }
    }
    function passwordForm(wrong = false) {
      setHTML(body, html`<section class="card card-pad admin-gate">
        <span class="admin-gate-icon" aria-hidden="true">${icon("lock")}</span>
        <h2 class="title-2">Pannello protetto</h2>
        <p class="body-2">Per entrare serve anche la password del pannello.</p>
        <form class="admin-gate-form" data-form>
          <label class="sr-only" for="admin-pw">Password del pannello</label>
          <input id="admin-pw" class="field" type="password" autocomplete="current-password" required placeholder="Password" />
          <button type="submit" class="btn btn-primary">Sblocca</button>
        </form>
        <p class="caption admin-gate-msg${wrong ? " is-bad" : ""}" role="status">${wrong ? "Password errata. Riprova." : ""}</p>
      </section>`);
      const input = $("#admin-pw", body);
      input.focus({ preventScroll: true });
      $("[data-form]", body).addEventListener("submit", (e) => {
        e.preventDefault();
        if (!input.value) return;
        $("button", e.currentTarget).disabled = true;
        gate(input.value);
      });
    }
    const guard = (err) => {
      if (err?.status === 401) {
        toast("Sessione admin scaduta: accedi di nuovo al pannello.", { error: true });
        disconnect();
        setHTML(headActions, "");
        gate();
        return true;
      }
      toast(err?.message || "Operazione non riuscita", { error: true });
      return false;
    };

    /* ---------------- struttura del pannello ---------------- */
    function panel() {
      setHTML(headActions, html`<span class="admin-live" data-live><span class="dot"></span><span data-live-text>Connessione…</span></span>
        <button type="button" class="btn admin-exit" data-exit>${icon("logout")}Esci dal pannello</button>`);
      $("[data-exit]", headActions).addEventListener("click", async () => {
        try { await A.post("/admin/logout", {}); } catch { /* già fuori */ }
        disconnect();
        setHTML(headActions, "");
        toast("Sei uscito dal pannello");
        gate();
      });
      setHTML(body, html`<div class="admin-tabs">${segmented("admin-sec", [
        { value: "overview", label: "Panoramica" }, { value: "lb", label: "Classifiche" }, { value: "badges", label: "Badge" }, { value: "news", label: "Annuncio" },
      ], section)}</div><div data-sec></div>`);
      bindSegmented(body, "admin-sec", (v) => { section = v; drawSection(); });
      drawSection();
      connect();
      loadOverview();
    }
    const sec = () => $("[data-sec]", body);
    function drawSection() {
      if (!sec()) return;
      if (section === "overview") drawOverview();
      else if (section === "lb") drawLb();
      else if (section === "badges") drawBadges();
      else drawNews();
    }

    /* ---------------- tempo reale ---------------- */
    const setLive = (s) => {
      wsState = s;
      const el = $("[data-live]", headActions);
      if (!el) return;
      el.dataset.state = s;
      $("[data-live-text]", el).textContent = s === "on" ? "In tempo reale" : s === "poll" ? "Aggiornamento ogni 30 s" : "Connessione…";
    };
    function connect() {
      if (closed || ws || !window.APP_CONFIG?.wsUrl) return;
      setLive(wsTries ? "poll" : "connecting");
      try { ws = new WebSocket(window.APP_CONFIG.wsUrl("/api/ws/admin")); } catch { ws = null; return startPolling(); }
      ws.onopen = () => { wsTries = 0; stopPolling(); setLive("on"); };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (Array.isArray(msg.active_sessions)) data.sessions = msg.active_sessions;
        if (msg.type === "admin_ready") data.logins = msg.recent_logins || [];
        if (msg.type === "user_login") data.logins = [{ username: msg.username, badges: msg.badges, timestamp: msg.timestamp, fresh: true }, ...data.logins].slice(0, 30);
        if (section === "overview") drawOverview();
      };
      ws.onclose = (e) => {
        ws = null;
        if (closed) return;
        startPolling();
        if (e.code === 4403 || ++wsTries > 5) return;
        wsTimer = setTimeout(connect, Math.min(30_000, 1500 * 2 ** wsTries));
      };
    }
    function startPolling() {
      setLive("poll");
      if (pollTimer) return;
      pollTimer = setInterval(() => { if (document.visibilityState === "visible") loadOverview({ quiet: true }); }, 30_000);
    }
    function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
    function disconnect() {
      clearTimeout(wsTimer); stopPolling();
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* niente */ } }
      ws = null; wsTries = 0;
    }

    /* ---------------- panoramica ---------------- */
    async function loadOverview({ quiet = false } = {}) {
      try {
        data.overview = await A.get("/admin/overview");
        if (!ws || wsState !== "on") data.sessions = data.overview.active_session_details || data.sessions;
        if (section === "overview") drawOverview();
      } catch (err) {
        if (!quiet) { if (err.status === 401) return guard(err); if (section === "overview") { setHTML(sec(), errorState(err)); $("[data-retry]", sec())?.addEventListener("click", () => loadOverview()); } }
      }
    }
    function drawOverview() {
      const o = data.overview;
      if (!o) {
        setHTML(sec(), html`<div class="stats-row cols-3 admin-stats">${[0, 1, 2].map(() => html`<div class="stat"><div class="skeleton" style="height:34px;width:50%"></div><div class="skeleton-line" style="width:70%;height:11px"></div></div>`)}</div>${skeletonList(3)}`);
        return;
      }
      const sessions = data.sessions || [];
      const users = new Set(sessions.map((s) => String(s.username).toUpperCase())).size;
      setHTML(sec(), html`
        <div class="stats-row cols-3 admin-stats">
          <div class="stat"><span class="stat-num">${sessions.length}</span><span class="stat-label">sessioni attive</span></div>
          <div class="stat"><span class="stat-num">${o.average_leaderboard_entries ?? 0}</span><span class="stat-label">in classifica media</span></div>
          <div class="stat"><span class="stat-num">${o.leaderboard_entries ?? 0}</span><span class="stat-label">voci classifica assenze</span></div>
        </div>
        <div class="admin-grid">
          <section>
            <div class="section-head"><p class="overline">Sessioni attive</p><span class="caption tnum">${users} ${users === 1 ? "utente" : "utenti"}</span></div>
            ${sessions.length ? html`<ul class="card list admin-scroll">${sessions.map((s) => html`<li class="row">
                <span class="account-avatar sm" aria-hidden="true">${initials(nameOf(s))}</span>
                <div class="row-main"><p class="row-title">${nameOf(s)} ${badgeChips(s.badges)}</p><p class="row-sub tnum">${s.username} · da ${ago(s.logged_at).replace(" fa", "")}</p></div>
              </li>`)}</ul>` : html`<div class="card">${emptyState({ iconName: "person", title: "Nessuna sessione attiva" })}</div>`}
          </section>
          <section>
            <div class="section-head"><p class="overline">Accessi recenti</p></div>
            ${data.logins.length ? html`<ul class="card list admin-scroll">${data.logins.map((l) => html`<li class="row${l.fresh ? " admin-fresh" : ""}">
                <span class="row-icon">${icon("spid")}</span>
                <div class="row-main"><p class="row-title tnum">${l.username} ${badgeChips(l.badges)}</p><p class="row-sub">Ha effettuato l'accesso</p></div>
                <span class="row-trail caption tnum">${ago(l.timestamp)}</span></li>`)}</ul>`
              : html`<div class="card">${emptyState({ iconName: "history", title: "Nessun accesso recente", text: wsState === "on" ? "Gli accessi compaiono qui appena avvengono." : "Il feed degli accessi richiede la connessione in tempo reale." })}</div>`}
          </section>
        </div>`);
      data.logins.forEach((l) => { l.fresh = false; });
    }

    /* ---------------- classifiche ---------------- */
    async function loadLb(kind, { force = false } = {}) {
      if (data.lb[kind] && !force) return;
      try {
        const res = await A.get(kind === "assenze" ? "/admin/leaderboard" : "/admin/average-leaderboard");
        data.lb[kind] = res.items || [];
      } catch (err) {
        if (err.status === 401) return guard(err);
        data.lb[kind] = { error: err };
      }
      if (section === "lb" && lbKind === kind) drawLbList();
    }
    function drawLb() {
      setHTML(sec(), html`<div class="admin-toolbar">
          ${segmented("admin-lb", [{ value: "assenze", label: "Assenze" }, { value: "media", label: "Media" }], lbKind)}
          <label class="search admin-search">${icon("search")}<input class="field" type="search" data-lb-search placeholder="Cerca nome, codice o classe" value="${lbFilter}" autocomplete="off" /></label>
          <button type="button" class="btn btn-icon" data-lb-reload aria-label="Ricarica">${icon("refresh")}</button>
        </div><div data-lb-list></div>`);
      bindSegmented(sec(), "admin-lb", (v) => { lbKind = v; lbLimit = 60; drawLbList(); loadLb(v); });
      let t = null;
      $("[data-lb-search]", sec()).addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { lbFilter = e.target.value.trim().toLowerCase(); lbLimit = 60; drawLbList(); }, 150); });
      $("[data-lb-reload]", sec()).addEventListener("click", () => { data.lb[lbKind] = null; drawLbList(); loadLb(lbKind, { force: true }); });
      $("[data-lb-list]", sec()).addEventListener("click", onLbClick);
      drawLbList();
      loadLb(lbKind);
    }
    const lbKey = (it) => `${it.username}|${it.school_year || ""}`;
    function drawLbList() {
      const box = $("[data-lb-list]", sec());
      if (!box) return;
      const list = data.lb[lbKind];
      if (!list) return setHTML(box, skeletonList(5));
      if (list.error) { setHTML(box, errorState(list.error)); $("[data-retry]", box)?.addEventListener("click", () => { data.lb[lbKind] = null; drawLbList(); loadLb(lbKind, { force: true }); }); return; }
      const rows = lbFilter ? list.filter((it) => [it.username, it.full_name, it.class_code, it.school_code].join(" ").toLowerCase().includes(lbFilter)) : list;
      const hidden = list.filter((it) => !it.visible_in_leaderboard).length;
      if (!rows.length) return setHTML(box, html`<div class="card">${emptyState({ iconName: lbFilter ? "search" : "trophy", title: lbFilter ? "Nessun risultato" : "Classifica vuota" })}</div>`);
      setHTML(box, html`<p class="caption admin-count tnum">${rows.length} ${rows.length === 1 ? "voce" : "voci"}${hidden ? ` · ${hidden} nascoste` : ""}</p>
        <ul class="card list admin-lb">${rows.slice(0, lbLimit).map((it) => html`<li class="row admin-lb-row${it.visible_in_leaderboard ? "" : " is-hidden"}" data-key="${lbKey(it)}">
          <span class="${lbKind === "media" ? "grade grade-sm g-none" : "admin-hours"} tnum">${lbKind === "media" ? fmtNum(Number(it.average) || 0, 2) : `${fmtNum(Number(it.hours) || 0, 1)} h`}</span>
          <div class="row-main">
            <p class="row-title">${nameOf(it)} ${badgeChips(it.badges)}</p>
            <p class="row-sub tnum">${[it.username, it.class_code, it.school_code, it.school_year, lbKind === "media" && it.entries_count ? `${it.entries_count} medie` : ""].filter(Boolean).join(" · ")}</p>
          </div>
          <div class="admin-row-actions">
            <button type="button" class="switch" role="switch" aria-checked="${String(!!it.visible_in_leaderboard)}" aria-label="Visibile in classifica" data-toggle="${it.username}"></button>
            <button type="button" class="btn btn-icon admin-del" aria-label="Elimina ${nameOf(it)}" data-delete="${it.username}">${icon("close")}</button>
          </div>
        </li>`)}</ul>
        ${rows.length > lbLimit ? html`<button type="button" class="btn btn-block admin-more" data-lb-more>Mostra altre ${Math.min(60, rows.length - lbLimit)}</button>` : ""}`);
    }
    async function onLbClick(e) {
      if (e.target.closest("[data-lb-more]")) { lbLimit += 60; return drawLbList(); }
      const tog = e.target.closest("[data-toggle]"), rm = e.target.closest("[data-delete]");
      const list = data.lb[lbKind];
      if (!Array.isArray(list)) return;
      if (tog) {
        const username = tog.dataset.toggle;
        const next = tog.getAttribute("aria-checked") !== "true";
        tog.setAttribute("aria-checked", String(next));
        tog.disabled = true;
        try {
          const path = lbKind === "assenze" ? `/admin/leaderboard/${encodeURIComponent(username)}/visibility` : `/admin/average-leaderboard/${encodeURIComponent(username)}/visibility`;
          await A.patch(path, { visible_in_leaderboard: next });
          list.filter((it) => it.username === username).forEach((it) => { it.visible_in_leaderboard = next; });
          drawLbList();
        } catch (err) {
          tog.setAttribute("aria-checked", String(!next));
          tog.disabled = false;
          guard(err);
        }
      } else if (rm) {
        const username = rm.dataset.delete;
        const it = list.find((x) => x.username === username);
        const ok = await confirmSheet({ title: `Eliminare ${nameOf(it)}?`, text: `Le voci di ${username} nella classifica ${lbKind === "assenze" ? "Assenze" : "Media"} verranno rimosse. Se l'utente resta visibile, ricompariranno al suo prossimo aggiornamento.` });
        if (!ok) return;
        try {
          const path = lbKind === "assenze" ? `/admin/leaderboard/${encodeURIComponent(username)}` : `/admin/average-leaderboard/${encodeURIComponent(username)}`;
          await A.del(path);
          data.lb[lbKind] = list.filter((x) => x.username !== username);
          drawLbList();
          toast(`${nameOf(it)} rimosso dalla classifica`);
        } catch (err) { guard(err); }
      }
    }

    /* ---------------- badge ---------------- */
    async function loadBadges() {
      try {
        const res = await A.get("/admin/badges");
        data.badges = res.items || [];
        if (selectedBadge && !data.badges.some((b) => b.id === selectedBadge)) selectedBadge = null;
        if (!selectedBadge && data.badges.length) selectedBadge = data.badges[0].id;
      } catch (err) {
        if (err.status === 401) return guard(err);
        data.badges = { error: err };
      }
      if (section === "badges") { drawBadgeList(); drawAssign(); }
    }
    async function searchUsers() {
      const id = ++userReq;
      try {
        const res = await A.get(`/admin/users/search?q=${encodeURIComponent(userQuery)}&limit=20`);
        if (id !== userReq) return;
        data.users = res.items || [];
      } catch (err) {
        if (err.status === 401) return guard(err);
        data.users = { error: err };
      }
      if (section === "badges") drawUsers();
    }
    function drawBadges() {
      setHTML(sec(), html`<div class="admin-grid">
        <section class="stack">
          <div class="card card-pad admin-badge-form">
            <div class="spread"><p class="title-3">Nuovo badge</p><div class="admin-badge-preview" data-preview></div></div>
            <form class="stack-sm" data-badge-form>
              <label class="sr-only" for="badge-label">Nome del badge</label>
              <input id="badge-label" class="field" maxlength="32" placeholder="Nome, es. Fondatore" value="${badgeForm.label}" data-bf="label" required autocomplete="off" />
              <div class="admin-swatches" role="group" aria-label="Colore">
                ${PRESETS.map((c) => html`<button type="button" class="admin-swatch${badgeForm.base === c ? " is-active" : ""}" style="--sw:${c}" data-preset="${c}" aria-label="Colore ${c}"></button>`)}
                <label class="admin-swatch admin-swatch-custom" aria-label="Colore personalizzato">${icon("plus")}<input type="color" value="${badgeForm.base}" data-custom-color /></label>
              </div>
              <details class="admin-advanced"><summary class="caption">Colori avanzati</summary>
                <div class="stack-sm" style="margin-top:10px">
                  ${[["text_color", "Testo"], ["background_color", "Sfondo"], ["border_color", "Bordo"]].map(([k, l]) => html`<label class="admin-color-field"><span class="caption">${l}</span>
                    <input class="field" data-bf="${k}" value="${badgeForm[k]}" spellcheck="false" autocomplete="off" placeholder="#hex o rgba()" /></label>`)}
                  <p class="caption">Accettati solo #hex, rgb() e rgba().</p>
                </div></details>
              <button type="submit" class="btn btn-primary" data-create>${icon("plus")}Crea badge</button>
            </form>
          </div>
          <div><div class="section-head"><p class="overline">Badge</p><span class="caption">Tocca per selezionare</span></div><div data-badge-list></div></div>
        </section>
        <section class="admin-assign" data-assign></section>
      </div>`);
      const form = $("[data-badge-form]", sec());
      const preview = () => {
        const ok = ["text_color", "background_color", "border_color"].every((k) => safeColor(badgeForm[k]));
        setHTML($("[data-preview]", sec()), html`${badgeChip({ ...badgeForm, label: badgeForm.label || "Anteprima" }, "lg")}`);
        $$("[data-bf]", form).forEach((i) => i.dataset.bf !== "label" && i.classList.toggle("is-invalid", !safeColor(badgeForm[i.dataset.bf])));
        $("[data-create]", form).disabled = !ok || !badgeForm.label.trim();
      };
      const setBase = (c) => {
        Object.assign(badgeForm, fromBase(c), { base: c });
        $$("[data-preset]", form).forEach((b) => b.classList.toggle("is-active", b.dataset.preset === c));
        ["text_color", "background_color", "border_color"].forEach((k) => { $(`[data-bf="${k}"]`, form).value = badgeForm[k]; });
        preview();
      };
      form.addEventListener("input", (e) => {
        if (e.target.dataset.bf) { badgeForm[e.target.dataset.bf] = e.target.value; preview(); }
        if ("customColor" in e.target.dataset) setBase(e.target.value);
      });
      form.addEventListener("click", (e) => { const p = e.target.closest("[data-preset]"); if (p) setBase(p.dataset.preset); });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("[data-create]", form);
        btn.disabled = true;
        try {
          const res = await A.post("/admin/badges", { label: badgeForm.label.trim(), text_color: badgeForm.text_color, background_color: badgeForm.background_color, border_color: badgeForm.border_color });
          toast(`Badge “${badgeForm.label.trim()}” creato`);
          badgeForm.label = "";
          $('[data-bf="label"]', form).value = "";
          if (res.badge?.id) selectedBadge = res.badge.id;
          await loadBadges();
        } catch (err) { guard(err); }
        preview();
      });
      preview();
      drawBadgeList();
      drawAssign();
      if (!data.badges) loadBadges();
      if (!Array.isArray(data.users)) searchUsers();
    }
    function drawBadgeList() {
      const box = $("[data-badge-list]", sec());
      if (!box) return;
      if (!data.badges) return setHTML(box, html`<div class="card card-pad"><div class="skeleton" style="height:28px;width:70%"></div></div>`);
      if (data.badges.error) return setHTML(box, errorState(data.badges.error, false));
      if (!data.badges.length) return setHTML(box, html`<div class="card">${emptyState({ iconName: "sparkle", title: "Nessun badge", text: "Crea il primo qui sopra." })}</div>`);
      setHTML(box, html`<ul class="card list admin-badge-list">${data.badges.map((b) => html`<li class="row${b.id === selectedBadge ? " is-selected" : ""}">
          <button type="button" class="admin-badge-pick" data-pick="${b.id}" aria-pressed="${String(b.id === selectedBadge)}">
            <span class="admin-radio" aria-hidden="true"></span>${badgeChip(b)}</button>
          <button type="button" class="btn btn-icon admin-del" aria-label="Elimina badge ${b.label}" data-del-badge="${b.id}">${icon("close")}</button>
        </li>`)}</ul>`);
      box.onclick = async (e) => {
        const pick = e.target.closest("[data-pick]"), rm = e.target.closest("[data-del-badge]");
        if (pick) { selectedBadge = Number(pick.dataset.pick); drawBadgeList(); drawAssign(); }
        if (rm) {
          const b = data.badges.find((x) => x.id === Number(rm.dataset.delBadge));
          if (!(await confirmSheet({ title: `Eliminare “${b?.label}”?`, text: "Il badge verrà rimosso da tutti gli utenti che lo hanno." }))) return;
          try {
            await A.del(`/admin/badges/${encodeURIComponent(b.id)}`);
            toast("Badge eliminato");
            await loadBadges();
            searchUsers();
            data.lb = { assenze: null, media: null };
          } catch (err) { guard(err); }
        }
      };
    }
    function drawAssign() {
      const box = $("[data-assign]", sec());
      if (!box) return;
      const badge = Array.isArray(data.badges) ? data.badges.find((b) => b.id === selectedBadge) : null;
      setHTML(box, html`<div class="section-head"><p class="overline">Assegna</p>${badge ? badgeChip(badge) : html`<span class="caption">Scegli un badge</span>`}</div>
        <div class="card admin-assign-card">
          <div class="admin-assign-head"><label class="search">${icon("search")}<input class="field" type="search" data-user-search placeholder="Cerca utenti" value="${userQuery}" autocomplete="off" /></label></div>
          <div data-users></div>
          <div class="admin-assign-foot">
            <span class="caption tnum" data-sel-count></span>
            <div class="hstack"><button type="button" class="btn btn-danger" data-batch="remove">Rimuovi</button><button type="button" class="btn btn-primary" data-batch="assign">Assegna</button></div>
          </div>
        </div>`);
      $("[data-user-search]", box).addEventListener("input", (e) => { clearTimeout(userTimer); userTimer = setTimeout(() => { userQuery = e.target.value.trim(); searchUsers(); }, 250); });
      // onclick (non addEventListener): il contenitore resta, i ridisegni non accumulano handler.
      box.onclick = async (e) => {
        const u = e.target.closest("[data-user]");
        if (u) {
          const name = u.dataset.user;
          if (selectedUsers.has(name)) selectedUsers.delete(name); else selectedUsers.add(name);
          u.setAttribute("aria-checked", String(selectedUsers.has(name)));
          return updateCount();
        }
        if (e.target.closest("[data-clear-sel]")) { selectedUsers.clear(); drawUsers(); return; }
        const b = e.target.closest("[data-batch]");
        if (!b || !badge || !selectedUsers.size) return;
        b.disabled = true;
        try {
          const res = await A.post("/admin/badges/batch", { badge_id: badge.id, usernames: [...selectedUsers], action: b.dataset.batch });
          if (!res.changed) toast(b.dataset.batch === "assign" ? "Nessuna modifica: avevano già questo badge" : "Nessuna modifica: non avevano questo badge");
          else toast(b.dataset.batch === "assign" ? `“${badge.label}” assegnato a ${res.changed ?? 0} ${res.changed === 1 ? "utente" : "utenti"}` : `“${badge.label}” rimosso da ${res.changed ?? 0} ${res.changed === 1 ? "utente" : "utenti"}`);
          selectedUsers.clear();
          data.lb = { assenze: null, media: null };
          await searchUsers();
        } catch (err) { guard(err); }
        updateCount();
      };
      drawUsers();
    }
    function updateCount() {
      const box = $("[data-assign]", sec());
      if (!box) return;
      const badge = Array.isArray(data.badges) ? data.badges.find((b) => b.id === selectedBadge) : null;
      const n = selectedUsers.size;
      setHTML($("[data-sel-count]", box), n ? html`${n} ${n === 1 ? "selezionato" : "selezionati"} · <button type="button" class="link" data-clear-sel>Azzera</button>` : "Nessuno selezionato");
      $$("[data-batch]", box).forEach((b) => { b.disabled = !n || !badge; });
    }
    function drawUsers() {
      const box = $("[data-users]", sec());
      if (!box) return;
      if (!data.users) return setHTML(box, skeletonList(3));
      if (data.users.error) setHTML(box, errorState(data.users.error, false));
      else if (!data.users.length) setHTML(box, emptyState({ iconName: "person", title: userQuery ? "Nessun utente trovato" : "Nessun utente", text: "Gli utenti arrivano da sessioni, classifiche e badge già assegnati." }));
      else {
        setHTML(box, html`<ul class="admin-users">${data.users.map((u) => html`<li><button type="button" class="row admin-user" role="checkbox" aria-checked="${String(selectedUsers.has(u.username))}" data-user="${u.username}">
            <span class="admin-check" aria-hidden="true">${icon("check")}</span>
            <span class="row-main"><span class="row-title">${nameOf(u)}</span>
              <span class="row-sub tnum">${[u.username, u.class_code, u.school_code].filter(Boolean).join(" · ")}</span>
              ${u.badges?.length ? html`<span class="admin-user-badges">${badgeChips(u.badges)}</span>` : ""}</span>
          </button></li>`)}</ul>`);
      }
      updateCount();
    }

    /* ---------------- annuncio ---------------- */
    async function loadNews() {
      try {
        const res = await A.get("/admin/announcement");
        data.announcement = res.announcement || { title: "", body_markdown: "", enabled: false };
        data.views = res.views_count || 0;
        draft = { title: data.announcement.title || "", body_markdown: data.announcement.body_markdown || "", enabled: !!data.announcement.enabled };
      } catch (err) {
        if (err.status === 401) return guard(err);
        data.announcement = { error: err };
      }
      if (section === "news") drawNews();
    }
    function drawNews() {
      const a = data.announcement;
      if (!a) { setHTML(sec(), html`<div class="card card-pad"><div class="skeleton-line" style="width:30%"></div><div class="skeleton" style="height:220px;margin-top:16px"></div></div>`); loadNews(); return; }
      if (a.error) { setHTML(sec(), errorState(a.error)); $("[data-retry]", sec())?.addEventListener("click", () => { data.announcement = null; drawNews(); }); return; }
      const changed = draft.title !== (a.title || "") || draft.body_markdown !== (a.body_markdown || "") || draft.enabled !== !!a.enabled;
      setHTML(sec(), html`<div class="admin-grid">
        <form class="card card-pad admin-news-form" data-news>
          <div class="row admin-news-toggle"><div class="row-main"><p class="row-title">Mostra l'annuncio</p><p class="row-sub">Compare una volta a ogni utente, all'apertura dell'app.</p></div>
            <button type="button" class="switch" role="switch" aria-label="Mostra l'annuncio" aria-checked="${String(draft.enabled)}" data-enabled></button></div>
          <label class="stack-sm"><span class="caption">Titolo</span><input class="field" data-nf="title" value="${draft.title}" maxlength="120" placeholder="Novità di Aulera" /></label>
          <label class="stack-sm"><span class="caption">Testo</span><textarea class="field admin-textarea" data-nf="body_markdown" rows="10" placeholder="Scrivi qui il messaggio…">${draft.body_markdown}</textarea></label>
          <p class="caption">Formattazione: **grassetto**, *corsivo*, [testo](https://…), # titolo, - elenco.</p>
          <div class="admin-news-foot">
            <span class="caption tnum">${a.content_version ? `Visto da ${data.views} ${data.views === 1 ? "utente" : "utenti"}${a.updated_at ? ` · salvato il ${fmtDate(new Date(a.updated_at * 1000))}` : ""}` : "Nessun annuncio salvato"}</span>
            <button type="submit" class="btn btn-primary" data-save ${changed ? "" : "disabled"}>${icon("check")}Salva</button>
          </div>
          <p class="caption admin-news-warn" data-warn ${draft.title !== (a.title || "") || draft.body_markdown !== (a.body_markdown || "") ? "" : "hidden"}>${icon("info")}<span>Hai cambiato il testo: dopo il salvataggio l'annuncio verrà mostrato di nuovo a tutti.</span></p>
        </form>
        <section><div class="section-head"><p class="overline">Anteprima</p>${draft.enabled ? html`<span class="chip chip-good">Attivo</span>` : html`<span class="chip">Non attivo</span>`}</div>
          <div class="card card-pad admin-news-preview" data-preview></div></section>
      </div>`);
      const form = $("[data-news]", sec());
      const drawPreview = () => setHTML($("[data-preview]", sec()), draft.title || draft.body_markdown
        ? html`<p class="title-2">${draft.title || "Novità"}</p><div class="md">${miniMarkdown(draft.body_markdown)}</div><div class="btn btn-primary btn-block admin-news-ok" aria-hidden="true">Ho capito</div>`
        : emptyState({ iconName: "megaphone", title: "Niente da mostrare", text: "Scrivi un titolo o un testo per vedere l'anteprima." }));
      const sync = () => {
        const textChanged = draft.title !== (a.title || "") || draft.body_markdown !== (a.body_markdown || "");
        $("[data-save]", form).disabled = !(textChanged || draft.enabled !== !!a.enabled);
        $("[data-warn]", form).hidden = !textChanged || !a.content_version;
      };
      form.addEventListener("input", (e) => { if (e.target.dataset.nf) { draft[e.target.dataset.nf] = e.target.value; drawPreview(); sync(); } });
      $("[data-enabled]", form).addEventListener("click", (e) => { draft.enabled = !draft.enabled; e.currentTarget.setAttribute("aria-checked", String(draft.enabled)); sync(); });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("[data-save]", form);
        btn.disabled = true;
        try {
          const res = await A.put("/admin/announcement", { title: draft.title, body_markdown: draft.body_markdown, enabled: draft.enabled });
          data.announcement = res.announcement;
          data.views = res.views_count || 0;
          toast(res.version_changed ? "Annuncio salvato: lo vedranno di nuovo tutti" : "Annuncio salvato");
          drawNews();
        } catch (err) { guard(err); sync(); }
      });
      drawPreview();
      sync();
    }

    /* ---------------- avvio ---------------- */
    await gate();
    return () => { closed = true; disconnect(); clearTimeout(userTimer); };
  },
};
