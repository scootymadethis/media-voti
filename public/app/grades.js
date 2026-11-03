// Logica dei voti condivisa (stesse regole del backend per la media generale).

export function gradeValue(g) {
  const raw = g?.decimalValue;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const m = String(raw).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Esclusi dalla media: Religione, assenze ("A"), voti blu/annotazioni, annullati, noAverage. */
export function excludedFromAverage(g) {
  if (!g) return true;
  if (g.canceled) return true;
  if (g.noAverage) return true;
  if (String(g.subjectDesc || "").toUpperCase().includes("RELIGIONE")) return true;
  if (String(g.displayValue || "").trim().toUpperCase() === "A") return true;
  if (String(g.color || "").toLowerCase() === "blue") return true;
  return gradeValue(g) === null;
}

/** Peso: ClasseViva usa 100 = peso 1 (w1) oppure 1 (v1). */
export function gradeWeight(g) {
  const w = Number(g?.weightFactor);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return w > 10 ? w / 100 : w;
}

export function average(grades) {
  const valid = grades.filter((g) => !excludedFromAverage(g));
  if (!valid.length) return null;
  return valid.reduce((s, g) => s + gradeValue(g), 0) / valid.length;
}

export function extractGrades(payload) {
  const v = payload?.voti ?? payload;
  const list = Array.isArray(v) ? v : v?.grades;
  return Array.isArray(list) ? list.slice().sort((a, b) => String(b.evtDate).localeCompare(String(a.evtDate))) : [];
}

export function periodsOf(grades) {
  const map = new Map();
  grades.forEach((g) => {
    const key = String(g.periodPos ?? "");
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, pos: Number(g.periodPos), label: prettyPeriod(g.periodDesc || g.periodLabel || `Periodo ${key}`) });
  });
  return [...map.values()].sort((a, b) => a.pos - b.pos);
}
function prettyPeriod(s) {
  const t = String(s).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Materie con media, ultimi voti e conteggi; filtrabili per periodo. */
export function subjectsOf(grades, periodKey = "all") {
  const map = new Map();
  grades.forEach((g) => {
    if (periodKey !== "all" && String(g.periodPos) !== periodKey) return;
    const name = String(g.subjectDesc || "Materia").trim();
    if (!map.has(name)) map.set(name, { name, grades: [], teacher: g.teacherName || "" });
    map.get(name).grades.push(g);
  });
  return [...map.values()].map((s) => {
    const avg = average(s.grades);
    const counted = s.grades.filter((g) => !excludedFromAverage(g));
    return { ...s, average: avg, count: counted.length, last: s.grades[0] || null, excluded: counted.length === 0 };
  }).sort((a, b) => a.name.localeCompare(b.name, "it"));
}

/** Media generale = media delle medie per materia (come la pagella), escluse le materie senza voti. */
export function generalAverage(grades, periodKey = "all") {
  const subs = subjectsOf(grades, periodKey).filter((s) => s.average !== null);
  if (!subs.length) return null;
  return subs.reduce((t, s) => t + s.average, 0) / subs.length;
}

/** Media "grezza" di tutti i voti (come ClasseViva e la classifica). */
export function rawAverage(grades, periodKey = "all") {
  return average(periodKey === "all" ? grades : grades.filter((g) => String(g.periodPos) === periodKey));
}

/** Andamento: media cumulativa nel tempo (dal voto più vecchio). */
export function trend(grades) {
  const valid = grades.filter((g) => !excludedFromAverage(g)).slice().sort((a, b) => String(a.evtDate).localeCompare(String(b.evtDate)));
  let sum = 0;
  return valid.map((g, i) => { sum += gradeValue(g); return { date: g.evtDate, value: sum / (i + 1), grade: gradeValue(g) }; });
}

/** Voto necessario nei prossimi `n` voti per raggiungere `target`. */
export function neededGrade(current, count, target, n = 1) {
  if (current === null || current === undefined || !count) return target;
  return (target * (count + n) - current * count) / n;
}

export function gradeLabel(value) {
  if (value === null || value === undefined) return "—";
  const r = Math.round(value * 4) / 4;
  if (r >= 10) return "10";
  const i = Math.floor(r), d = r - i;
  if (d === 0) return `${i}`;
  if (d === 0.25) return `${i}+`;
  if (d === 0.5) return `${i}½`;
  return `${i + 1}-`;
}

export function componentLabel(g) {
  const pos = Number(g?.componentPos);
  return { 1: "Scritto", 2: "Orale", 3: "Pratico" }[pos] || g?.componentDesc || "";
}
