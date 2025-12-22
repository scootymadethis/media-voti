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
  const votiDiv = document.querySelector(".actual-voti");
  const averageDiv = document.querySelector(".average");

  materieDiv.innerHTML = "";
  votiDiv.innerHTML = "";
  averageDiv.innerHTML = "";

  materie.forEach((materia) => {
    let materiaDiv = document.createElement("div");
    materiaDiv.classList.add("materia");
    materiaDiv.innerHTML = `<span class="materia-text">${materia}</span>`;
    materiaDiv.onclick = () => {
      votiDiv.innerHTML = "";

      voti.forEach((voto) => {
        if (voto.subjectDesc !== materia) return;
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
      });
    };
    materieDiv.appendChild(materiaDiv);
  });
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
