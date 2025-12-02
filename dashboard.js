let studentName;

// cache keyed by full interval
const agendaCache = new Map();
let currentWeekOffset = 0;

document.addEventListener("DOMContentLoaded", async () => {
  // show loading overlay while we fetch initial data
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
    // render the agenda into the DOM
    renderAgenda(agendaData);

    // fetch lezioni and voti in parallel and render them
    try {
      const [lezioniData, votiData] = await Promise.all([
        fetchLezioni().catch((e) => {
          console.error("lezioni fetch failed", e);
          return null;
        }),
        fetchVoti().catch((e) => {
          console.error("voti fetch failed", e);
          return null;
        }),
      ]);
      if (lezioniData) renderLezioni(lezioniData);
      if (votiData) renderVoti(votiData);
    } catch (e) {
      console.error(e);
    }

    // wire prev/next buttons to navigate weeks and re-render
    const nextBtn = document.getElementById("nextWeek");
    const prevBtn = document.getElementById("prevWeek");
    const track = document.querySelector(".agenda-track");
    let slidesPerView = getSlidesPerView();
    let currentSlideIndex = 0; // 0..(numDays - slidesPerView)

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
        document.querySelectorAll(".agenda-track .giorno")
      );
      giornoEls.forEach((el) => {
        if (el.style) el.style.flex = `0 0 ${100 / slidesPerView}%`;
      });
      // clamp current slide
      const maxIndex = Math.max(
        0,
        Math.max(0, giornoEls.length - slidesPerView)
      );
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
        // slide within the week
        currentSlideIndex = Math.min(maxIndex, currentSlideIndex + 1);
        updateTrackPosition();
        return;
      }
      // otherwise move to next week
      const data = await goToNextWeek();
      renderAgenda(data);
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
    }

    if (nextBtn)
      nextBtn.addEventListener("click", (e) => {
        e.preventDefault();
        handleNext();
      });
    if (prevBtn)
      prevBtn.addEventListener("click", (e) => {
        e.preventDefault();
        handlePrev();
      });
    // respond to resizes
    window.addEventListener("resize", () => {
      updateSlidesLayout();
    });
    // initial layout
    updateSlidesLayout();

    // ensure time/date/greeting are updated once before hiding overlay
    try {
      updateTimeAndDate();
      updateGreeting();
      // wait for next paint to ensure UI shows the updated text
      await new Promise((res) => requestAnimationFrame(() => res()));
    } catch (e) {
      // ignore errors from UI update
    }

    // hide loading overlay now that initial data and UI updates are rendered
    if (loading) loading.classList.add("hidden");
  } catch (err) {
    console.error(err);
    // ensure loading is hidden on error so user can see message or be redirected
    const loading = document.getElementById("loading-overlay");
    if (loading) loading.classList.add("hidden");
  }
});

async function fetchCard() {
  const res = await fetch("http://localhost:8000/card", {
    method: "POST",
    credentials: "include",
  });

  if (!res.ok) {
    await handleAuthFail(res);
  }
  return await res.json();
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function startDateForWeekOffset(offsetWeeks) {
  const start = new Date();
  start.setDate(start.getDate() + offsetWeeks * 7);
  return start;
}

function endDateForWeekOffset(offsetWeeks) {
  const end = startDateForWeekOffset(offsetWeeks);
  end.setDate(end.getDate() + 6);
  return end;
}

async function fetchAgendaInterval(
  startYYYYMMDD,
  endYYYYMMDD,
  { prefetch = false } = {}
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
  // use week-aligned start (Monday) so rendering dates match fetched range
  const startDate = getWeekStartDate(offsetWeeks);
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);
  const start = formatDateYYYYMMDD(startDate);
  const end = formatDateYYYYMMDD(endDate);

  const data = await fetchAgendaInterval(start, end);
  currentWeekOffset = offsetWeeks;

  // prefetch previous and next week without forcing logout so switching is smooth
  try {
    const prevStartDate = getWeekStartDate(offsetWeeks - 1);
    const prevEndDate = new Date(prevStartDate);
    prevEndDate.setDate(prevStartDate.getDate() + 6);
    const prevStart = formatDateYYYYMMDD(prevStartDate);
    const prevEnd = formatDateYYYYMMDD(prevEndDate);

    const nextStartDate = getWeekStartDate(offsetWeeks + 1);
    const nextEndDate = new Date(nextStartDate);
    nextEndDate.setDate(nextStartDate.getDate() + 6);
    const nextStart = formatDateYYYYMMDD(nextStartDate);
    const nextEnd = formatDateYYYYMMDD(nextEndDate);

    fetchAgendaInterval(prevStart, prevEnd, { prefetch: true }).catch(() => {});
    fetchAgendaInterval(nextStart, nextEnd, { prefetch: true }).catch(() => {});
  } catch (e) {
    // ignore prefetch errors
  }

  return data;
}

