let studentName;

// cache keyed by full interval
const agendaCache = new Map();
let currentWeekOffset = 0;

document.addEventListener("DOMContentLoaded", async () => {
  const loading = document.getElementById("loading-overlay");
  if (loading) loading.classList.remove("hidden");

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/index.html";
    return;
  }

  try {
    const cardData = await fetchCard();
    studentName = cardData.card.card.firstName;

    setInterval(() => {
      updateTimeAndDate();
      updateGreeting();
    }, 1000);

    const agendaData = await loadAgendaWeek(0);
    renderAgenda(agendaData);

    // fetch lezioni and voti in parallel and render them
    const [lezioniData, votiData, assenzeData] = await Promise.all([
      fetchLezioni().catch((e) => {
        console.error("lezioni fetch failed", e);
        return null;
      }),
      fetchVoti().catch((e) => {
        console.error("voti fetch failed", e);
        return null;
      }),
      fetchAssenze().catch((e) => {
        console.error("assenze fetch failed", e);
        return null;
      }),
    ]);
    if (lezioniData) renderLezioni(lezioniData);
    if (votiData) renderVoti(votiData);
    if (assenzeData) renderAssenze(assenzeData);

    // wire prev/next buttons
    const nextBtn = document.getElementById("nextWeek");
    const prevBtn = document.getElementById("prevWeek");
    const track = document.querySelector(".agenda-track");
    let slidesPerView = getSlidesPerView();
    let currentSlideIndex = 0;

    function getSlidesPerView() {
      const w = window.innerWidth;
      if (w <= 420) return 1;
      if (w <= 600) return 2;
      if (w <= 800) return 3;
      if (w <= 1000) return 4;
      return 5;
    }

    function updateSlidesLayout() {
      slidesPerView = getSlidesPerView();
      const giornoEls = Array.from(
        document.querySelectorAll(".agenda-track .giorno"),
      );
      giornoEls.forEach((el) => {
        el.style.flex = `0 0 ${100 / slidesPerView}%`;
      });

      const maxIndex = Math.max(0, giornoEls.length - slidesPerView);
      if (currentSlideIndex > maxIndex) currentSlideIndex = maxIndex;
      updateTrackPosition();
    }

    function updateTrackPosition() {
      if (!track) return;
      const shift = (currentSlideIndex * 100) / slidesPerView;
      track.style.transform = `translateX(-${shift}%)`;
      computeEqualHeights();
    }

    async function handleNext() {
      const giornoEls = document.querySelectorAll(".agenda-track .giorno");
      const maxIndex = Math.max(0, giornoEls.length - slidesPerView);

      if (slidesPerView < giornoEls.length) {
        currentSlideIndex = Math.min(maxIndex, currentSlideIndex + 1);
        updateTrackPosition();
        return;
      }

      const data = await goToNextWeek();
      renderAgenda(data);
      currentSlideIndex = 0;
      updateTrackPosition();
    }

    async function handlePrev() {
      const giornoEls = document.querySelectorAll(".agenda-track .giorno");

      if (slidesPerView < giornoEls.length) {
        currentSlideIndex = Math.max(0, currentSlideIndex - 1);
        updateTrackPosition();
        return;
      }

      const data = await goToPrevWeek();
      renderAgenda(data);
      currentSlideIndex = 0;
      updateTrackPosition();
    }

    nextBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      handleNext();
    });
    prevBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      handlePrev();
    });

    window.addEventListener("resize", updateSlidesLayout);
    // also sync media/assenze heights on resize
    window.addEventListener("resize", syncMediaToAssenze);
    updateSlidesLayout();

    // update UI once before hiding overlay
    updateTimeAndDate();
    updateGreeting();
    await new Promise((res) => requestAnimationFrame(res));

    loading?.classList.add("hidden");
  } catch (err) {
    console.error(err);
    document.getElementById("loading-overlay")?.classList.add("hidden");
  }
});

