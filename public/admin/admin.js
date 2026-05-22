const ADMIN_USERNAME = "S10371278X";
const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

let assenzeItems = [];
let votiItems = [];

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
    return;
  }

  setLoginMessage("Accesso rapido in corso...");
  const bootstrapped = await tryBootstrapAdmin();
  if (bootstrapped && (await checkAdminAuthenticated())) {
    showDashboard();
    await loadDashboardData();
    return;
  }

  showGate();
  setLoginMessage("");
}

function renderStats(overview) {
  const stats = document.getElementById("adminStats");
  if (!stats) return;

  const cards = [
    ["Sessioni attive", overview.active_sessions],
    ["Voci assenze", overview.leaderboard_entries],
    ["Voci medie", overview.average_leaderboard_entries],
    ["Admin", overview.admin_username],
  ];

  stats.innerHTML = cards
    .map(
      ([label, value]) => `
      <article class="admin-stat">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </article>
    `,
    )
    .join("");
}

function renderSessions(usernames) {
  const container = document.getElementById("adminSessions");
  if (!container) return;

  if (!usernames?.length) {
    container.innerHTML = '<p class="admin-empty">Nessuna sessione attiva.</p>';
    return;
  }

  container.innerHTML = usernames
    .map((u) => `<span class="admin-session-chip">${u}</span>`)
    .join("");
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
      '<tr><td colspan="6" class="admin-empty">Nessuna voce in classifica medie.</td></tr>';
    return;
  }

  body.innerHTML = votiItems
    .map((item) => {
      const username = item.username || "";
      const subject = item.subject_name || "";
      const period = item.period_label || item.period_key || "";
      const periodKey = item.period_key || "";
      const visible = !!item.visible_in_leaderboard;
      return `
        <tr>
          <td>${username}</td>
          <td>${subject}</td>
          <td>${period}</td>
          <td>${Number(item.average || 0).toFixed(2)}</td>
          <td>${visibilityBadge(visible)}</td>
          <td>
            <div class="admin-actions">
              <button type="button" onclick="toggleVotiVisibility('${username}', '${subject}', '${periodKey}', ${!visible})">
                ${visible ? "Nascondi" : "Mostra"}
              </button>
              <button type="button" class="danger" onclick="deleteVotiEntry('${username}', '${subject}', '${periodKey}')">
                Elimina
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
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
      showGate();
      setLoginMessage("Sessione admin scaduta. Reinserisci la password.", "error");
      return;
    }

    if (!overviewRes.res.ok) throw new Error("Impossibile caricare panoramica");

    renderStats(overviewRes.data);
    renderSessions(overviewRes.data.active_usernames || []);

    assenzeItems = assenzeRes.data?.items || [];
    votiItems = votiRes.data?.items || [];
    renderAssenzeTable();
    renderVotiTable();

    const welcome = document.getElementById("adminWelcome");
    if (welcome) {
      welcome.textContent = `Connesso come ${overviewRes.data.admin_username}. Gestione classifiche e monitoraggio sistema.`;
    }
  } catch (err) {
    console.error(err);
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

window.toggleVotiVisibility = async function toggleVotiVisibility(
  username,
  subjectName,
  periodKey,
  visible,
) {
  const params = new URLSearchParams({
    subject_name: subjectName,
    period_key: periodKey,
  });
  const { res } = await fetchAdmin(
    `/api/admin/average-leaderboard/${encodeURIComponent(username)}/visibility?${params}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible_in_leaderboard: visible }),
    },
  );
  if (!res.ok) return;
  await reloadVotiTable();
};

window.deleteVotiEntry = async function deleteVotiEntry(
  username,
  subjectName,
  periodKey,
) {
  if (!confirm(`Eliminare la voce media di ${username} (${subjectName})?`)) return;
  const params = new URLSearchParams({
    subject_name: subjectName,
    period_key: periodKey,
  });
  const { res } = await fetchAdmin(
    `/api/admin/average-leaderboard/${encodeURIComponent(username)}?${params}`,
    { method: "DELETE" },
  );
  if (!res.ok) return;
  await reloadVotiTable();
};

window.adminPanelLogout = async function adminPanelLogout() {
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

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();
  initAdminTabs();
  initAdminLoginForm();

  const ok = await ensureMainLogin();
  if (!ok) return;

  await authenticateAdminFlow();
});
