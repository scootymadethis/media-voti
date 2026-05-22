const ADMIN_USERNAME = "S10371278X";
const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
const wsUrl = (path) => window.APP_CONFIG?.wsUrl?.(path) ?? path;

let assenzeItems = [];
let votiItems = [];
let adminRealtimeSocket = null;
let adminRealtimeReconnectTimer = null;
const MAX_LOGIN_FEED_ITEMS = 40;

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function setLoading(show) {
  const overlay = document.getElementById("loading-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !show);
}

function showGate() {
  document.getElementById("adminGate")?.classList.remove("hidden");
  document.getElementById("adminDashboard")?.classList.add("hidden");
}

function showDashboard() {
  document.getElementById("adminGate")?.classList.add("hidden");
  document.getElementById("adminDashboard")?.classList.remove("hidden");
}

function setLoginMessage(text, type = "") {
  const el = document.getElementById("adminLoginMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "admin-msg" + (type ? ` ${type}` : "");
}

async function fetchAdmin(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...options,
  });
  const data = await readJsonSafe(res);
  return { res, data };
}

async function ensureMainLogin() {
  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/";
    return false;
  }

  const username = (localStorage.getItem("username") || "").trim();
  if (username !== ADMIN_USERNAME) {
    window.location.href = "/dashboard/";
    return false;
  }

  const { res, data } = await fetchAdmin("/api/admin/eligible");
  if (!res.ok || !data?.eligible) {
    window.location.href = "/dashboard/";
    return false;
  }

  if (data.username) localStorage.setItem("username", data.username);
  return true;
}

async function tryBootstrapAdmin() {
  const { res, data } = await fetchAdmin("/api/admin/bootstrap", { method: "POST" });
  return res.ok && data?.ok;
}

async function checkAdminAuthenticated() {
  const { res, data } = await fetchAdmin("/api/admin/status");
  return res.ok && data?.authenticated === true;
}

async function authenticateAdminFlow() {
  setLoginMessage("Verifica accesso admin...", "");

  if (await checkAdminAuthenticated()) {
    showDashboard();
    await loadDashboardData();
    connectAdminRealtime();
    return;
  }

  setLoginMessage("Accesso rapido in corso...");
  const bootstrapped = await tryBootstrapAdmin();
  if (bootstrapped && (await checkAdminAuthenticated())) {
    showDashboard();
    await loadDashboardData();
    connectAdminRealtime();
    return;
  }

  disconnectAdminRealtime();
  showGate();
  setLoginMessage("");
}

function updateActiveSessionsCount(count) {
  const el = document.getElementById("adminActiveSessionsStat");
  if (!el) return;
  const normalized = Number.isFinite(Number(count)) ? Number(count) : 0;
  el.textContent = String(normalized);
}