async function fetchCard() {
  const res = await fetch("http://localhost:8000/card", {
    method: "POST",
    credentials: "include",
  });

  if (!res.ok) await handleAuthFail(res);
  return await res.json();
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// Helper: compute Monday start for a given week offset (0 = current week)
function getWeekStartDate(offsetWeeks) {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 1 = Monday
  const diffToMon = (day + 6) % 7; // days since Monday
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

  const res = await fetch("http://localhost:8000/agenda", {
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

  const data = await fetchAgendaInterval(start, end);
  currentWeekOffset = offsetWeeks;

  // prefetch prev/next
  try {
    const prevStartDate = getWeekStartDate(offsetWeeks - 1);
    const prevEndDate = new Date(prevStartDate);
    prevEndDate.setDate(prevStartDate.getDate() + 6);

    const nextStartDate = getWeekStartDate(offsetWeeks + 1);
    const nextEndDate = new Date(nextStartDate);
    nextEndDate.setDate(nextStartDate.getDate() + 6);

    fetchAgendaInterval(
      formatDateYYYYMMDD(prevStartDate),
      formatDateYYYYMMDD(prevEndDate),
      { prefetch: true },
    ).catch(() => {});
    fetchAgendaInterval(
      formatDateYYYYMMDD(nextStartDate),
      formatDateYYYYMMDD(nextEndDate),
      { prefetch: true },
    ).catch(() => {});
  } catch {}

  return data;
}

// Extract events array from different possible API shapes
function extractEvents(agendaData) {
  if (!agendaData) return [];
  if (Array.isArray(agendaData)) return agendaData;
  if (Array.isArray(agendaData.agenda)) return agendaData.agenda;
  if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda))
    return agendaData.agenda.agenda;

  for (const k of Object.keys(agendaData)) {
    if (Array.isArray(agendaData[k])) return agendaData[k];
  }
  return [];
}

// Render agenda data into the DOM (fills Mon-Fri columns)
function renderAgenda(agendaData) {
  const container = document.getElementById("agenda");
  if (!container) return;

  const events = extractEvents(agendaData);
  const monday = getWeekStartDate(currentWeekOffset);
  const dayNames = [
    "Lunedi",
    "Martedi",
    "Mercoledi",
    "Giovedi",
    "Venerdi",
    "Sabato",
    "Domenica",
  ];

  const eventsByDate = {};
  events.forEach((ev) => {
    const dt = ev.evtDatetimeBegin || ev.datetime || ev.date || ev.start;
    const d = new Date(dt);
    const key = formatDateYYYYMMDD(d);
    (eventsByDate[key] ??= []).push(ev);
  });

  const giornoEls = Array.from(container.querySelectorAll(".giorno"));
  for (let i = 0; i < 5; i++) {
    const el = giornoEls[i];
    if (!el) continue;

    const d = new Date(monday);
    d.setDate(monday.getDate() + i);

    const dayLabel = dayNames[i];
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");

    el.querySelector(".giorno-name").textContent = `${dayLabel} ${dd}/${mm}`;

    Array.from(el.querySelectorAll(".entry, .entries-container")).forEach((n) =>
      n.remove(),
    );

    const entriesContainer = document.createElement("div");
    entriesContainer.className = "entries-container";

    const key = formatDateYYYYMMDD(d);
    (eventsByDate[key] || []).forEach((ev) => {
      const subject = ev.subjectDesc || ev.subject || ev.title || "Evento";
      const teacher =
        ev.authorName || ev.teacherName || ev.teacher || "Sconosciuto";
      const text = ev.notes || ev.description || ev.text || "";

      const entry = document.createElement("div");
      entry.className = "entry";
      entry.dataset.teacher = teacher;

      entry.innerHTML = `
        <span class="subject"></span>
        <span class="teacher" style="display:none"></span>
        <span class="text"></span>
      `;
      entry.querySelector(".subject").textContent = subject;
      entry.querySelector(".teacher").textContent = teacher;
      entry.querySelector(".text").textContent = text;

      entriesContainer.appendChild(entry);
    });

    el.appendChild(entriesContainer);
  }

  document
    .querySelector(".agenda-track")
    ?.style.setProperty("transform", "translateX(0)");
  setTimeout(computeEqualHeights, 50);
}

function computeEqualHeights() {
  const container = document.getElementById("agenda");
  if (!container) return;
  const giornoEls = Array.from(container.querySelectorAll(".giorno"));
  if (!giornoEls.length) return;

  giornoEls.forEach((el) => (el.style.height = ""));
  let max = 0;
  giornoEls.forEach((el) => (max = Math.max(max, el.offsetHeight)));
  if (max > 0) giornoEls.forEach((el) => (el.style.height = max + "px"));
}

// --- Sync heights: make media-generale match assenze height ---
let __syncMediaTimeout = null;
function syncMediaToAssenze() {
  clearTimeout(__syncMediaTimeout);
  __syncMediaTimeout = setTimeout(() => {
    const media = document.getElementById("media-generale");
    const assenze = document.getElementById("assenze");
    if (!media || !assenze) return;

    // compute target height from assenze (including paddings/borders as offsetHeight)
    const target = assenze.offsetHeight;
    if (target && target > 0) {
      media.style.height = target + "px";
    } else {
      // fallback: clear explicit height to allow natural sizing
      media.style.height = "";
    }
  }, 40);
}

async function goToNextWeek() {
  return await loadAgendaWeek(currentWeekOffset + 1);
}
async function goToPrevWeek() {
  return await loadAgendaWeek(currentWeekOffset - 1);
}
window.goToNextWeek = goToNextWeek;
window.goToPrevWeek = goToPrevWeek;

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Buongiorno";
  if (h < 18) return "Buon pomeriggio";
  return "Buonasera";
}

