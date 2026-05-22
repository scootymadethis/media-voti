const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
const wsUrl = (path) => window.APP_CONFIG?.wsUrl?.(path) ?? path;

let selectedPeriod = "";
const calcolatorBtn = document.getElementById("calculate-grade");

const averageLeaderboardPageSize = 10;
let averageLeaderboardType = "class";
let averageLeaderboardPage = 1;
let averageLeaderboardVisible = true;
let averageLeaderboardSocket = null;
let averageLeaderboardReconnectTimer = null;

let myClassCode = null;
let mySchoolCode = null;
let myUsername = null;
let myFullName = null;
let currentAverageValue = 0;

const GENERAL_AVERAGE_LEADERBOARD_SUBJECT = "Media generale";
const GENERAL_AVERAGE_LEADERBOARD_PERIOD_KEY = "generale";
const GENERAL_AVERAGE_LEADERBOARD_PERIOD_LABEL = "Media generale";

function setCurrentGeneralAverageValue(voti = null) {
  currentAverageValue = getGeneralAverageValue(voti);
  return currentAverageValue;
}

function getAverageLeaderboardWsUrl() {
  return wsUrl("/api/ws/leaderboard");
}

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();
  initAverageLeaderboardTabs();
  initAverageLeaderboardPreferenceControls();

  const loading = document.getElementById("loading-overlay");
  if (loading) loading.classList.remove("hidden");

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/";
    return;
  }

  const votiDiv = document.querySelector(".actual-voti");
  const materiaSelect = document.getElementById("materiaSelect");
  if (votiDiv) votiDiv.innerHTML = "";

  try {
    myUsername = localStorage.getItem("username") || null;
    myFullName = localStorage.getItem("fullName") || null;
    mySchoolCode = localStorage.getItem("schoolCode") || null;

    try {
      myClassCode = await logClasseFromFirstLesson();
    } catch (err) {
      console.error("Errore durante il recupero della classe:", err);
      myClassCode = null;
    }

    const materie = [];
    const votiData = await fetchVoti();
    const voti = votiData.voti.grades || [];

    voti.forEach((voto) => {
      if (!materie.includes(voto.subjectDesc)) materie.push(voto.subjectDesc);
  });

    voti.sort((a, b) => new Date(b.evtDate) - new Date(a.evtDate));
    materie.sort();
    setCurrentGeneralAverageValue(voti);

    connectAverageLeaderboardRealtime();

    if (materie.length && voti.length) {
      renderVoti(materie, voti);
      if (materiaSelect) materiaSelect.value = materie[0];
      handleMateriaChange(materie[0], voti);
    } else {
      if (votiDiv) {
        votiDiv.innerHTML =
          '<div class="empty-voti">Nessun voto disponibile al momento.</div>';
      }
      renderMedia(0);
      updateAverageBadge();
      updateAverageLeaderboardPreferenceUI();
      renderAverageLeaderboardEmpty("Nessuna classifica disponibile al momento.");
    }

    loading?.classList.add("hidden");

    if (calcolatorBtn) {
      calcolatorBtn.onclick = () => {
        const voti = document.querySelectorAll(".voto-score");
        let numVoti = 0;
        for (let i = 0; i < voti.length; i++) {
          const voto = voti[i];
          if (!voto.classList.contains("grade-blue")) numVoti++;
        }

        const averageScore = document.querySelector(".average-score");
        const mediaAttuale = parseFloat(averageScore?.textContent || "0");
        calculateNeededGrades(mediaAttuale, numVoti);
      };
    }
  } catch (err) {
    console.error(err);
    document.getElementById("loading-overlay")?.classList.add("hidden");
    renderAverageLeaderboardEmpty("Si è verificato un errore durante il caricamento.");
  }

  });

window.addEventListener("beforeunload", () => {
  if (averageLeaderboardReconnectTimer) {
    clearTimeout(averageLeaderboardReconnectTimer);
  }
  if (averageLeaderboardSocket) {
    averageLeaderboardSocket.close();
  }
});