function renderStats(overview) {
  const stats = document.getElementById("adminStats");
  if (!stats) return;

  const cards = [
    ["Sessioni attive", overview.active_sessions, "adminActiveSessionsStat"],
    ["Voci assenze", overview.leaderboard_entries, ""],
    ["Studenti in classifica medie", overview.average_leaderboard_entries, ""],
    ["Admin", overview.admin_username, ""],
  ];

  stats.innerHTML = cards
    .map(
      ([label, value, valueId]) => `
      <article class="admin-stat">
        <div class="label">${label}</div>
        <div class="value"${valueId ? ` id="${valueId}"` : ""}>${escapeHtml(value)}</div>
      </article>
    `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setAdminWsStatus(text, state = "") {
  const el = document.getElementById("adminWsStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "admin-ws-status" + (state ? ` ${state}` : "");
}

function prependLoginFeedItem(username, timestamp) {
  const feed = document.getElementById("adminLoginFeed");
  if (!feed) return;

  const empty = feed.querySelector(".admin-empty");
  if (empty) empty.remove();

  const item = document.createElement("article");
  item.className = "admin-login-item";
  item.innerHTML = `
    <div>
      <strong>${escapeHtml(username)}</strong>
      <div style="color: var(--secondary); font-size: 0.84rem;">Nuovo accesso</div>
    </div>
    <time datetime="${timestamp}">${formatDateTime(timestamp)}</time>
  `;
  feed.prepend(item);

  while (feed.children.length > MAX_LOGIN_FEED_ITEMS) {
    feed.lastElementChild?.remove();
  }
}

function renderLoginFeed(events) {
  const feed = document.getElementById("adminLoginFeed");
  if (!feed) return;

  if (!events?.length) {
    feed.innerHTML = '<p class="admin-empty">In attesa di login…</p>';
    return;
  }

  feed.innerHTML = events
    .map(
      (event) => `
      <article class="admin-login-item">
        <div>
          <strong>${escapeHtml(event.username)}</strong>
          <div style="color: var(--secondary); font-size: 0.84rem;">Accesso registrato</div>
        </div>
        <time datetime="${event.timestamp}">${formatDateTime(event.timestamp)}</time>
      </article>
    `,
    )
    .join("");
}

function syncActiveSessionsFromPayload(payload) {
  const sessions = payload?.active_sessions;
  if (Array.isArray(sessions)) {
    updateActiveSessionsCount(sessions.length);
    return;
  }
  if (Number.isFinite(Number(payload?.active_sessions_count))) {
    updateActiveSessionsCount(payload.active_sessions_count);
  }
}

function handleAdminRealtimeMessage(payload) {
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "admin_ready") {
    renderLoginFeed(payload.recent_logins || []);
    syncActiveSessionsFromPayload(payload);
    return;
  }

  if (payload.type === "user_login") {
    prependLoginFeedItem(payload.username, payload.timestamp);
    syncActiveSessionsFromPayload(payload);
  }
}

function scheduleAdminRealtimeReconnect() {
  if (adminRealtimeReconnectTimer) return;
  adminRealtimeReconnectTimer = window.setTimeout(() => {
    adminRealtimeReconnectTimer = null;
    connectAdminRealtime();
  }, 3000);
}

function disconnectAdminRealtime() {
  if (adminRealtimeReconnectTimer) {
    window.clearTimeout(adminRealtimeReconnectTimer);
    adminRealtimeReconnectTimer = null;
  }
  if (adminRealtimeSocket) {
    adminRealtimeSocket.close();
    adminRealtimeSocket = null;
  }
  setAdminWsStatus("Disconnesso");
}

function connectAdminRealtime() {
  disconnectAdminRealtime();
  setAdminWsStatus("Connessione…");

  const socket = new WebSocket(wsUrl("/api/ws/admin"));
  adminRealtimeSocket = socket;

  socket.addEventListener("open", () => {
    setAdminWsStatus("Live", "live");
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleAdminRealtimeMessage(payload);
    } catch (err) {
      console.warn("[admin] invalid websocket payload:", err);
    }
  });

  socket.addEventListener("close", () => {
    adminRealtimeSocket = null;
    setAdminWsStatus("Riconnessione…", "error");
    scheduleAdminRealtimeReconnect();
  });

  socket.addEventListener("error", () => {
    setAdminWsStatus("Errore connessione", "error");
  });
}

function visibilityBadge(visible) {
  return visible
    ? '<span class="admin-badge visible">Visibile</span>'
    : '<span class="admin-badge hidden">Nascosto</span>';
}

function renderAssenzeTable() {
  const body = document.getElementById("assenzeTableBody");
  if (!body) return;

  if (!assenzeItems.length) {
    body.innerHTML =
      '<tr><td colspan="6" class="admin-empty">Nessuna voce in classifica assenze.</td></tr>';
    return;
  }

  body.innerHTML = assenzeItems
    .map((item) => {
      const username = item.username || "";
      const visible = !!item.visible_in_leaderboard;
      return `
        <tr>
          <td>${username}</td>
          <td>${item.full_name || "-"}</td>
          <td>${item.class_code || "-"}</td>
          <td>${Number(item.hours || 0).toFixed(2)}</td>
          <td>${visibilityBadge(visible)}</td>
          <td>
            <div class="admin-actions">
              <button type="button" onclick="toggleAssenzeVisibility('${username}', ${!visible})">
                ${visible ? "Nascondi" : "Mostra"}
              </button>
              <button type="button" class="danger" onclick="deleteAssenzeEntry('${username}')">
                Elimina
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderVotiTable() {
  const body = document.getElementById("votiTableBody");
  if (!body) return;

  if (!votiItems.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="admin-empty">Nessuna voce in classifica medie.</td></tr>';
    return;
  }

  body.innerHTML = votiItems
    .map((item) => {
      const rawUsername = item.username || "";
      const username = escapeHtml(rawUsername);
      const fullName = escapeHtml(item.full_name || rawUsername || "-");
      const visible = !!item.visible_in_leaderboard;
      const entriesCount = Number(item.entries_count || 1);
      const entriesHint =
        entriesCount > 1
          ? ` <span style="color:var(--secondary);font-size:0.78rem;">(${entriesCount} voci DB)</span>`
          : "";
      return `
        <tr>
          <td>${fullName}</td>
          <td>${username}</td>
          <td>${Number(item.average || 0).toFixed(2)}${entriesHint}</td>
          <td>${visibilityBadge(visible)}</td>
          <td>
            <div class="admin-actions">
              <button type="button" data-username="${escapeHtml(rawUsername)}" class="js-toggle-voti">
                ${visible ? "Nascondi" : "Mostra"}
              </button>
              <button type="button" class="danger js-delete-voti" data-username="${escapeHtml(rawUsername)}">
                Elimina
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  body.querySelectorAll(".js-toggle-voti").forEach((btn) => {
    btn.addEventListener("click", () => {
      const username = btn.dataset.username;
      const row = votiItems.find((item) => item.username === username);
      toggleVotiVisibility(username, !(row && row.visible_in_leaderboard));
    });
  });

  body.querySelectorAll(".js-delete-voti").forEach((btn) => {
    btn.addEventListener("click", () => deleteVotiEntry(btn.dataset.username));
  });
}

async function loadDashboardData() {
  setLoading(true);
  try {
    const [overviewRes, assenzeRes, votiRes] = await Promise.all([
      fetchAdmin("/api/admin/overview"),
      fetchAdmin("/api/admin/leaderboard"),
      fetchAdmin("/api/admin/average-leaderboard"),
    ]);

    if (overviewRes.res.status === 401 || assenzeRes.res.status === 401) {
      disconnectAdminRealtime();
      showGate();
      setLoginMessage("Sessione admin scaduta. Reinserisci la password.", "error");
      return;
    }

    if (!overviewRes.res.ok) throw new Error("Impossibile caricare panoramica");

    renderStats(overviewRes.data);
    updateActiveSessionsCount(overviewRes.data.active_sessions);

    assenzeItems = assenzeRes.data?.items || [];
    votiItems = votiRes.data?.items || [];
    renderAssenzeTable();
    renderVotiTable();

    const welcome = document.getElementById("adminWelcome");
    if (welcome) {
      welcome.textContent = `Connesso come ${overviewRes.data.admin_username}. Gestione classifiche e monitoraggio sistema.`;
    }

    await loadAdminAnnouncement();
  } catch (err) {
    console.error(err);
    disconnectAdminRealtime();
    setLoginMessage("Errore nel caricamento del pannello admin.", "error");
    showGate();
  } finally {
    setLoading(false);
  }
}

window.reloadAssenzeTable = async function reloadAssenzeTable() {
  const { res, data } = await fetchAdmin("/api/admin/leaderboard");
  if (!res.ok) return;
  assenzeItems = data?.items || [];
  renderAssenzeTable();
};

window.reloadVotiTable = async function reloadVotiTable() {
  const { res, data } = await fetchAdmin("/api/admin/average-leaderboard");
  if (!res.ok) return;
  votiItems = data?.items || [];
  renderVotiTable();
};

window.toggleAssenzeVisibility = async function toggleAssenzeVisibility(
  username,
  visible,
) {
  const { res } = await fetchAdmin(
    `/api/admin/leaderboard/${encodeURIComponent(username)}/visibility`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible_in_leaderboard: visible }),
    },
  );
  if (!res.ok) return;
  await reloadAssenzeTable();
};

