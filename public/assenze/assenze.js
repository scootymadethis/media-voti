const agendaCache = new Map();

let currentLeaderboardType = "class";
let currentLeaderboardPage = 1;
const leaderboardPageSize = 10;

let myClassCode = null;
let myUsername = null;
let myFullName = null;

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();
  initLeaderboardTabs();

  console.log("[assenze] origin:", location.origin);
  console.log(
    "[assenze] localStorage.loggedIn (before redirect check):",
    localStorage.getItem("loggedIn"),
  );

  if (localStorage.getItem("loggedIn") !== "true") {
    console.warn(
      "[assenze] not logged in according to localStorage - redirecting to login",
      {
        origin: location.origin,
        loggedIn: localStorage.getItem("loggedIn"),
        referrer: document.referrer,
      },
    );
    window.location.href = "/";
    return;
  }

  try {
    showLoading(true);

    myUsername = localStorage.getItem("username") || null;
    myFullName = localStorage.getItem("fullName") || null;

    try {
      myClassCode = await logClasseFromFirstLesson();
      console.log("Classe rilevata:", myClassCode);
    } catch (err) {
      console.error("Errore durante il recupero della classe:", err);
      myClassCode = null;
    }

    let assenzeData = [];
    try {
      const res = await fetchAssenze();
      assenzeData = res?.assenze?.events ?? [];
    } catch (err) {
      console.error("Errore durante il recupero delle assenze:", err);
    }

    const oreAssenza = calculateAbsenceHours(assenzeData);
    console.log("Ore di assenza totali:", oreAssenza);

    const badge = document.getElementById("myHoursBadge");
    if (badge) badge.textContent = `${oreAssenza} ore`;

    try {
      await saveMyAbsenceHours({
        classCode: myClassCode,
        hours: oreAssenza,
        fullName: myFullName,
      });
    } catch (err) {
      console.error("Errore durante il salvataggio delle ore:", err);
    }

    try {
      await loadAndRenderLeaderboard();
    } catch (err) {
      console.error("Errore durante il caricamento della classifica:", err);
      renderLeaderboardEmpty("Impossibile caricare la classifica.");
    }
  } catch (err) {
    console.error("Errore inizializzazione pagina assenze:", err);
    renderLeaderboardEmpty("Si è verificato un errore durante il caricamento.");
  } finally {
    showLoading(false);
  }
});

function calculateAbsenceHours(assenzeData) {
  let oreAssenza = 0;

  assenzeData.forEach((assenza) => {
    const codiceAssenza = assenza?.evtCode;
    let ore = 0;

    switch (codiceAssenza) {
      case "ABA0": // Assenza intera
        ore = 6;
        break;
      case "ABU0": // Uscita anticipata
      case "ABR0": // Ritardo
      case "ABR1": // Ritardo
        ore = assenza?.evtValue != null ? Number(assenza.evtValue) || 0 : 0;
        break;
      default:
        ore = 0;
        break;
    }

    oreAssenza += ore;
  });

  const sconto = Math.round(calcolaRiduzioneProporzionale(oreAssenza));
  return oreAssenza - sconto;
}

function calcolaRiduzioneProporzionale(oreAssenza) {
  if (oreAssenza <= 0) return 0;

  // 102, 146 e 263 sono punti di riferimento presi dalle ore di 3 studenti
  // Punto 1: 102 -> 4
  if (oreAssenza <= 102) {
    return (oreAssenza / 102) * 4;
  }

  // Tra 102 e 136: da 4 a 15
  if (oreAssenza <= 136) {
    return 4 + ((oreAssenza - 102) / (136 - 102)) * (15 - 4);
  }

  // Tra 136 e 263: da 15 a 33
  if (oreAssenza <= 263) {
    return 15 + ((oreAssenza - 136) / (263 - 136)) * (33 - 15);
  }

  // Oltre 263 continuo con la stessa proporzione dell'ultimo tratto
  return 33 + ((oreAssenza - 263) / (263 - 136)) * (33 - 15);
}

