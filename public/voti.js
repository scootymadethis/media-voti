// VARIABILI GLOBALI
let selectedPeriod = "";
const calcolatorBtn = document.getElementById("calculate-grade");

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();

  const loading = document.getElementById("loading-overlay");
  if (loading) loading.classList.remove("hidden");

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/index.html";
    return;
  }

  const votiDiv = document.querySelector(".actual-voti");
  const materiaSelect = document.getElementById("materiaSelect");
  votiDiv.innerHTML = "";

  try {
    let materie = [];
    const votiData = await fetchVoti();
    const voti = votiData.voti.grades || [];

    voti.forEach((voto) => {
      if (!materie.includes(voto.subjectDesc)) materie.push(voto.subjectDesc);
    });

    voti.sort((a, b) => new Date(b.evtDate) - new Date(a.evtDate));
    materie.sort();

    if (materie.length && voti.length) {
      renderVoti(materie, voti);
      if (materiaSelect) materiaSelect.value = materie[0];
      handleMateriaChange(materie[0], voti);
    } else {
      votiDiv.innerHTML =
        '<div class="empty-voti">Nessun voto disponibile al momento.</div>';
      renderMedia(0, "Nessun periodo");
    }

    loading?.classList.add("hidden");

    if (calcolatorBtn) {
      calcolatorBtn.onclick = () => {
        const votiContainer = document.querySelector(".actual-voti");
        const currentVoti = votiContainer?.childElementCount;
        const averageScore = document.querySelector(".average-score");
        const mediaAttuale = parseFloat(averageScore?.textContent || "0");
        calculateNeededGrades(mediaAttuale, currentVoti);
      };
    }
  } catch (err) {
    console.error(err);
    document.getElementById("loading-overlay")?.classList.add("hidden");
  }
});

async function fetchVoti() {
  const res = await fetch("/api/voti", {
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
  if (!periodDiv || !votiDiv) return;

  periodDiv.innerHTML = "";
  votiDiv.innerHTML = "";

  if (!materia) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Seleziona una materia per vedere i voti.</div>';
    renderMedia(0, "Nessun periodo");
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
    votiDiv.innerHTML = "";
    selectedPeriod = label;
    document.querySelector(".periodo.selected")?.classList.remove("selected");
    node.classList.add("selected");
    renderActualVoti(items, label, materia);
  };

  if (votiPrimoPeriodo.length > 0) {
    const periodo1Div = document.createElement("button");
    periodo1Div.type = "button";
    periodo1Div.innerHTML = '<span class="periodo-text">Trimestre</span>';
    periodo1Div.classList.add("periodo", "trimestre", "selected");
    periodo1Div.onclick = () =>
      choosePeriod("Trimestre", votiPrimoPeriodo, periodo1Div);
    periodDiv.appendChild(periodo1Div);
  }

  if (votiSecondoPeriodo.length > 0) {
    const periodo2Div = document.createElement("button");
    periodo2Div.type = "button";
    periodo2Div.innerHTML = '<span class="periodo-text">Pentamestre</span>';
    periodo2Div.classList.add("periodo", "pentamestre");
    periodo2Div.onclick = () =>
      choosePeriod("Pentamestre", votiSecondoPeriodo, periodo2Div);
    periodDiv.appendChild(periodo2Div);
  }

  if (selectedPeriod == "") {
    if (votiPrimoPeriodo.length > 0) {
      renderActualVoti(votiPrimoPeriodo, "Trimestre", materia);
    } else if (votiSecondoPeriodo.length > 0) {
      periodDiv.firstElementChild?.classList.add("selected");
      renderActualVoti(votiSecondoPeriodo, "Pentamestre", materia);
    }
  } else {
    if (selectedPeriod === "Trimestre") {
      const periodo1Div = periodDiv.querySelector(".trimestre");
      choosePeriod("Trimestre", votiPrimoPeriodo, periodo1Div);
    } else if (selectedPeriod === "Pentamestre") {
      const periodo2Div = periodDiv.querySelector(".pentamestre");
      choosePeriod("Pentamestre", votiSecondoPeriodo, periodo2Div);
    }
  }

  if (votiPrimoPeriodo.length === 0 && votiSecondoPeriodo.length === 0) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Nessun voto disponibile per questa materia.</div>';
    renderMedia(0, `${materia} • Nessun periodo`);
  }
}