async function fetchVoti() {
  const res = await fetch(apiUrl("/api/voti"), {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch voti");
  }
  return await res.json();
}

function renderVoti(materie, voti) {
  const materiaSelect = document.getElementById("materiaSelect");
  const periodDiv = document.querySelector(".voti-periodo");
  const votiDiv = document.querySelector(".actual-voti");
  const averageDiv = document.querySelector(".average");

  if (!materiaSelect || !periodDiv || !votiDiv || !averageDiv) return;

  materiaSelect.innerHTML = '<option value="">Seleziona una materia</option>';
  periodDiv.innerHTML = "";
  votiDiv.innerHTML = "";
  averageDiv.innerHTML = "";

  materie.forEach((materia) => {
    const option = document.createElement("option");
    option.value = materia;
    option.textContent = materia;
    materiaSelect.appendChild(option);
  });

  materiaSelect.onchange = (event) => {
    handleMateriaChange(event.target.value, voti);
  };
}

function handleMateriaChange(materia, voti) {
  const periodDiv = document.querySelector(".voti-periodo");
  const votiDiv = document.querySelector(".actual-voti");
  const resultDiv = document.querySelector(".result");
  const wantedAverageInput = document.getElementById("wanted-average");
  const numVotiInput = document.getElementById("grades-number");
  if (!periodDiv || !votiDiv || !resultDiv || !wantedAverageInput || !numVotiInput) return;

  periodDiv.innerHTML = "";
  votiDiv.innerHTML = "";
  resultDiv.innerHTML = "";
  wantedAverageInput.value = 6;
  numVotiInput.value = 1;

  if (!materia) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Seleziona una materia per vedere i voti.</div>';
    renderMedia(0);
    void refreshAverageLeaderboardForCurrentSelection();
    return;
  }

  const votiPrimoPeriodo = [];
  const votiSecondoPeriodo = [];

  voti.forEach((voto) => {
    if (voto.subjectDesc !== materia) return;
    if (voto.periodPos == 1) votiPrimoPeriodo.push(voto);
    if (voto.periodPos == 3) votiSecondoPeriodo.push(voto);
  });

  const choosePeriod = (label, items, node) => {
    resultDiv.innerHTML = "";
    wantedAverageInput.value = 6;
    numVotiInput.value = 1;
    votiDiv.innerHTML = "";
    selectedPeriod = label;
    document.querySelector(".periodo.selected")?.classList.remove("selected");
    node?.classList.add("selected");
    renderActualVoti(items, label, materia);
  };

  if (votiPrimoPeriodo.length > 0) {
    const periodo1Div = document.createElement("button");
    periodo1Div.type = "button";
    periodo1Div.innerHTML = '<span class="periodo-text">Trimestre</span>';
    periodo1Div.classList.add("periodo", "trimestre", "selected");
    periodo1Div.onclick = () => choosePeriod("Trimestre", votiPrimoPeriodo, periodo1Div);
    periodDiv.appendChild(periodo1Div);
  }

  if (votiSecondoPeriodo.length > 0) {
    const periodo2Div = document.createElement("button");
    periodo2Div.type = "button";
    periodo2Div.innerHTML = '<span class="periodo-text">Pentamestre</span>';
    periodo2Div.classList.add("periodo", "pentamestre");
    periodo2Div.onclick = () => choosePeriod("Pentamestre", votiSecondoPeriodo, periodo2Div);
    periodDiv.appendChild(periodo2Div);
  }

  if (selectedPeriod === "") {
    if (votiPrimoPeriodo.length > 0) {
      renderActualVoti(votiPrimoPeriodo, "Trimestre", materia);
    } else if (votiSecondoPeriodo.length > 0) {
      periodDiv.firstElementChild?.classList.add("selected");
      renderActualVoti(votiSecondoPeriodo, "Pentamestre", materia);
    }
  } else if (selectedPeriod === "Trimestre") {
    choosePeriod("Trimestre", votiPrimoPeriodo, periodDiv.querySelector(".trimestre"));
  } else if (selectedPeriod === "Pentamestre") {
    choosePeriod("Pentamestre", votiSecondoPeriodo, periodDiv.querySelector(".pentamestre"));
  }

  if (votiPrimoPeriodo.length === 0 && votiSecondoPeriodo.length === 0) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Nessun voto disponibile per questa materia.</div>';
    renderMedia(0);
    void refreshAverageLeaderboardForCurrentSelection();
  }
}