function updateGreeting() {
  const el = document.getElementById("greeting");
  if (el) el.textContent = `${getGreeting()}, ${toTitleCase(studentName)}`;
}

function updateTimeAndDate() {
  const now = new Date();
  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");

  if (timeEl) {
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    timeEl.textContent = `Ora: ${hours}:${minutes}`;
  }
  if (dateEl) {
    dateEl.textContent =
      "Data: " +
      now.toLocaleDateString("it-IT", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
  }
}

function toTitleCase(str, locale = "it") {
  return String(str || "")
    .toLocaleLowerCase(locale)
    .replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase(locale));
}

// --- Lezioni ---
async function fetchLezioni() {
  const res = await fetch("http://localhost:8000/lezioni_oggi", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch lezioni");
  }
  return await res.json();
}

function renderLezioni(data) {
  const container = document.getElementById("lezioni");
  if (!container) return;
  const track = container.querySelector(".lezioni-track");
  if (!track) return;
  track.innerHTML = "";

  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.lezioni_oggi)) arr = data.lezioni_oggi;
  else if (Array.isArray(data.lezioni)) arr = data.lezioni;

  if (
    (!arr || arr.length === 0) &&
    data?.lezioni_oggi &&
    typeof data.lezioni_oggi === "object"
  ) {
    for (const k of Object.keys(data.lezioni_oggi)) {
      if (Array.isArray(data.lezioni_oggi[k])) {
        arr = data.lezioni_oggi[k];
        break;
      }
    }
  }

  arr.forEach((l) => {
    const subject =
      l.subject || l.subjectDesc || l.materia || l.desc || "Lezione";
    const txt =
      l.notes || l.description || l.text || l.info || l.lessonArg || "";
    const teacher = l.teacher || l.authorName || l.author || "";

    const div = document.createElement("div");
    div.className = "lezione-entry entry"; // entry per aprire il modal
    div.dataset.teacher = teacher || "";
    div.title = subject + (txt ? " — " + txt : "");

    const subjEl = document.createElement("span");
    subjEl.className = "subject";
    subjEl.textContent = subject;

    const teacherEl = document.createElement("span");
    teacherEl.className = "teacher";
    teacherEl.textContent =
      teacher && String(teacher).trim() ? teacher : "Malacchini Daniela";

    const textEl = document.createElement("span");
    textEl.className = "text";
    textEl.textContent = txt || "";
    textEl.style.display = "block"; // <-- FORZA la preview nella card

    div.appendChild(subjEl);
    div.appendChild(teacherEl);
    div.appendChild(textEl);

    track.appendChild(div);
  });

  if (arr.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Nessuna lezione oggi";
    track.appendChild(note);
  }
}

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

