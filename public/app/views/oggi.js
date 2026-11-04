// Oggi: saluto, media, lezioni del giorno, prossimi impegni, ultimi voti, bacheca, assenze.
import { get, post, load } from "aulera/api";
import { state, firstName, yearQuery } from "aulera/state";
import { html, icon, setHTML, $, ring, animateRings, gradeClass, fmtDate, relativeDay, fmtTime, ymd, addDays, titleCase, subjectName, emptyState, fmtNum } from "aulera/ui";
import { extractGrades, rawAverage, gradeValue, excludedFromAverage, componentLabel } from "aulera/grades";
import { pageHeader } from "aulera/main";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Buonanotte";
  if (h < 13) return "Buongiorno";
  if (h < 18) return "Buon pomeriggio";
  return "Buonasera";
}

// Ordine e visibilità delle schede: Personalizza → Schede della home.
const CARD_CLASS = { media: "home-avg", lezioni: "home-today", agenda: "home-next", voti: "home-grades", bacheca: "home-board", assenze: "home-abs" };
function homeSlots() {
  const order = [...(state.prefs?.home_order || []), ...Object.keys(CARD_CLASS)].filter((id, i, a) => a.indexOf(id) === i && CARD_CLASS[id]);
  const hidden = new Set(state.prefs?.home_hidden || []);
  return order.map((id, i) => hidden.has(id) ? "" : html`<div class="${CARD_CLASS[id]}" style="order:${i}">${slot(id)}</div>`);
}
const slot = (name) => html`<div data-slot="${name}"><div class="card card-pad"><div class="skeleton-line" style="width:40%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div></div>`;