function renderActualVoti(voti, periodoLabel = "Periodo", materia = "") {
  const votiDiv = document.querySelector(".actual-voti");
  if (!votiDiv) return;

  votiDiv.innerHTML = "";

  let media = 0;
  let votiLength = voti.length;

  voti.forEach((voto) => {
    if (voto.color == "blue") votiLength -= 1;
    if (voto.displayValue == "") votiLength -= 1;

    const votoDiv = document.createElement("div");
    votoDiv.classList.add("voto");

    let votoColor = "blue";

    if (voto.displayValue != "") {
      if (voto.color == "blue") {
        votoColor = "blue";
      } else {
        votoColor = getColorFromVoto(voto.decimalValue.toFixed(2));
      }
    }

    votoDiv.innerHTML = `
      <div class="voto-score grade-${votoColor}">${voto.displayValue}</div>
      <div class="voto-meta">
        <div class="voto-desc">${voto.notesForFamily || "Valutazione registrata"}</div>
      </div>
      <div class="voto-date">${new Date(voto.evtDate).toLocaleDateString("it-IT")}</div>
    `;
    votoDiv.onclick = () => openEntryModal(voto);
    votiDiv.appendChild(votoDiv);

    if (voto.color != "blue" && voto.displayValue != "") {
      media += parseFloat(voto.decimalValue) || 0;
    }
  });

  if (!voti.length) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Nessun voto disponibile per questa selezione.</div>';
  }

  media = votiLength > 0 ? media / votiLength : 0;
  renderMedia(media.toFixed(2));
  void refreshAverageLeaderboardForCurrentSelection();
}

function getGeneralAverageValue(voti = null) {
  const savedValue = parseFloat(localStorage.getItem("media_generale") || "");
  if (Number.isFinite(savedValue)) {
    return Math.max(0, Math.min(10, savedValue));
  }

  if (!Array.isArray(voti)) return 0;

  let sum = 0;
  let count = 0;
  voti.forEach((voto) => {
    if (voto?.color === "blue" || voto?.displayValue === "") return;
    const numericValue = parseFloat(voto?.decimalValue);
    if (!Number.isFinite(numericValue)) return;
    sum += numericValue;
    count += 1;
  });

  return count > 0 ? sum / count : 0;
}

function renderMedia(media) {
  const averageDiv = document.querySelector(".average");
  if (!averageDiv) return;

  const value = Math.max(0, Math.min(10, parseFloat(media) || 0));
  averageDiv.innerHTML = `
    <span class="average-label">Media</span>
    ${getAverageRingMarkup(value)}
  `;
}