window.deleteAssenzeEntry = async function deleteAssenzeEntry(username) {
  if (!confirm(`Eliminare la voce assenze di ${username}?`)) return;
  const { res } = await fetchAdmin(
    `/api/admin/leaderboard/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  if (!res.ok) return;
  await reloadAssenzeTable();
};

window.toggleVotiVisibility = async function toggleVotiVisibility(username, visible) {
  const { res } = await fetchAdmin(
    `/api/admin/average-leaderboard/${encodeURIComponent(username)}/visibility`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible_in_leaderboard: visible }),
    },
  );
  if (!res.ok) return;
  await reloadVotiTable();
};

window.deleteVotiEntry = async function deleteVotiEntry(username) {
  if (!confirm(`Eliminare tutte le voci media di ${username}?`)) return;
  const { res } = await fetchAdmin(
    `/api/admin/average-leaderboard/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  if (!res.ok) return;
  await reloadVotiTable();
};

window.adminPanelLogout = async function adminPanelLogout() {
  disconnectAdminRealtime();
  await fetchAdmin("/api/admin/logout", { method: "POST" });
  showGate();
  setLoginMessage("Sei uscito dal pannello admin.", "");
};

function initAdminTabs() {
  const tabs = document.querySelectorAll(".admin-tab");
  const panels = document.querySelectorAll(".admin-panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels.forEach((panel) =>
        panel.classList.toggle("active", panel.dataset.panel === target),
      );
    });
  });
}