export default {
  async render(root) {
    const today = new Date();
    const name = firstName();
    const cls = state.session?.class_code;
    setHTML(root, html`
      ${pageHeader({
        eyebrow: fmtDate(today, { weekday: true }),
        title: html`${greeting()}${name ? html`, <span class="gradient-text">${name}</span>` : ""}.`,
        subtitle: cls ? `Classe ${cls}` : "",
      })}
      <div class="home-grid">
        ${homeSlots()}
      </div>`);

    const fill = (name, content) => { const el = $(`[data-slot="${name}"]`, root); if (el) setHTML(el, content); };
    const fail = (name, title) => (err) => fill(name, html`<div class="card card-pad"><p class="title-3">${title}</p><p class="body-2">${err.message}</p></div>`);

    // Voti → media + ultimi voti
    load(`voti:${state.year}`, () => post(`/voti?${yearQuery()}`), (data) => {
      const grades = extractGrades(data);
      const avg = rawAverage(grades);
      const counted = grades.filter((g) => !excludedFromAverage(g)).length;
      fill("media", html`<a class="card card-pad home-card pressable" href="/voti">
        <div class="spread"><p class="overline">Media generale</p>${icon("chevronRight", "chev")}</div>
        <div class="home-avg-body">${ring(avg, { size: 132, stroke: 11 })}
          <div class="stack-sm"><p class="title-2">${avg === null ? "Nessun voto" : avg >= 6 ? "Sei in linea" : "Da recuperare"}</p>
          <p class="body-2">${counted} ${counted === 1 ? "voto" : "voti"} quest'anno</p></div></div></a>`);
      animateRings(root);
      const latest = grades.slice(0, 6);
      fill("voti", html`<section class="card card-pad home-card">
        <div class="spread"><p class="overline">Ultimi voti</p><a class="tile-link" href="/voti">Tutti ${icon("chevronRight")}</a></div>
        ${latest.length ? html`<ul class="home-grade-list">${latest.map((g) => {
          const v = gradeValue(g);
          return html`<li><span class="grade ${excludedFromAverage(g) ? "g-none" : gradeClass(v)}">${g.displayValue || "—"}</span>
            <div class="row-main"><p class="row-title">${subjectName(g.subjectDesc)}</p><p class="row-sub">${relativeDay(g.evtDate)}${componentLabel(g) ? ` · ${componentLabel(g)}` : ""}</p></div></li>`;
        })}</ul>` : emptyState({ iconName: "grades", title: "Ancora nessun voto" })}
      </section>`);
    }, { maxAge: 120_000 }).catch((e) => { fail("media", "Media")(e); fail("voti", "Ultimi voti")(e); });

    // Lezioni di oggi
    load(`lezioni:${ymd(today)}`, () => get(`/lezioni?start=${ymd(today)}&end=${ymd(today)}`), (data) => {
      const lessons = (data.lessons || []).slice().sort((a, b) => (a.evtHPos || 0) - (b.evtHPos || 0));
      fill("lezioni", html`<section class="card card-pad home-card">
        <div class="spread"><p class="overline">Oggi a scuola</p><a class="tile-link" href="/lezioni">Argomenti ${icon("chevronRight")}</a></div>
        ${lessons.length ? html`<ol class="timeline">${lessons.map((l) => html`<li><span class="tl-hour tnum">${l.evtHPos ? `${l.evtHPos}ª` : ""}</span>
          <div><p class="row-title">${subjectName(l.subjectDesc)}</p><p class="row-sub">${l.lessonArg || l.lessonType || titleCase(l.authorName)}</p></div></li>`)}</ol>`
          : emptyState({ iconName: "today", title: "Nessuna lezione registrata", text: "Le lezioni compaiono qui quando i docenti firmano il registro." })}
      </section>`);
    }, { maxAge: 120_000 }).catch(fail("lezioni", "Lezioni di oggi"));

    // Prossimi impegni (7 giorni)
    const start = ymd(today), end = ymd(addDays(today, 7));
    load(`agenda:${start}:${end}`, () => post("/agenda", { start, end }), (data) => {
      const items = (data.agenda?.agenda || data.agenda || []).slice()
        .sort((a, b) => String(a.evtDatetimeBegin).localeCompare(String(b.evtDatetimeBegin))).slice(0, 5);
      fill("agenda", html`<section class="card card-pad home-card">
        <div class="spread"><p class="overline">Prossimi giorni</p><a class="tile-link" href="/agenda">Agenda ${icon("chevronRight")}</a></div>
        ${items.length ? html`<ul class="agenda-mini">${items.map((ev) => html`<li class="${ev.evtCode === "AGHW" ? "is-hw" : "is-note"}">
          <div class="agenda-mini-day"><span>${relativeDay(ev.evtDatetimeBegin)}</span>${ev.isFullDay ? "" : html`<small class="tnum">${fmtTime(ev.evtDatetimeBegin)}</small>`}</div>
          <div class="row-main"><p class="row-title">${ev.subjectDesc ? subjectName(ev.subjectDesc) : ev.evtCode === "AGHW" ? "Compiti" : "Annotazione"}</p><p class="row-sub clamp-2">${ev.notes || ""}</p></div></li>`)}</ul>`
          : emptyState({ iconName: "calendar", title: "Settimana libera", text: "Nessun compito o verifica nei prossimi 7 giorni." })}
      </section>`);
    }, { maxAge: 120_000 }).catch(fail("agenda", "Agenda"));

    // Bacheca
    load("bacheca", () => get("/bacheca"), (data) => {
      const items = data.items || [];
      const unread = items.filter((i) => !i.readStatus);
      const show = (unread.length ? unread : items).slice(0, 3);
      fill("bacheca", html`<section class="card card-pad home-card">
        <div class="spread"><p class="overline">Bacheca${unread.length ? html` · <span style="color:var(--accent)">${unread.length} da leggere</span>` : ""}</p><a class="tile-link" href="/bacheca">Apri ${icon("chevronRight")}</a></div>
        ${show.length ? html`<ul class="stack-sm" style="margin-top:12px">${show.map((n) => html`<li><a class="board-mini pressable" href="/bacheca?id=${n.pubId}">
          ${n.readStatus ? html`<span class="dot" style="background:transparent"></span>` : html`<span class="dot"></span>`}
          <div class="row-main"><p class="row-title clamp-2">${n.cntTitle}</p><p class="row-sub">${n.cntCategory || "Comunicazione"} · ${relativeDay(n.pubDT)}</p></div></a></li>`)}</ul>`
          : emptyState({ iconName: "megaphone", title: "Bacheca vuota" })}
      </section>`);
    }, { maxAge: 120_000 }).catch(fail("bacheca", "Bacheca"));

    // Assenze
    load(`assenze:${state.year}`, () => post(`/assenze?${yearQuery()}`), (data) => {
      const events = data.assenze?.events || data.events || [];
      const count = (c) => events.filter((e) => e.evtCode === c).length;
      const toJustify = events.filter((e) => !e.isJustified).length;
      fill("assenze", html`<a class="card card-pad home-card pressable" href="/assenze">
        <div class="spread"><p class="overline">Presenze</p>${icon("chevronRight", "chev")}</div>
        <div class="stats-row cols-3" style="margin-top:14px">
          <div class="stat"><span class="stat-num">${count("ABA0")}</span><span class="stat-label">Assenze</span></div>
          <div class="stat"><span class="stat-num">${count("ABR0") + count("ABR1")}</span><span class="stat-label">Ritardi</span></div>
          <div class="stat"><span class="stat-num">${count("ABU0")}</span><span class="stat-label">Uscite</span></div>
        </div>
        ${toJustify ? html`<p class="chip chip-ok" style="margin-top:14px">${toJustify} da giustificare</p>` : html`<p class="chip chip-good" style="margin-top:14px">${icon("check")}Tutto giustificato</p>`}
      </a>`);
    }, { maxAge: 120_000 }).catch(fail("assenze", "Assenze"));
  },
};

export { fmtNum };