function calculateNeededGrades(mediaAttuale, numVoti) {
  const mediaInput = document.getElementById("wanted-average");
  const numVotiInput = document.getElementById("grades-number");
  const errorP = document.getElementById("error");
  const resultP = document.getElementById("result");

  if (!mediaInput || !numVotiInput || !errorP || !resultP) return;

  const target = parseFloat(mediaInput.value);
  const num = parseInt(numVotiInput.value);

  if (isNaN(target) || target < 0 || target > 10) {
    errorP.textContent = "Inserisci una media desiderata valida (0-10).";
    resultP.textContent = "";
    return;
  }

  if (isNaN(num) || num <= 0) {
    errorP.textContent = "Inserisci un numero di voti valido (>0).";
    resultP.textContent = "";
    return;
  }

  const totalNeeded = target * (numVoti + num) - mediaAttuale * numVoti;
  const neededGrade = totalNeeded / num;

  if (neededGrade > 10) {
    errorP.textContent = `Non è possibile raggiungere una media di ${target} con ${num} voti.`;
    resultP.textContent = "";
    return;
  }

  if (neededGrade < 0) {
    errorP.textContent = `Hai già raggiunto una media di ${target} o superiore.`;
    resultP.textContent = "";
    return;
  }

  errorP.textContent = "";
  resultP.innerHTML = "<p class='result-text'>Voti necessari:</p><br>";

  const roundedGrade = Math.round(neededGrade * 4) / 4;

  function formatGrade(grade) {
    const integerPart = Math.floor(grade);
    const decimalPart = grade - integerPart;

    if (grade >= 10) return "10";
    if (decimalPart === 0) return `${integerPart}`;
    if (decimalPart === 0.25) return `${integerPart}+`;
    if (decimalPart === 0.5) return `${integerPart}.5`;
    if (decimalPart === 0.75) return `${integerPart + 1}-`;

    return grade.toFixed(2);
  }

  const gradesRow = document.createElement("div");
  gradesRow.classList.add("result-grades-row");
  const formattedGrade = formatGrade(roundedGrade);

  for (let i = 0; i < num; i++) {
    const votoDiv = document.createElement("div");
    votoDiv.classList.add("voto-circle");

    let color = "#f43f5e";
    if (roundedGrade >= 6) color = "#22c55e";
    else if (roundedGrade >= 5.75) color = "#facc15";

    votoDiv.style.backgroundColor = color;
    votoDiv.textContent = formattedGrade;
    gradesRow.appendChild(votoDiv);
  }

  resultP.appendChild(gradesRow);
}

function getPeriodKey(periodLabel) {
  const normalized = String(periodLabel || "").trim().toLowerCase();
  if (normalized === "trimestre") return "trimestre";
  if (normalized === "pentamestre") return "pentamestre";
  return normalized.replace(/\s+/g, "-");
}

function getLeaderboardContext() {
  return {
    subjectName: GENERAL_AVERAGE_LEADERBOARD_SUBJECT,
    periodKey: GENERAL_AVERAGE_LEADERBOARD_PERIOD_KEY,
    periodLabel: GENERAL_AVERAGE_LEADERBOARD_PERIOD_LABEL,
  };
}

function getDisplayedAverageValue() {
  return Math.max(0, Math.min(10, Number(currentAverageValue) || 0));
}

function getAverageRingColor(value) {
  if (value >= 6) return "#22c55e";
  if (value >= 5.75) return "#facc15";
  return "#f43f5e";
}

function getAverageRingMarkup(value, { mini = false } = {}) {
  const safeValue = Math.max(0, Math.min(10, Number(value) || 0));
  const percent = (safeValue / 10) * 100;
  const containerClass = mini
    ? "average-score-container average-score-container--mini"
    : "average-score-container";
  const labelClass = mini
    ? "average-score average-score--mini"
    : "average-score";

  return `
    <div class="${containerClass}" style="--p:${percent}%;--ring-color:${getAverageRingColor(safeValue)};">
      <span class="${labelClass}">${formatAverage(safeValue)}</span>
    </div>
  `;
}

function updateAverageBadge() {
  const badge = document.getElementById("myAverageBadge");
  setCurrentGeneralAverageValue();
  if (!badge) return;

  badge.innerHTML = getAverageRingMarkup(currentAverageValue, { mini: true });
}