function initAdminLoginForm() {
  const form = document.getElementById("adminLoginForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("adminPassword")?.value || "";
    setLoginMessage("Verifica password...", "");

    const { res, data } = await fetchAdmin("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      setLoginMessage(data?.detail || "Password non valida", "error");
      return;
    }

    setLoginMessage("Accesso admin confermato.", "ok");
    showDashboard();
    await loadDashboardData();
    connectAdminRealtime();
  });
}

function goToHome() {
  window.location.href = "/dashboard/";
}

function goToVoti() {
  window.location.href = "/voti/";
}

function goToAssenze() {
  window.location.href = "/assenze/";
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
    toggle.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    drawer.setAttribute("aria-hidden", "false");
    backdrop.setAttribute("aria-hidden", "false");
    document.body.classList.add("menu-open");
  };

  const closeMenu = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    toggle.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
    backdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("menu-open");
  };

  toggle.addEventListener("click", () => {
    if (drawer.classList.contains("open")) closeMenu();
    else openMenu();
  });
  closeBtn?.addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);
}

function setAnnouncementSaveMessage(text, type = "") {
  const el = document.getElementById("announcementSaveMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "admin-msg" + (type ? ` ${type}` : "");
}

function updateAnnouncementMeta(announcement, viewsCount) {
  const meta = document.getElementById("announcementMeta");
  if (!meta) return;
  const enabled = announcement?.enabled ? "attivo" : "disattivato";
  const version = announcement?.content_version || "—";
  meta.textContent = `Stato: ${enabled} · versione ${version} · visto da ${viewsCount ?? 0} utenti`;
}

function renderAnnouncementPreview() {
  const body = document.getElementById("announcementBody")?.value || "";
  const title = document.getElementById("announcementTitle")?.value || "";
  const preview = document.getElementById("announcementPreview");
  if (!preview) return;

  if (typeof window.renderAnnouncementMarkdown === "function") {
    preview.innerHTML = `<strong>${title || "Senza titolo"}</strong><hr>${window.renderAnnouncementMarkdown(body)}`;
  } else {
    preview.textContent = body || "(vuoto)";
  }
}

async function loadAdminAnnouncement() {
  const { res, data } = await fetchAdmin("/api/admin/announcement");
  if (!res.ok) return;

  const announcement = data?.announcement || {};
  document.getElementById("announcementTitle").value = announcement.title || "";
  document.getElementById("announcementBody").value = announcement.body_markdown || "";
  document.getElementById("announcementEnabled").checked = !!announcement.enabled;
  updateAnnouncementMeta(announcement, data?.views_count ?? 0);
  renderAnnouncementPreview();
}

function initAdminAnnouncementForm() {
  const form = document.getElementById("adminAnnouncementForm");
  if (!form) return;

  document.getElementById("announcementPreviewBtn")?.addEventListener("click", async () => {
    if (typeof window.renderAnnouncementMarkdown !== "function") {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";
      script.onload = renderAnnouncementPreview;
      document.head.appendChild(script);
      return;
    }
    renderAnnouncementPreview();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setAnnouncementSaveMessage("Salvataggio...", "");

    const payload = {
      title: document.getElementById("announcementTitle")?.value || "",
      body_markdown: document.getElementById("announcementBody")?.value || "",
      enabled: !!document.getElementById("announcementEnabled")?.checked,
    };

    const { res, data } = await fetchAdmin("/api/admin/announcement", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      setAnnouncementSaveMessage(data?.detail || "Errore salvataggio", "error");
      return;
    }

    const versionNote = data?.version_changed
      ? " Nuova versione: tutti gli utenti lo rivedranno al prossimo login."
      : "";
    setAnnouncementSaveMessage(`Annuncio salvato.${versionNote}`, "ok");
    updateAnnouncementMeta(data?.announcement, data?.views_count ?? 0);
    renderAnnouncementPreview();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();
  initAdminTabs();
  initAdminLoginForm();
  initAdminAnnouncementForm();

  const ok = await ensureMainLogin();
  if (!ok) return;

  await authenticateAdminFlow();
});