function renderVoti(data) {
  const container = document.getElementById("voti");
  if (!container) return;
  const track = container.querySelector(".voti-track");
  if (!track) return;
  track.innerHTML = "";

  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.voti)) arr = data.voti;
  else if (Array.isArray(data.grades)) arr = data.grades;
  else
    for (const k of Object.keys(data || {}))
      if (Array.isArray(data[k])) {
        arr = data[k];
        break;
      }

  if (data?.voti && typeof data.voti === "object" && arr.length === 0) {
    for (const k of Object.keys(data.voti)) {
      if (Array.isArray(data.voti[k])) {
        arr = data.voti[k];
        break;
      }
    }
  }

  arr.sort((a, b) => {
    const dateA = a.evtDate || a.date || a.data || "";
    const dateB = b.evtDate || b.date || b.data || "";
    return dateB.localeCompare(dateA);
  });

  let media = 0;
  let primaMedia = 0;
  let secondaMedia = 0;

  let count = 0;
  let primoCount = 0;
  let secondoCount = 0;

  arr.forEach((v) => {
    const subject =
      v.subjectDesc || v.materia || v.discipline || v.name || "Materia";
    let displayVal = v.displayValue || v.grade || v.value || v.voto || null;
    let val = v.decimalValue || null;

    if (val === null) return;

    let num = null;
    if (typeof val === "string") {
      const match = val.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      if (match) num = parseFloat(match[0]);
    } else if (typeof val === "number") num = val;

    const item = document.createElement("div");
    // add `entry` class so delegated click listener opens the modal
    item.className = "voti-entry entry";

    item.innerHTML = `
      <div class="voti-subject subject"></div>
      <div class="grade-circle">${displayVal}</div>
    `;
    item.querySelector(".voti-subject").textContent = subject;
    // attach teacher if present so modal can show it
    if (v.authorName || v.teacherName)
      item.dataset.teacher = v.authorName || v.teacherName;

    if (v.notesForFamily) item.dataset.notes = v.notesForFamily;

    const gradeEl = item.querySelector(".grade-circle");
    gradeEl.classList.add(`grade-${v.color}`);

    track.appendChild(item);

    if (v.displayValue !== "A") {
      if (num !== null) {
        media += num;
        count += 1;

        if (v.periodPos == 1) {
          primaMedia += num;
          primoCount += 1;
        } else if (v.periodPos == 3) {
          secondaMedia += num;
          secondoCount += 1;
        }
      }
    }
  });

  media = count > 0 ? media / count : 0;
  primaMedia = primoCount > 0 ? primaMedia / primoCount : 0;
  secondaMedia = secondoCount > 0 ? secondaMedia / secondoCount : 0;

  renderMedia(media, primaMedia, secondaMedia);

  if (arr.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Nessun voto disponibile";
    track.appendChild(note);
  }
}

function renderMedia(media, primaMedia, secondaMedia) {
  const averageDiv = document.querySelector(".media-generale-value");
  const firstAverageDiv = document.querySelector(".media-generale-value-primo");
  const secondAverageDiv = document.querySelector(
    ".media-generale-value-secondo",
  );
  averageDiv.innerHTML = "";
  firstAverageDiv.innerHTML = "";
  secondAverageDiv.innerHTML = "";

  averageDiv.appendChild(createMediaContainer(media));
  firstAverageDiv.appendChild(createMediaContainer(primaMedia));
  secondAverageDiv.appendChild(createMediaContainer(secondaMedia));

  averageDiv.innerHTML += `<span class="label generale-label">Generale</span>`;
  firstAverageDiv.innerHTML += `<span class="label primo-periodo-label">Primo Periodo</span>`;
  secondAverageDiv.innerHTML += `<span class="label secondo-periodo-label">Secondo Periodo</span>`;

  // ensure media panel height stays in sync with assenze panel
  try {
    syncMediaToAssenze();
  } catch (e) {
    /* ignore */
  }
}

// assenze
async function fetchAssenze() {
  const res = await fetch("http://localhost:8000/assenze", {
    method: "POST",
    credentials: "include",
  });

  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch assenze");
  }
  return await res.json();
}

function renderAssenze(data) {
  const container = document.getElementById("assenze");
  if (!container) return;
  const track = container.querySelector(".assenze-track");
  if (!track) return;
  track.innerHTML = "";
  let arr = [];
  arr =
    data && data.assenze && Array.isArray(data.assenze.events)
      ? data.assenze.events
      : Array.isArray(data)
        ? data
        : [];

  arr.reverse();
  console.log(arr);

  arr.forEach((a) => {
    const date = a.evtDate || a.date || a.data || "Data sconosciuta";
    const reason =
      a.justifReasonDesc ||
      a.motivo ||
      a.note ||
      a.reason ||
      "Motivo sconosciuto";

    // determine badge text and color
    const code = a.evtCode || a.tipo || "";
    let badgeText = "?";
    let gradeClass = "grade-red";

    switch (code) {
      case "ABU0":
        badgeText = "U"; // Uscita
        gradeClass = "grade-orange";
        break;
      case "ABA0":
        badgeText = "A"; // Assenza
        gradeClass = "grade-red";
        break;
      case "ABR0":
      case "ABR1":
        badgeText = "R"; // Ritardo
        gradeClass = "grade-yellow";
        break;
      default:
        // try to infer from other fields
        if ((a.justifType || "").toLowerCase().includes("usc")) {
          badgeText = "U";
          gradeClass = "grade-orange";
        } else if ((a.justifType || "").toLowerCase().includes("rit")) {
          badgeText = "R";
          gradeClass = "grade-yellow";
        } else if ((a.justifType || "").toLowerCase().includes("ass")) {
          badgeText = "A";
          gradeClass = "grade-red";
        }
        break;
    }

    const item = document.createElement("div");
    // do NOT add the generic `entry` class so clicking doesn't open modal
    item.className = "assenze-entry";

    // determine if the absence is explicitly marked as justified
    const justVal = a.isJustified ?? a.justified ?? a.giustificato ?? a.giust;
    let isExplicitlyUnjustified = false;
    if (justVal === false || String(justVal).toLowerCase() === "false") {
      isExplicitlyUnjustified = true;
    }

    // optional warning triangle (SVG) shown when explicitly not justified
    const warningHtml = isExplicitlyUnjustified
      ? `<span class="assenza-warning" title="Non giustificato" aria-label="Non giustificato">
           <svg viewBox="0 0 24 24" width="18" height="18" role="img" aria-hidden="false"><title>Non giustificato</title><path fill="currentColor" d="M1 21h22L12 2 1 21z"/></svg>
         </span>`
      : "";

    item.innerHTML = `
      <div class="assenza-subject">
        <div class="assenza-date date">${date}</div>
        <div class="assenza-reason reason">${reason}</div>
      </div>
      <div class="assenza-badge">
        ${warningHtml}
        <div class="grade-circle">${badgeText}</div>
      </div>
    `;

    const badge = item.querySelector(".grade-circle");
    if (badge) badge.classList.add(gradeClass.replace(/^grade-/, "grade-"));

    track.appendChild(item);
  });

  if (arr.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Nessuna assenza registrata";
    track.appendChild(note);
  }

  // sync heights (do after DOM changes)
  try {
    syncMediaToAssenze();
  } catch (e) {}
}