async function loadAverageLeaderboardPreference() {
  const { subjectName, periodKey } = getLeaderboardContext();

  try {
    const params = new URLSearchParams({
      subject_name: subjectName,
      period_key: periodKey,
    });

    const res = await fetch(apiUrl(`/api/average-leaderboard/me?${params.toString()}`), {
      method: "GET",
      credentials: "include",
    });

    if (!res.ok) {
      await handleAuthFail(res);
      return true;
    }

    const data = await res.json();
    if (data?.item && typeof data.item.visible_in_leaderboard === "boolean") {
      return data.item.visible_in_leaderboard;
    }

    return Boolean(data?.default_visible_in_leaderboard ?? true);
  } catch (err) {
    console.error("Errore durante il caricamento della preferenza classifica media:", err);
    return true;
  }
}

function updateAverageLeaderboardPreferenceUI() {
  const text = document.getElementById("averageLeaderboardVisibilityText");
  const button = document.getElementById("toggleAverageLeaderboardVisibilityBtn");
  const scopeLabel = "media generale";

  if (text) {
    if (averageLeaderboardVisible === true) {
      text.textContent = `Al momento compari nella classifica della ${scopeLabel}. Se disattivi questa opzione, sparirai subito dalla classifica.`;
    } else {
      text.textContent = `Al momento non compari nella classifica della ${scopeLabel}. Se riattivi questa opzione, tornerai subito visibile.`;
    }
  }

  if (button) {
    button.textContent = averageLeaderboardVisible === true
      ? "Nascondimi dalla classifica"
      : "Fammi comparire in classifica";
  }
}

async function syncAverageLeaderboardPreference() {
  updateAverageBadge();
  updateAverageLeaderboardPreferenceUI();

  try {
    await saveMyAverage({
      classCode: myClassCode,
      schoolCode: mySchoolCode,
      average: currentAverageValue,
      fullName: myFullName,
      visibleInLeaderboard: Boolean(averageLeaderboardVisible),
      subjectName: GENERAL_AVERAGE_LEADERBOARD_SUBJECT,
      periodKey: GENERAL_AVERAGE_LEADERBOARD_PERIOD_KEY,
      periodLabel: GENERAL_AVERAGE_LEADERBOARD_PERIOD_LABEL,
    });
  } catch (err) {
    console.error("Errore durante il salvataggio della media:", err);
  }
}

async function refreshAverageLeaderboardForCurrentSelection() {
  setCurrentGeneralAverageValue();
  updateAverageBadge();

  try {
    averageLeaderboardVisible = await loadAverageLeaderboardPreference();
    updateAverageLeaderboardPreferenceUI();
    await syncAverageLeaderboardPreference();
    averageLeaderboardPage = 1;
    await loadAndRenderAverageLeaderboard();
  } catch (err) {
    console.error("Errore aggiornando la classifica media:", err);
    renderAverageLeaderboardEmpty("Impossibile caricare la classifica per questa selezione.");
  }
}

function connectAverageLeaderboardRealtime() {
  if (
    averageLeaderboardSocket &&
    (averageLeaderboardSocket.readyState === WebSocket.OPEN ||
      averageLeaderboardSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  try {
    averageLeaderboardSocket = new WebSocket(getAverageLeaderboardWsUrl());
  } catch (err) {
    console.error("Errore apertura websocket classifica media:", err);
    scheduleAverageLeaderboardReconnect();
    return;
  }

  averageLeaderboardSocket.addEventListener("open", () => {
    if (averageLeaderboardReconnectTimer) {
      clearTimeout(averageLeaderboardReconnectTimer);
      averageLeaderboardReconnectTimer = null;
    }
  });

  averageLeaderboardSocket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === "average_leaderboard_changed") {
        await loadAndRenderAverageLeaderboard();
      }
    } catch (err) {
      console.error("Errore messaggio realtime classifica media:", err);
    }
  });

  averageLeaderboardSocket.addEventListener("close", () => {
    scheduleAverageLeaderboardReconnect();
  });

  averageLeaderboardSocket.addEventListener("error", (err) => {
    console.error("[average-leaderboard] websocket error", err);
    try {
      averageLeaderboardSocket?.close();
    } catch (_) {}
  });
}