function showLoading(show) {
  const overlay = document.getElementById("loading-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !show);
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getWeekStartDate(offsetWeeks) {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = (day + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMon + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

async function fetchAgendaInterval(
  startYYYYMMDD,
  endYYYYMMDD,
  { prefetch = false } = {},
) {
  const cacheKey = `${startYYYYMMDD}-${endYYYYMMDD}`;
  if (agendaCache.has(cacheKey)) return agendaCache.get(cacheKey);

  const res = await fetch("/api/agenda", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: startYYYYMMDD, end: endYYYYMMDD }),
  });

  if (!res.ok) {
    if (!prefetch) await handleAuthFail(res);
    throw new Error("Error fetching agenda");
  }

  const data = await res.json();
  agendaCache.set(cacheKey, data);
  return data;
}

async function loadAgendaWeek(offsetWeeks) {
  const startDate = getWeekStartDate(offsetWeeks);
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);

  const start = formatDateYYYYMMDD(startDate);
  const end = formatDateYYYYMMDD(endDate);

  return await fetchAgendaInterval(start, end);
}

function extractEvents(agendaData) {
  if (!agendaData) return [];
  if (Array.isArray(agendaData)) return agendaData;
  if (Array.isArray(agendaData.agenda)) return agendaData.agenda;
  if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda)) {
    return agendaData.agenda.agenda;
  }

  for (const k of Object.keys(agendaData)) {
    if (Array.isArray(agendaData[k])) return agendaData[k];
  }

  return [];
}

async function logClasseFromFirstLesson({
  maxWeeksToCheck = 52,
  startOffset = 0,
} = {}) {
  for (
    let offset = startOffset;
    offset < startOffset + maxWeeksToCheck;
    offset++
  ) {
    try {
      const agendaData = await loadAgendaWeek(offset);
      const events = extractEvents(agendaData);

      const firstLesson = events.find((ev) => {
        const classDesc = ev?.classDesc;
        return typeof classDesc === "string" && classDesc.trim().length > 0;
      });

      if (firstLesson) {
        const classDesc = firstLesson.classDesc.trim();
        const firstChunk = classDesc.split(" ")[0]?.trim() || classDesc;
        const classCode = firstChunk.toUpperCase();

        console.log("Classe:", classCode);
        return classCode;
      }
    } catch (err) {
      console.error(`Errore nel fetch agenda settimana offset ${offset}:`, err);
    }
  }

  console.log("Classe: non trovata");
  return null;
}

async function fetchAssenze() {
  const res = await fetch("/api/assenze", {
    method: "POST",
    credentials: "include",
  });

  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch assenze");
  }

  return await res.json();
}

async function saveMyAbsenceHours({ classCode, hours, fullName }) {
  console.log("[leaderboard] saving", { classCode, hours, fullName });

  const res = await fetch("/api/leaderboard/update", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      class_code: classCode,
      hours,
      full_name: fullName,
    }),
  });

  const rawText = await res.text();
  console.log("[leaderboard] save status:", res.status);
  console.log("[leaderboard] save raw response:", rawText);

  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (e) {
    console.warn("[leaderboard] risposta non json", e);
  }

  if (!res.ok) {
    throw new Error("Errore nel salvataggio delle ore");
  }

  if (data?.saved?.username) {
    myUsername = data.saved.username;
  }

  return data;
}

async function loadAndRenderLeaderboard() {
  const params = new URLSearchParams({
    type: currentLeaderboardType,
    page: String(currentLeaderboardPage),
    page_size: String(leaderboardPageSize),
  });

  if (currentLeaderboardType === "class" && myClassCode) {
    params.set("class_code", myClassCode);
  }

  const res = await fetch(`/api/leaderboard?${params.toString()}`, {
    method: "GET",
    credentials: "include",
  });

  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Errore nel caricamento della classifica");
  }

  const data = await res.json();
  renderLeaderboard(data);
}

