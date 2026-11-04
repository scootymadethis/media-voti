// Voti: media generale + andamento, materie, dettaglio materia con obiettivo e simulatore.
import { post, load } from "aulera/api";
import { state, yearQuery, isCurrentYear, on } from "aulera/state";
import { html, icon, setHTML, $, $$, ring, animateRings, gradeClass, gradeColor, fmtDate, titleCase, subjectName, emptyState, errorState, segmented, bindSegmented, openSheet, fmtNum, esc } from "aulera/ui";
import { extractGrades, rawAverage, subjectsOf, periodsOf, trend, gradeValue, excludedFromAverage, neededGrade, gradeLabel, componentLabel, average } from "aulera/grades";
import { pageHeader, yearButton, bindYearPicker } from "aulera/main";
import { openGradeDetail } from "aulera/gradedetail";

function sparkline(points, { w = 260, h = 64 } = {}) {
  if (points.length < 2) return "";
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, 5) - 0.3, max = Math.max(...vals, 8) + 0.3;
  const x = (i) => (i / (points.length - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min)) * h;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const six = y(6);
  const last = points[points.length - 1];
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${gradeColor(last.value)}" stop-opacity=".28"/><stop offset="1" stop-color="${gradeColor(last.value)}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${w}" y1="${six}" y2="${six}" class="spark-six"/>
    <path d="${d} L${w},${h} L0,${h} Z" fill="url(#sparkfill)"/>
    <path d="${d}" class="spark-line" stroke="${gradeColor(last.value)}"/>
    <circle cx="${x(points.length - 1)}" cy="${y(last.value)}" r="4" fill="${gradeColor(last.value)}"/>
  </svg>`;
}

function gradeChip(g, size = "") {
  const v = gradeValue(g);
  return html`<span class="grade ${size} ${excludedFromAverage(g) ? "g-none" : gradeClass(v)}" title="${fmtDate(g.evtDate)}">${g.displayValue || "—"}</span>`;
}

function subjectSheet(subject, allGrades) {
  const grades = subject.grades;
  const counted = grades.filter((g) => !excludedFromAverage(g));
  const avg = average(grades);
  const body = document.createElement("div");
  const hypothetical = [];
  let target = Math.min(10, Math.max(6, Math.ceil((avg ?? 6) + 0.01)));
  let next = 1;

  const draw = () => {
    const values = counted.map(gradeValue).concat(hypothetical);
    const simAvg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const need = neededGrade(simAvg, values.length, target, next);
    const needText = need > 10 ? "Non raggiungibile" : need <= 1 ? "Già raggiunto" : gradeLabel(need);
    setHTML(body, html`
      <div class="subject-hero">
        ${ring(simAvg, { size: 112, stroke: 10, sub: hypothetical.length ? "con simulati" : "media" })}
        <div class="stack-sm"><p class="caption">${titleCase(subject.teacher)}</p>
          <p class="body-2">${counted.length} ${counted.length === 1 ? "voto" : "voti"} in media${grades.length > counted.length ? ` · ${grades.length - counted.length} esclusi` : ""}</p>
          <p class="chip ${simAvg === null ? "" : simAvg >= 6 ? "chip-good" : simAvg >= 5 ? "chip-ok" : "chip-bad"}">In pagella: ${gradeLabel(simAvg === null ? null : Math.round(simAvg))}</p></div>
      </div>

      <section class="tool card card-pad">
        <div class="spread"><p class="title-3">${icon("target")} Obiettivo</p><p class="caption">media da raggiungere</p></div>
        <div class="stepper-row">
          <div class="stepper"><button type="button" class="btn btn-icon" data-t="-">${icon("minus")}</button><output class="stepper-val tnum">${fmtNum(target, 2)}</output><button type="button" class="btn btn-icon" data-t="+">${icon("plus")}</button></div>
          <div class="stepper"><button type="button" class="btn btn-icon" data-n="-">${icon("minus")}</button><output class="stepper-val tnum">${next} ${next === 1 ? "voto" : "voti"}</output><button type="button" class="btn btn-icon" data-n="+">${icon("plus")}</button></div>
        </div>
        <p class="need">Ti serve <strong class="${need > 10 ? "bad" : ""}">${needText}</strong>${need <= 10 && need > 1 ? (next > 1 ? ` di media nei prossimi ${next} voti` : " al prossimo voto") : ""}.</p>
      </section>

      <section class="tool card card-pad">
        <div class="spread"><p class="title-3">${icon("flask")} Simulatore</p>${hypothetical.length ? html`<button type="button" class="btn btn-ghost" data-clear>Azzera</button>` : ""}</div>
        <p class="caption">Aggiungi voti ipotetici e guarda come cambia la media.</p>
        <div class="sim-keys">${[4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 10].map((v) => html`<button type="button" class="grade grade-sm ${gradeClass(v)} pressable" data-add="${v}">${gradeLabel(v)}</button>`)}</div>
        ${hypothetical.length ? html`<div class="sim-list">${hypothetical.map((v, i) => html`<button type="button" class="grade grade-sm g-none pressable" data-rm="${i}" aria-label="Rimuovi">${gradeLabel(v)}</button>`)}</div>` : ""}
      </section>

      <p class="overline" style="margin:24px 4px 8px">Tutti i voti</p>
      <div class="card list">${grades.map((g, i) => html`<button type="button" class="row" data-g="${i}">${gradeChip(g)}
        <div class="row-main"><p class="row-title">${fmtDate(g.evtDate, { weekday: true })}</p>
          <p class="row-sub">${[componentLabel(g), titleCase(g.periodDesc || ""), excludedFromAverage(g) ? "non fa media" : ""].filter(Boolean).join(" · ")}</p>
          ${g.notesForFamily ? html`<p class="row-sub" style="color:var(--text)">${g.notesForFamily}</p>` : ""}</div>${icon("chevronRight", "chev")}</button>`)}</div>`);
    animateRings(body);
  };
  draw();
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.g) { openGradeDetail(grades[Number(b.dataset.g)], grades); return; }
    if (b.dataset.t) target = Math.min(10, Math.max(1, target + (b.dataset.t === "+" ? 0.25 : -0.25)));
    else if (b.dataset.n) next = Math.min(10, Math.max(1, next + (b.dataset.n === "+" ? 1 : -1)));
    else if (b.dataset.add) hypothetical.push(Number(b.dataset.add));
    else if (b.dataset.rm) hypothetical.splice(Number(b.dataset.rm), 1);
    else if ("clear" in b.dataset) hypothetical.length = 0;
    else return;
    draw();
  });
  openSheet({ title: subjectName(subject.name), content: body });
}

export default {
  async render(root) {
    let period = "all";
    let mode = "materie";
    let grades = [];
    let snapshot = false;

    setHTML(root, html`${pageHeader({ eyebrow: "Registro", title: "Voti", actions: yearButton() })}<div data-body>${html`<div class="card card-pad"><div class="skeleton" style="height:160px"></div></div>`}</div>`);
    bindYearPicker(root, () => fetchData());

    const draw = () => {
      const body = $("[data-body]", root);
      if (!grades.length) {
        setHTML(body, html`${snapshot ? "" : ""}<div class="card">${emptyState({ iconName: "grades", title: "Nessun voto", text: isCurrentYear() ? "I voti compariranno qui appena i docenti li registrano." : "Per quest'anno non ci sono voti salvati." })}</div>`);
        return;
      }
      const periods = periodsOf(grades);
      if (period !== "all" && !periods.some((p) => p.key === period)) period = "all";
      const scoped = period === "all" ? grades : grades.filter((g) => String(g.periodPos) === period);
      const avg = rawAverage(grades, period);
      const subjects = subjectsOf(grades, period);
      const ranked = subjects.filter((s) => s.average !== null).sort((a, b) => b.average - a.average);
      const tr = trend(scoped);
      const below = subjects.filter((s) => s.average !== null && s.average < 6);

      setHTML(body, html`
        ${snapshot ? html`<p class="chip chip-accent" style="margin-bottom:14px">${icon("history")}Dati salvati per l'anno ${state.year}</p>` : ""}
        <div class="voti-toolbar">
          ${periods.length > 1 ? segmented("period", [{ value: "all", label: "Anno" }, ...periods.map((p) => ({ value: p.key, label: p.label }))], period) : html`<span></span>`}
          ${segmented("mode", [{ value: "materie", label: "Materie" }, { value: "cronologia", label: "Cronologia" }], mode)}
        </div>
        <section class="card voti-summary">
          <div class="voti-summary-ring">${ring(avg, { size: 150, stroke: 12, sub: "media" })}</div>
          <div class="voti-summary-info">
            <div class="stats-row">
              <div class="stat"><span class="stat-num">${scoped.filter((g) => !excludedFromAverage(g)).length}</span><span class="stat-label">voti</span></div>
              <div class="stat"><span class="stat-num">${ranked.length}</span><span class="stat-label">materie</span></div>
              <div class="stat"><span class="stat-num" style="color:${below.length ? "var(--bad)" : "var(--good)"}">${below.length}</span><span class="stat-label">insufficienze</span></div>
            </div>
            ${ranked.length ? html`<p class="body-2" style="margin-top:14px">Il tuo punto forte è <strong style="color:var(--text)">${subjectName(ranked[0].name)}</strong> (${fmtNum(ranked[0].average)})${ranked.length > 1 && ranked[ranked.length - 1].average < 6 ? html`, da recuperare <strong style="color:var(--text)">${subjectName(ranked[ranked.length - 1].name)}</strong> (${fmtNum(ranked[ranked.length - 1].average)})` : ""}.</p>` : ""}
            ${tr.length > 1 ? html`<div class="trend"><p class="overline">Andamento</p>${sparkline(tr)}</div>` : ""}
          </div>
        </section>
        <div data-list class="section"></div>`);

      const list = $("[data-list]", body);
      if (mode === "materie") {
        setHTML(list, html`<div class="subject-grid stagger">${subjects.map((s, i) => html`<button type="button" class="card subject-card pressable" data-subject="${i}">
          <div class="spread"><div class="row-main"><p class="title-3 clamp-2">${subjectName(s.name)}</p><p class="caption">${titleCase(s.teacher)}</p></div>
            <span class="grade ${s.average === null ? "g-none" : gradeClass(s.average)}">${s.average === null ? "—" : fmtNum(s.average, 2)}</span></div>
          <div class="subject-chips">${s.grades.slice(0, 8).map((g) => gradeChip(g, "grade-sm"))}</div>
          ${s.average !== null ? html`<div class="bar"><span style="width:${Math.max(4, s.average * 10)}%;background:${gradeColor(s.average)}"></span></div>` : ""}
        </button>`)}</div>`);
        $$(".stagger", list).forEach((g) => [...g.children].forEach((c, i) => c.style.setProperty("--i", i)));
        list.onclick = (e) => {
          const b = e.target.closest("[data-subject]");
          if (b) subjectSheet(subjects[Number(b.dataset.subject)], grades);
        };
      } else {
        const byMonth = new Map();
        scoped.forEach((g) => {
          const k = String(g.evtDate).slice(0, 7);
          if (!byMonth.has(k)) byMonth.set(k, []);
          byMonth.get(k).push(g);
        });
        setHTML(list, html`${[...byMonth.entries()].map(([k, gs]) => html`<p class="overline" style="margin:18px 4px 8px">${new Date(k + "-01").toLocaleDateString("it-IT", { month: "long", year: "numeric" })}</p>
          <div class="card list">${gs.map((g) => html`<button type="button" class="row" data-g="${scoped.indexOf(g)}">${gradeChip(g)}<div class="row-main"><p class="row-title">${subjectName(g.subjectDesc)}</p>
            <p class="row-sub">${fmtDate(g.evtDate, { weekday: true })}${componentLabel(g) ? ` · ${componentLabel(g)}` : ""}${g.notesForFamily ? ` · ${g.notesForFamily}` : ""}</p></div>${icon("chevronRight", "chev")}</button>`)}</div>`)}`);
        list.onclick = (e) => {
          const b = e.target.closest("[data-g]");
          if (!b) return;
          const g = scoped[Number(b.dataset.g)];
          openGradeDetail(g, scoped.filter((x) => x.subjectDesc === g.subjectDesc));
        };
      }
      bindSegmented(body, "period", (v) => { period = v; draw(); });
      bindSegmented(body, "mode", (v) => { mode = v; draw(); });
      animateRings(body);
    };

    const fetchData = async () => {
      const body = $("[data-body]", root);
      try {
        await load(`voti:${state.year}`, () => post(`/voti?${yearQuery()}`), (data) => {
          grades = extractGrades(data);
          snapshot = !!data.from_snapshot;
          draw();
        }, { maxAge: 60_000 });
      } catch (err) {
        if (err.status === 404) { grades = []; draw(); return; }
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", fetchData);
      }
    };
    await fetchData();
    // Aggiorna l'etichetta del pulsante anno quando cambia.
    return on("year", () => {
      const btn = $("[data-year-picker] span", root);
      if (btn) btn.textContent = state.years?.years?.find((y) => y.id === state.year)?.label || state.year;
    });
  },
};
export { esc };