function scheduleAverageLeaderboardReconnect() {
  if (averageLeaderboardReconnectTimer) return;
  averageLeaderboardReconnectTimer = setTimeout(() => {
    averageLeaderboardReconnectTimer = null;
    connectAverageLeaderboardRealtime();
  }, 2500);
}

function initAverageLeaderboardPreferenceControls() {
  const button = document.getElementById("toggleAverageLeaderboardVisibilityBtn");
  button?.addEventListener("click", async () => {

    averageLeaderboardVisible = !Boolean(averageLeaderboardVisible);
    updateAverageLeaderboardPreferenceUI();
    showLoading(true);
    try {
      await syncAverageLeaderboardPreference();
      averageLeaderboardPage = 1;
      await loadAndRenderAverageLeaderboard();
    } catch (err) {
      console.error("Errore aggiornando la preferenza classifica media:", err);
    } finally {
      showLoading(false);
    }
  });

  updateAverageLeaderboardPreferenceUI();
}

async function saveMyAverage({ classCode, schoolCode, average, fullName, visibleInLeaderboard, subjectName, periodKey, periodLabel }) {
  const res = await fetch(apiUrl("/api/average-leaderboard/update"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      class_code: classCode,
      school_code: schoolCode || null,
      average,
      full_name: fullName,
      visible_in_leaderboard: visibleInLeaderboard,
      subject_name: subjectName,
      period_key: periodKey,
      period_label: periodLabel,
    }),
  });

  const rawText = await res.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (e) {
    console.warn("[average-leaderboard] risposta non json", e);
  }

  if (!res.ok) throw new Error("Errore nel salvataggio della media");
  if (data?.saved?.username) myUsername = data.saved.username;
  return data;
}

async function loadAndRenderAverageLeaderboard() {
  const params = new URLSearchParams({
    type: averageLeaderboardType,
    page: String(averageLeaderboardPage),
    page_size: String(averageLeaderboardPageSize),
    subject_name: GENERAL_AVERAGE_LEADERBOARD_SUBJECT,
    period_key: GENERAL_AVERAGE_LEADERBOARD_PERIOD_KEY,
  });

  if (averageLeaderboardType === "class" && myClassCode) {
    params.set("class_code", myClassCode);
    if (mySchoolCode) params.set("school_code", mySchoolCode);
  }

  const res = await fetch(apiUrl(`/api/average-leaderboard?${params.toString()}`), {
    method: "GET",
    credentials: "include",
  });

  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Errore nel caricamento della classifica media");
  }

  const data = await res.json();
  renderAverageLeaderboard(data);
}

function initAverageLeaderboardTabs() {
  const tabClassBtn = document.getElementById("averageTabClassBtn");
  const tabGlobalBtn = document.getElementById("averageTabGlobalBtn");
  const prevPageBtn = document.getElementById("averagePrevPageBtn");
  const nextPageBtn = document.getElementById("averageNextPageBtn");

  tabClassBtn?.addEventListener("click", async () => {
    averageLeaderboardType = "class";
    averageLeaderboardPage = 1;
    setActiveAverageLeaderboardTab();
    showLoading(true);
    try {
      await loadAndRenderAverageLeaderboard();
    } catch (err) {
      console.error(err);
      renderAverageLeaderboardEmpty("Impossibile caricare la classifica di classe.");
    } finally {
      showLoading(false);
    }
  });

  tabGlobalBtn?.addEventListener("click", async () => {
    averageLeaderboardType = "global";
    averageLeaderboardPage = 1;
    setActiveAverageLeaderboardTab();
    showLoading(true);
    try {
      await loadAndRenderAverageLeaderboard();
    } catch (err) {
      console.error(err);
      renderAverageLeaderboardEmpty("Impossibile caricare la classifica globale.");
    } finally {
      showLoading(false);
    }
  });

  prevPageBtn?.addEventListener("click", async () => {
    if (averageLeaderboardPage <= 1) return;
    averageLeaderboardPage -= 1;
    showLoading(true);
    try {
      await loadAndRenderAverageLeaderboard();
    } catch (err) {
      console.error(err);
    } finally {
      showLoading(false);
    }
  });

  nextPageBtn?.addEventListener("click", async () => {
    averageLeaderboardPage += 1;
    showLoading(true);
    try {
      await loadAndRenderAverageLeaderboard();
    } catch (err) {
      console.error(err);
      averageLeaderboardPage = Math.max(1, averageLeaderboardPage - 1);
    } finally {
      showLoading(false);
    }
  });

  setActiveAverageLeaderboardTab();
}