function initLeaderboardTabs() {
  const tabClassBtn = document.getElementById("tabClassBtn");
  const tabGlobalBtn = document.getElementById("tabGlobalBtn");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");

  tabClassBtn?.addEventListener("click", async () => {
    currentLeaderboardType = "class";
    currentLeaderboardPage = 1;
    setActiveLeaderboardTab();
    showLoading(true);
    try {
      await loadAndRenderLeaderboard();
    } catch (err) {
      console.error(err);
      renderLeaderboardEmpty("Impossibile caricare la classifica di classe.");
    } finally {
      showLoading(false);
    }
  });

  tabGlobalBtn?.addEventListener("click", async () => {
    currentLeaderboardType = "global";
    currentLeaderboardPage = 1;
    setActiveLeaderboardTab();
    showLoading(true);
    try {
      await loadAndRenderLeaderboard();
    } catch (err) {
      console.error(err);
      renderLeaderboardEmpty("Impossibile caricare la classifica globale.");
    } finally {
      showLoading(false);
    }
  });

  prevPageBtn?.addEventListener("click", async () => {
    if (currentLeaderboardPage <= 1) return;
    currentLeaderboardPage--;
    showLoading(true);
    try {
      await loadAndRenderLeaderboard();
    } catch (err) {
      console.error(err);
    } finally {
      showLoading(false);
    }
  });

  nextPageBtn?.addEventListener("click", async () => {
    currentLeaderboardPage++;
    showLoading(true);
    try {
      await loadAndRenderLeaderboard();
    } catch (err) {
      console.error(err);
      currentLeaderboardPage = Math.max(1, currentLeaderboardPage - 1);
    } finally {
      showLoading(false);
    }
  });

  setActiveLeaderboardTab();
}

function setActiveLeaderboardTab() {
  const tabClassBtn = document.getElementById("tabClassBtn");
  const tabGlobalBtn = document.getElementById("tabGlobalBtn");

  tabClassBtn?.classList.toggle("active", currentLeaderboardType === "class");
  tabGlobalBtn?.classList.toggle("active", currentLeaderboardType === "global");
}

function renderLeaderboard(data) {
  const list = document.getElementById("leaderboardList");
  const meta = document.getElementById("leaderboardMeta");
  const pageIndicator = document.getElementById("pageIndicator");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");

  if (!list) return;

  const items = data?.items ?? [];
  const page = data?.page ?? 1;
  const totalPages = data?.total_pages ?? 1;
  const totalItems = data?.total_items ?? 0;
  const scope = data?.scope ?? currentLeaderboardType;
  const classCode = data?.class_code ?? myClassCode ?? null;

  if (meta) {
    meta.textContent =
      scope === "class"
        ? `Classifica della tua classe${classCode ? ` (${classCode})` : ""} · ${totalItems} studenti`
        : `Classifica globale · ${totalItems} studenti`;
  }

  if (pageIndicator) {
    pageIndicator.textContent = `Pagina ${page} di ${totalPages}`;
  }

  if (prevPageBtn) prevPageBtn.disabled = page <= 1;
  if (nextPageBtn) nextPageBtn.disabled = page >= totalPages;

  if (!items.length) {
    renderLeaderboardEmpty("Nessun dato disponibile per questa classifica.");
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const rankClass =
        item.rank === 1
          ? "rank-1"
          : item.rank === 2
            ? "rank-2"
            : item.rank === 3
              ? "rank-3"
              : "";

      const isMe = myUsername && item.username === myUsername;

      return `
  <div class="leaderboard-row ${isMe ? "is-me" : ""}">
    <div class="rank-pill ${rankClass}">#${item.rank}</div>

    <div class="leaderboard-user">
      <div class="leaderboard-user-main">
        <div class="leaderboard-username">
          ${escapeHtml(item.full_name || item.username)}
        </div>
        ${isMe ? `<span class="leaderboard-you">Tu</span>` : ""}
      </div>
      <div class="leaderboard-class">
        Classe: ${escapeHtml(item.class_code || "N/D")}
      </div>
    </div>

    <div class="leaderboard-hours">${formatHours(item.hours)} ore</div>
  </div>
`;
    })
    .join("");
}

function renderLeaderboardEmpty(message) {
  const list = document.getElementById("leaderboardList");
  const pageIndicator = document.getElementById("pageIndicator");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");

  if (list) {
    list.innerHTML = `<div class="leaderboard-empty">${escapeHtml(message)}</div>`;
  }

  if (pageIndicator) {
    pageIndicator.textContent = "Pagina 1";
  }

  if (prevPageBtn) prevPageBtn.disabled = true;
  if (nextPageBtn) nextPageBtn.disabled = true;
}

function formatHours(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function handleAuthFail(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    try {
      body = await res.text();
    } catch {
      body = null;
    }
  }

  console.log("Auth fail:", res.status, body);
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

function goToHome() {
  window.location.href = "/dashboard";
}

function goToVoti() {
  window.location.href = "/voti";
}

function logout() {
  localStorage.removeItem("loggedIn");
  localStorage.removeItem("username");
  window.location.href = "/";
}
