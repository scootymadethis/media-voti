document.addEventListener("DOMContentLoaded", async () => {
  const loading = document.getElementById("loading-overlay");
  if (loading) loading.classList.remove("hidden");

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/index.html";
    return;
  }

  const votiDiv = document.querySelector(".actual-voti");
  votiDiv.innerHTML = "";

  try {
    let materie = [];
    const votiData = await fetchVoti();

    if (votiData) console.log(votiData.voti.grades);

    const voti = votiData.voti.grades;
    voti.forEach((voto) => {
      if (!materie.includes(voto.subjectDesc)) {
        materie.push(voto.subjectDesc);
      }
    });

    voti.sort((a, b) => new Date(b.evtDate) - new Date(a.evtDate));
    materie.sort();

    if (materie != null && voti != null) renderVoti(materie, voti);

    loading?.classList.add("hidden");
  } catch (err) {
    console.error(err);
    document.getElementById("loading-overlay")?.classList.add("hidden");
  }
});

// --- Voti ---
async function fetchVoti() {
  const res = await fetch("http://localhost:8000/voti", {
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
  const materieDiv = document.querySelector(".voti-materie");
  const periodDiv = document.querySelector(".voti-periodo");
  const votiDiv = document.querySelector(".actual-voti");
  const averageDiv = document.querySelector(".average");

  materieDiv.innerHTML = "";
  periodDiv.innerHTML = "";
  votiDiv.innerHTML = "";
  averageDiv.innerHTML = "";

  materie.forEach((materia) => {
    let materiaDiv = document.createElement("div");
    materiaDiv.classList.add("materia");
    materiaDiv.innerHTML = `<span class="materia-text">${materia}</span>`;
    materiaDiv.onclick = () => {
      periodDiv.innerHTML = "";
      votiDiv.innerHTML = "";

      let votiPrimoPeriodo = [];
      let votiSecondoPeriodo = [];

      const selected = document.querySelector(".materia.selected");
      if (selected) selected.classList.remove("selected");
      materiaDiv.classList.add("selected");

      voti.forEach((voto) => {
        if (voto.subjectDesc !== materia) return;

        if (voto.periodPos == 1) votiPrimoPeriodo.push(voto);
        if (voto.periodPos == 3) votiSecondoPeriodo.push(voto);
      });

      if (votiPrimoPeriodo.length > 0) {
        // render first voti
        votiDiv.innerHTML = "";
        renderActualVoti(votiPrimoPeriodo);

        const periodo1Div = document.createElement("div");
        periodo1Div.classList.add("periodo");
        periodo1Div.classList.add("selected");
        periodo1Div.innerHTML = `<span class="periodo-text">Trimestre</span>`;
        periodo1Div.onclick = () => {
          votiDiv.innerHTML = "";
          const selected = document.querySelector(".periodo.selected");
          if (selected) selected.classList.remove("selected");
          periodo1Div.classList.add("selected");
          renderActualVoti(votiPrimoPeriodo);
        };
        periodDiv.appendChild(periodo1Div);
      }
      if (votiSecondoPeriodo.length > 0) {
        // render second voti
        const periodo2Div = document.createElement("div");
        periodo2Div.classList.add("periodo");
        periodo2Div.innerHTML = `<span class="periodo-text">Pentamestre</span>`;
        periodo2Div.onclick = () => {
          votiDiv.innerHTML = "";
          const selected = document.querySelector(".periodo.selected");
          if (selected) selected.classList.remove("selected");
          periodo2Div.classList.add("selected");
          renderActualVoti(votiSecondoPeriodo);
        };
        periodDiv.appendChild(periodo2Div);
      }
    };
    materieDiv.appendChild(materiaDiv);
  });
}

function renderActualVoti(voti) {
  const votiDiv = document.querySelector(".actual-voti");
  votiDiv.innerHTML = "";

  let media = 0;
  let votiLength = voti.length;

  voti.forEach((voto) => {
    if(voto.displayValue == "A") votiLength -= 1;

    let votoDiv = document.createElement("div");
    votoDiv.classList.add("voto");
    votoDiv.innerHTML = `
    <div class="voto-score grade-${voto.color}">${voto.displayValue}</div>
    <div class="voto-desc">${voto.notesForFamily}</div>
    <div class="voto-date">${new Date(voto.evtDate).toLocaleDateString(
      "it-IT"
    )}</div>
    `;
    votoDiv.onclick = () => {
      openEntryModal(voto);
    };
    votiDiv.appendChild(votoDiv);
    media += parseFloat(voto.decimalValue) || 0;
  });

  media = media / votiLength;
  renderMedia(media.toFixed(2));
}

function renderMedia(media) {
  const averageDiv = document.querySelector(".average");
  averageDiv.innerHTML = "";

  const value = Math.max(0, Math.min(10, parseFloat(media) || 0)); // clamp 0..10
  const percent = (value / 10) * 100;

  let ringColor = "#f43f5e"; // red
  if (value > 6)
    ringColor = "#22c55e"; // green
  else if (value >= 5.75)
    ringColor = "#facc15"; // yellow

  const container = document.createElement("div");
  container.classList.add("average-score-container");
  container.style.setProperty("--p", `${percent}%`);
  container.style.setProperty("--ring-color", ringColor);

  const label = document.createElement("span");
  label.classList.add("average-score");
  label.textContent = value.toFixed(2);

  container.appendChild(label);
  averageDiv.appendChild(container);
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
    "Malacchini Daniela";
  if (modalTeacher) {
    modalTeacher.textContent = teacherToShow;
    modalTeacher.style.display = "block";
  }

  // Build a compact textual description for the vote adapted to the dashboard modal
  const parts = [];
  if (voto.displayValue || voto.voto || voto.grade) {
    parts.push(`Voto: ${voto.displayValue || voto.voto || voto.grade}`);
  }
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

  // show modal (dashboard uses .modal.show)
  entryModal.classList.add("show");
  entryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalCloseBtn?.focus();

  // close function that also removes attached handlers
  function closeModal() {
    entryModal.classList.remove("show");
    entryModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
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