// Helper: compute Monday start for a given week offset (0 = current week)
function getWeekStartDate(offsetWeeks) {
  const now = new Date();
  // compute Monday of current week
  const day = now.getDay(); // 0 = Sunday, 1 = Monday
  const diffToMon = (day + 6) % 7; // days since Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMon + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Extract events array from different possible API shapes
function extractEvents(agendaData) {
  if (!agendaData) return [];
  if (Array.isArray(agendaData)) return agendaData;
  if (Array.isArray(agendaData.agenda)) return agendaData.agenda;
  if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda))
    return agendaData.agenda.agenda;
  // fallback: try to find any array field
  for (const k of Object.keys(agendaData)) {
    if (Array.isArray(agendaData[k])) return agendaData[k];
  }
  return [];
}

// Render agenda data into the DOM (fills Mon-Fri columns)
function renderAgenda(agendaData) {
  const container = document.getElementById("agenda");
  if (!container) return;
  const events = extractEvents(agendaData) || [];
  // compute week start (Monday) using currentWeekOffset
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

  // prepare a map dateYYYYMMDD => [events]
  const eventsByDate = {};
  events.forEach((ev) => {
    const dt = ev.evtDatetimeBegin || ev.datetime || ev.date || ev.start;
    if (!dt) return;
    const d = new Date(dt);
    const key = formatDateYYYYMMDD(d);
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(ev);
  });

  // find .giorno elements (assumed 5 for Mon-Fri)
  const giornoEls = Array.from(container.querySelectorAll(".giorno"));
  for (let i = 0; i < 5; i++) {
    const el = giornoEls[i];
    if (!el) continue;
    // compute date for this column
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dayLabel = dayNames[i] || dayNames[0];
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const formatted = `${dayLabel} ${dd}/${mm}`;
    const nameEl = el.querySelector(".giorno-name");
    if (nameEl) nameEl.textContent = formatted;

    // clear existing entries (remove everything except giorno-name)
    Array.from(el.querySelectorAll(".entry, .entries-container")).forEach((n) =>
      n.remove()
    );

    // create container for entries
    const entriesContainer = document.createElement("div");
    entriesContainer.className = "entries-container";

    // populate events for this date
    const key = formatDateYYYYMMDD(d);
    const todays = eventsByDate[key] || [];
    todays.forEach((ev) => {
      const subject = ev.subjectDesc || ev.subject || ev.title || "Evento";
      const teacher =
        ev.authorName || ev.teacherName || ev.teacher || "Sconosciuto";
      const text = ev.notes || ev.description || ev.text || "";

      const entry = document.createElement("div");
      entry.className = "entry";
      entry.dataset.teacher = teacher;

      const subj = document.createElement("span");
      subj.className = "subject";
      subj.textContent = subject;

      const teach = document.createElement("span");
      teach.className = "teacher";
      teach.textContent = teacher;
      teach.style.display = "none";

      const txt = document.createElement("span");
      txt.className = "text";
      txt.textContent = text;

      entry.appendChild(subj);
      entry.appendChild(teach);
      entry.appendChild(txt);
      entriesContainer.appendChild(entry);
    });

    el.appendChild(entriesContainer);
  }

  // equalize heights after rendering
  // reset track position (in case we were viewing a slide) and equalize heights
  const track = document.querySelector(".agenda-track");
  if (track) track.style.transform = "translateX(0)";
  setTimeout(() => computeEqualHeights(), 50);
}