function renderActualVoti(voti, periodoLabel = "Periodo", materia = "") {
  const votiDiv = document.querySelector(".actual-voti");
  votiDiv.innerHTML = "";

  let media = 0;
  let votiLength = voti.length;

  voti.forEach((voto) => {
    if (voto.color == "blue") votiLength -= 1;

    const votoDiv = document.createElement("div");
    votoDiv.classList.add("voto");
    votoDiv.innerHTML = `
      <div class="voto-score grade-${voto.color}">${voto.displayValue}</div>
      <div class="voto-meta">
        <div class="voto-desc">${voto.notesForFamily || "Valutazione registrata"}</div>
      </div>
      <div class="voto-date">${new Date(voto.evtDate).toLocaleDateString("it-IT")}</div>
    `;
    votoDiv.onclick = () => openEntryModal(voto);
    votiDiv.appendChild(votoDiv);

    if (voto.color != "blue") {
      media += parseFloat(voto.decimalValue) || 0;
    }
  });

  if (!voti.length) {
    votiDiv.innerHTML =
      '<div class="empty-voti">Nessun voto disponibile per questa selezione.</div>';
  }

  media = votiLength > 0 ? media / votiLength : 0;
  renderMedia(media.toFixed(2), `${materia || "Materia"} • ${periodoLabel}`);
}

function renderMedia(media, label = "Media attuale") {
  const averageDiv = document.querySelector(".average");
  averageDiv.innerHTML = '<span class="average-label">Media</span>';

  const value = Math.max(0, Math.min(10, parseFloat(media) || 0));
  const percent = (value / 10) * 100;

  let ringColor = "#f43f5e";
  if (value > 6) ringColor = "#22c55e";
  else if (value >= 5.75) ringColor = "#facc15";

  const container = document.createElement("div");
  container.classList.add("average-score-container");
  container.style.setProperty("--p", `${percent}%`);
  container.style.setProperty("--ring-color", ringColor);

  const labelNode = document.createElement("span");
  labelNode.classList.add("average-score");
  labelNode.textContent = value.toFixed(2);

  container.appendChild(labelNode);
  averageDiv.appendChild(container);
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
    if (roundedGrade > 6) color = "#22c55e";
    else if (roundedGrade >= 5.75) color = "#facc15";

    votoDiv.style.backgroundColor = color;
    votoDiv.textContent = formattedGrade;
    gradesRow.appendChild(votoDiv);
  }

  resultP.appendChild(gradesRow);
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
  window.location.href = "/index.html";
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
  if (voto.displayValue || voto.voto || voto.grade)
    parts.push(`Voto: ${voto.displayValue || voto.voto || voto.grade}`);
  if (voto.evtDate) {
    try {
      parts.push(`Data: ${new Date(voto.evtDate).toLocaleDateString("it-IT")}`);
    } catch {}
  }
  const notes =
    voto.notesForFamily || voto.notes || voto.description || voto.note || "";
  if (notes) parts.push(notes);

  let fullText = parts.join("\n\n");

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]|'/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  if (modalText)
    modalText.innerHTML = escapeHTML(fullText).replace(/\n/g, "<br>");

  entryModal.classList.add("show");
  entryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalCloseBtn?.focus();

  function closeModal() {
    entryModal.classList.remove("show");
    entryModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = document.body.classList.contains("menu-open")
      ? "hidden"
      : "";
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

function goToHome() {
  window.location.href = "/dashboard.html";
}
function goToAssenze() {
  window.location.href = "/assenze.html";
}
function logout() {
  localStorage.removeItem("loggedIn");
  window.location.href = "/index.html";
}