function setActiveAverageLeaderboardTab() {
  document.getElementById("averageTabClassBtn")?.classList.toggle("active", averageLeaderboardType === "class");
  document.getElementById("averageTabGlobalBtn")?.classList.toggle("active", averageLeaderboardType === "global");
}

function renderAverageLeaderboard(data) {
  const list = document.getElementById("averageLeaderboardList");
  const meta = document.getElementById("averageLeaderboardMeta");
  const pageIndicator = document.getElementById("averagePageIndicator");
  const prevPageBtn = document.getElementById("averagePrevPageBtn");
  const nextPageBtn = document.getElementById("averageNextPageBtn");
  if (!list) return;

  const items = data?.items ?? [];
  const page = data?.page ?? 1;
  const totalPages = data?.total_pages ?? 1;
  const totalItems = data?.total_items ?? 0;
  const scope = data?.scope ?? averageLeaderboardType;
  const classCode = data?.class_code ?? myClassCode ?? null;
  if (meta) {
    meta.textContent =
      scope === "class"
        ? `Media generale · Classe${classCode ? ` ${classCode}` : ""} · ${totalItems} studenti`
        : `Media generale · Globale · ${totalItems} studenti`;
  }

  if (pageIndicator) pageIndicator.textContent = `Pagina ${page} di ${totalPages}`;
  if (prevPageBtn) prevPageBtn.disabled = page <= 1;
  if (nextPageBtn) nextPageBtn.disabled = page >= totalPages;

  if (!items.length) {
    renderAverageLeaderboardEmpty("Nessun dato disponibile per questa classifica.");
    return;
  }

  list.innerHTML = items.map((item) => {
    const rankClass = item.rank === 1 ? "rank-1" : item.rank === 2 ? "rank-2" : item.rank === 3 ? "rank-3" : "";
    const isMe = myUsername && item.username === myUsername;
    return `
      <div class="leaderboard-row ${isMe ? "is-me" : ""}">
        <div class="rank-pill ${rankClass}">#${item.rank}</div>
        <div class="leaderboard-user">
          <div class="leaderboard-user-main">
            <div class="leaderboard-username">${escapeHtml(item.full_name || item.username)}</div>
            ${isMe ? '<span class="leaderboard-you">Tu</span>' : ""}
          </div>
          <div class="leaderboard-class">Classe: ${escapeHtml(item.class_code || "N/D")}</div>
        </div>
        <div class="leaderboard-average-ring">${getAverageRingMarkup(item.average, { mini: true })}</div>
      </div>`;
  }).join("");
}

function renderAverageLeaderboardEmpty(message) {
  const list = document.getElementById("averageLeaderboardList");
  const pageIndicator = document.getElementById("averagePageIndicator");
  const prevPageBtn = document.getElementById("averagePrevPageBtn");
  const nextPageBtn = document.getElementById("averageNextPageBtn");
  if (list) list.innerHTML = `<div class="leaderboard-empty">${escapeHtml(message)}</div>`;
  if (pageIndicator) pageIndicator.textContent = "Pagina 1";
  if (prevPageBtn) prevPageBtn.disabled = true;
  if (nextPageBtn) nextPageBtn.disabled = true;
}