// Make all .giorno columns equal to tallest height
function computeEqualHeights() {
  const container = document.getElementById("agenda");
  if (!container) return;
  const giornoEls = Array.from(container.querySelectorAll(".giorno"));
  if (!giornoEls.length) return;
  // reset heights
  giornoEls.forEach((el) => (el.style.height = ""));
  let max = 0;
  giornoEls.forEach((el) => {
    const h = el.offsetHeight;
    if (h > max) max = h;
  });
  if (max > 0) giornoEls.forEach((el) => (el.style.height = max + "px"));
}

// attach resize listener to recompute heights
window.addEventListener("resize", () => {
  computeEqualHeights();
});

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
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    dateEl.textContent = "Data: " + now.toLocaleDateString("it-IT", options);
  }
}

function toTitleCase(str, locale = "it") {
  return str
    .toLocaleLowerCase(locale)
    .replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase(locale));
}

// --- Lezioni ---
async function fetchLezioni() {
  const res = await fetch("http://localhost:8000/lezioni_oggi", {
    method: "POST",
    credentials: "include",
  });
  console.debug("fetchLezioni: status", res.status);
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch lezioni");
  }
  const json = await res.json();
  console.debug("fetchLezioni: body", json);
  return json;
}

function renderLezioni(data) {
  const container = document.getElementById("lezioni");
  if (!container) return;
  const track = container.querySelector(".lezioni-track");
  if (!track) return;
  track.innerHTML = "";

  console.debug("renderLezioni: received", data);

  // try to extract array from many possible shapes
  let arr = [];
  if (!data) arr = [];
  else if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.lezioni_oggi)) arr = data.lezioni_oggi;
  else if (Array.isArray(data.lezioni)) arr = data.lezioni;
  else {
    for (const k of Object.keys(data || {}))
      if (Array.isArray(data[k])) {
        arr = data[k];
        break;
      }
  }

  // handle nested shapes: { lezioni_oggi: { lessons: [...] } }
  if (
    (!arr || arr.length === 0) &&
    data &&
    data.lezioni_oggi &&
    typeof data.lezioni_oggi === "object"
  ) {
    for (const k of Object.keys(data.lezioni_oggi)) {
      if (Array.isArray(data.lezioni_oggi[k])) {
        arr = data.lezioni_oggi[k];
        break;
      }
    }
  }

  // create truncated clickable entries; reuse .entry modal behavior by adding class `entry`
  arr.forEach((l) => {
    const subject =
      l.subject || l.subjectDesc || l.materia || l.desc || "Lezione";
    const txt = l.notes || l.description || l.text || l.info || "";
    const teacher = l.teacher || l.authorName || l.author || "";

    const div = document.createElement("div");
    div.className = "lezione-entry entry"; // `entry` so modal opens
    div.dataset.teacher = teacher || "";
    div.title = subject + (txt ? " — " + txt : "");
    div.textContent = `${subject} ${txt ? "— " + txt : ""}`;
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
  console.debug("fetchVoti: status", res.status);
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch voti");
  }
  const json = await res.json();
  console.debug("fetchVoti: body", json);
  return json;
}

function renderVoti(data) {
  const container = document.getElementById("voti");
  if (!container) return;
  const track = container.querySelector(".voti-track");
  if (!track) return;
  track.innerHTML = "";
  console.debug("renderVoti: received", data);

  // extract votes array from multiple shapes
  let arr = [];
  if (!data) arr = [];
  else if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.voti)) arr = data.voti;
  else if (Array.isArray(data.grades)) arr = data.grades;
  else
    for (const k of Object.keys(data || {}))
      if (Array.isArray(data[k])) {
        arr = data[k];
        break;
      }

  // handle nested shapes: { voti: { grades: [...] } } or { voti: { data: [...] } }
  if (
    (!arr || arr.length === 0) &&
    data &&
    data.voti &&
    typeof data.voti === "object"
  ) {
    for (const k of Object.keys(data.voti)) {
      if (Array.isArray(data.voti[k])) {
        arr = data.voti[k];
        break;
      }
    }
  }

  // sort by date or keep order; assume server returns most recent first
  arr.forEach((v) => {
    const subject =
      v.subject || v.materia || v.discipline || v.name || "Materia";
    let val = v.vote || v.grade || v.value || v.voto || null;
    // normalize numeric
    let num = null;
    if (typeof val === "string") {
      const match = val.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      if (match) num = parseFloat(match[0]);
    } else if (typeof val === "number") num = val;

    const item = document.createElement("div");
    item.className = "voti-entry";

    const subj = document.createElement("div");
    subj.className = "voti-subject";
    subj.textContent = subject;

    const gradeWrap = document.createElement("div");
    const grade = document.createElement("div");
    grade.className = "grade-circle";
    const display =
      num === null
        ? val !== null
          ? String(val)
          : "?"
        : Number.isInteger(num)
        ? String(num)
        : String(num.toFixed(1)).replace(".0", "");
    grade.textContent = display;
    if (num !== null) {
      if (num >= 6) grade.classList.add("grade-green");
      else if (num >= 5) grade.classList.add("grade-yellow");
      else grade.classList.add("grade-red");
    } else {
      grade.classList.add("grade-yellow");
    }
    gradeWrap.appendChild(grade);

    item.appendChild(subj);
    item.appendChild(gradeWrap);
    track.appendChild(item);
  });

  if (arr.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Nessun voto disponibile";
    track.appendChild(note);
  }
}