function createMediaContainer(media) {
  // clamp 0..10 and keep as number
  const value = Math.max(0, Math.min(10, parseFloat(media) || 0));
  const percent = (value / 10) * 100;

  let ringColor = "#f43f5e"; // red
  if (value >= 6)
    ringColor = "#22c55e"; // green
  else if (value >= 5.75) ringColor = "#facc15"; // yellow

  const container = document.createElement("div");
  container.classList.add("media-generale-container");
  container.style.setProperty("--p", `${percent}%`);
  container.style.setProperty("--ring-color", ringColor);

  const label = document.createElement("span");
  label.classList.add("actual-media-generale-value");
  // show up to two decimals but do not round: truncate instead
  const truncatedVal = Math.trunc(value * 100) / 100;
  // remove trailing .00 if integer, or show up to 2 decimals
  label.textContent = Number.isInteger(truncatedVal)
    ? String(truncatedVal)
    : String(truncatedVal);

  container.appendChild(label);
  return container;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("#openVotiPage");
  if (btn) window.location.href = "/voti.html";
});

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

// --- Entry modal handling ---
const entryModal = document.getElementById("entryModal");
const modalTitle = document.getElementById("entryModalTitle");
const modalTeacher = document.getElementById("entryModalTeacher");
const modalText = document.getElementById("entryModalText");
const modalCloseBtn = document.getElementById("entryModalClose");

function openEntryModal(subject, text, teacher) {
  if (!entryModal) return;

  modalTitle.textContent = subject || "Dettagli";

  const teacherToShow =
    teacher && String(teacher).trim()
      ? String(teacher).trim()
      : "Malacchini Daniela";
  modalTeacher.textContent = teacherToShow;
  modalTeacher.style.display = "block";

  let fullText = String(text || "")
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean)
    .join("\n");

  const escapeHTML = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  modalText.innerHTML = escapeHTML(fullText).replace(/\n/g, "<br>");

  entryModal.classList.add("show");
  entryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalCloseBtn?.focus();
}

function closeEntryModal() {
  if (!entryModal) return;
  entryModal.classList.remove("show");
  entryModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.addEventListener("click", (ev) => {
  const entry = ev.target.closest?.(".entry");
  if (!entry || entry.closest(".modal")) return;

  const subject = entry.querySelector(".subject")?.textContent.trim() || "";
  const text = entry.dataset.notes || "";
  const teacher =
    entry.querySelector(".teacher")?.textContent.trim() ||
    entry.dataset.teacher ||
    "";

  openEntryModal(subject, text, teacher);
});

modalCloseBtn?.addEventListener("click", closeEntryModal);
entryModal?.addEventListener("click", (e) => {
  if (e.target === entryModal) closeEntryModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEntryModal();
});

// --- Navigation buttons ---
function goToVoti() {
  window.location.href = "/voti.html";
}

function goToAssenze() {
  window.location.href = "/assenze.html";
}

function logout() {
  localStorage.removeItem("loggedIn");
  window.location.href = "/index.html";
}