function formatAverage(value) {
  const n = Number(value) || 0;
  return n.toFixed(2);
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

const agendaCache = new Map();

async function fetchAgendaInterval(startYYYYMMDD, endYYYYMMDD, { prefetch = false } = {}) {
  const cacheKey = `${startYYYYMMDD}-${endYYYYMMDD}`;
  if (agendaCache.has(cacheKey)) return agendaCache.get(cacheKey);

  const res = await fetch(apiUrl("/api/agenda"), {
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
  if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda)) return agendaData.agenda.agenda;
  for (const k of Object.keys(agendaData)) {
    if (Array.isArray(agendaData[k])) return agendaData[k];
  }
  return [];
}

async function logClasseFromFirstLesson({ maxWeeksToCheck = 52, startOffset = 0 } = {}) {
  for (let offset = startOffset; offset < startOffset + maxWeeksToCheck; offset++) {
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
        return firstChunk.toUpperCase();
      }
    } catch (err) {
      console.error(`Errore nel fetch agenda settimana offset ${offset}:`, err);
    }
  }

  return null;
}

async function handleAuthFail(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  console.log("Auth fail:", res.status, body);
  localStorage.removeItem("loggedIn");
  localStorage.removeItem("username");
  window.location.href = "/";
}

function openEntryModal(voto) {
  const entryModal = document.getElementById("entryModal");
  const modalTitle = document.getElementById("entryModalTitle");
  const modalTeacher = document.getElementById("entryModalTeacher");
  const modalText = document.getElementById("entryModalText");
  const modalCloseBtn = document.getElementById("entryModalClose");
  if (!entryModal) return;

  const subject = voto.subjectDesc || voto.subject || "Dettagli Voto";
  modalTitle.textContent = subject;

  const teacherToShow =
    voto.authorName ||
    voto.teacherName ||
    voto.insegnante ||
    "Docente non disponibile";
  if (modalTeacher) {
    modalTeacher.textContent = teacherToShow;
    modalTeacher.style.display = "block";
  }

  const parts = [];
  if (voto.displayValue || voto.voto || voto.grade) {
    parts.push(`Voto: ${voto.displayValue || voto.voto || voto.grade}`);
  }
  if (voto.evtDate) {
    try {
      parts.push(`Data: ${new Date(voto.evtDate).toLocaleDateString("it-IT")}`);
    } catch {}
  }
  const notes = voto.notesForFamily || voto.notes || voto.description || voto.note || "";
  if (notes) parts.push(notes);

  const fullText = parts.join("\n\n");

  if (modalText) {
    modalText.innerHTML = escapeHtml(fullText).replace(/\n/g, "<br>");
  }

  entryModal.classList.add("show");
  entryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalCloseBtn?.focus();

  function closeModal() {
    entryModal.classList.remove("show");
    entryModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = document.body.classList.contains("menu-open") ? "hidden" : "";
    modalCloseBtn?.removeEventListener("click", closeModal);
    entryModal.removeEventListener("click", onOverlayClick);
    document.removeEventListener("keydown", onKey);
  }

  function onOverlayClick(e) {
    if (e.target === entryModal) closeModal();
  }
  function onKey(e) {
    if (e.key === "Escape") closeModal();
  }

  modalCloseBtn?.addEventListener("click", closeModal);
  entryModal.addEventListener("click", onOverlayClick);
  document.addEventListener("keydown", onKey);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getColorFromVoto(voto) {
  const valore = parseFloat(voto);

  if (valore >= 6) return "green";
  if (valore >= 5.75) return "orange";
  return "red";
}

function goToHome() {
  window.location.href = "/dashboard/";
}
function goToAssenze() {
  window.location.href = "/assenze/";
}
function logout() {
  localStorage.removeItem("loggedIn");
  window.location.href = "/";
}