// wire voti page button
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest("#openVotiPage");
  if (btn) {
    window.location.href = "/voti.html";
  }
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

// --- Entry modal handling: clicking an `.entry` opens a modal with full text ---
const entryModal = document.getElementById("entryModal");
const modalTitle = document.getElementById("entryModalTitle");
const modalSubject = document.getElementById("entryModalSubject");
const modalTeacher = document.getElementById("entryModalTeacher");
const modalText = document.getElementById("entryModalText");
const modalCloseBtn = document.getElementById("entryModalClose");

function openEntryModal(subject, text, teacher) {
  if (!entryModal) return;
  // show subject only in the title (avoid duplicate subject lines)
  modalTitle.textContent = subject || "Dettagli";
  if (modalSubject) {
    modalSubject.textContent = "";
    modalSubject.style.display = "none";
  }
  // show teacher (default to 'Malacchini Daniela' if not provided)
  const teacherToShow =
    teacher && String(teacher).trim()
      ? String(teacher).trim()
      : "Malacchini Daniela";
  if (modalTeacher) {
    modalTeacher.textContent = teacherToShow;
    modalTeacher.style.display = "block";
  }
  // normalize text: split lines, trim each, remove empty lines and preserve line breaks
  let fullText = text || "";
  try {
    fullText = String(fullText)
      .split(/\r?\n/)
      .map((ln) => ln.trim())
      .filter((ln) => ln.length > 0)
      .join("\n");
  } catch (e) {
    fullText = String(fullText).trim();
  }
  // Render preserved new lines in HTML while escaping to avoid XSS
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  if (modalText) {
    modalText.innerHTML = escapeHTML(fullText).replace(/\n/g, "<br>");
  }
  entryModal.classList.add("show");
  entryModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  if (modalCloseBtn) modalCloseBtn.focus();
}

function closeEntryModal() {
  if (!entryModal) return;
  entryModal.classList.remove("show");
  entryModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// Delegated click listener for any .entry element
document.addEventListener("click", (ev) => {
  const entry = ev.target.closest && ev.target.closest(".entry");
  if (!entry) return;
  // Avoid opening modal when clicking inside the modal itself
  if (entry.closest(".modal")) return;

  const subjEl = entry.querySelector(".subject");
  const textEl = entry.querySelector(".text");
  const teacherEl = entry.querySelector(".teacher");
  const subject = subjEl ? subjEl.textContent.trim() : "";
  // prefer innerText to get rendered text and collapse odd HTML whitespace
  let text = "";
  if (textEl) text = (textEl.innerText || textEl.textContent || "").trim();
  else text = (entry.innerText || entry.textContent || "").trim();
  let teacher = "";
  if (teacherEl) teacher = teacherEl.textContent.trim();
  else if (entry.dataset && entry.dataset.teacher)
    teacher = entry.dataset.teacher;
  openEntryModal(subject, text, teacher);
});

// Close handlers
if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeEntryModal);
if (entryModal) {
  entryModal.addEventListener("click", (e) => {
    if (e.target === entryModal) closeEntryModal();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEntryModal();
});
