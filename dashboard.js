let studentName;

// cache keyed by full interval
const agendaCache = new Map();
let currentWeekOffset = 0;

document.addEventListener("DOMContentLoaded", async () => {
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
    console.log("Agenda:", agendaData.agenda);
  } catch (err) {
    console.error(err);
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
  const start = formatDateYYYYMMDD(startDateForWeekOffset(offsetWeeks));
  const end = formatDateYYYYMMDD(endDateForWeekOffset(offsetWeeks));

  const data = await fetchAgendaInterval(start, end);
  currentWeekOffset = offsetWeeks;

  // prefetch next week without forcing logout
  const nextStart = formatDateYYYYMMDD(startDateForWeekOffset(offsetWeeks + 1));
  const nextEnd = formatDateYYYYMMDD(endDateForWeekOffset(offsetWeeks + 1));
  fetchAgendaInterval(nextStart, nextEnd, { prefetch: true }).catch(() => {});

  return data;
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
    const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    dateEl.textContent = "Data: " + now.toLocaleDateString("it-IT", options);
  }
}

function toTitleCase(str, locale = "it") {
  return str
    .toLocaleLowerCase(locale)
    .replace(/\b\p{L}/gu, (c) => c.toLocaleUpperCase(locale));
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
