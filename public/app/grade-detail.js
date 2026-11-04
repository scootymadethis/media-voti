// Dettaglio di un voto (pannello). Dal 9 in su parte la celebrazione: il voto "esplode" in scena
// con un rimbalzo, raggi che ruotano dietro e coriandoli su canvas (rAF, 60 fps, ~2 s).
// Sotto il 4 il voto ha le fiamme (e sotto il 3 le corna): il pannello lo dice con ironia e
// mostra cosa serve per recuperare. Con "riduci movimento" niente coriandoli né rimbalzi.
import { html, icon, setHTML, openSheet, gradeClass, fmtDate, subjectName, personName, fmtNum } from "aulera/ui";
import { gradeValue, excludedFromAverage, componentLabel, gradeWeight, average, neededGrade, gradeLabel } from "aulera/grades";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function headline(v, excluded) {
  if (excluded || v === null) return { title: "Voto registrato", text: "Non fa media." };
  if (v >= 10) return { title: "Perfetto.", text: "Dieci. Non si può fare di meglio." };
  if (v >= 9) return { title: "Strepitoso!", text: "Un voto da incorniciare." };
  if (v >= 8) return { title: "Ottimo lavoro", text: "Sopra la media, continua così." };
  if (v >= 6.5) return { title: "Bene", text: "Un voto solido." };
  if (v >= 6) return { title: "Sufficiente", text: "Ci sei, ma sei al limite." };
  if (v >= 4) return { title: "Da recuperare", text: "Capita: c'è tempo per rimediare." };
  if (v >= 3) return { title: "Rosso fuoco", text: "Brucia, ma si recupera." };
  return { title: "Un voto da brividi", text: "Niente panico: un passo alla volta si risale." };
}

/** Coriandoli: canvas grande quanto il pannello, sparati dal voto; gravità, resistenza dell'aria
 *  (cadono "svolazzando"), rotazione. Un solo canvas 2D, nessun layout: 60 fps anche su telefoni medi. */
function confetti(canvas, origin, { count = 160, duration = 2600 } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = [css.getPropertyValue("--accent").trim() || "#ff453a", "#ffd60a", "#30d158", "#0a84ff", "#ff375f", "#bf5af2", "#ffffff"];
  const cx = origin.x - rect.left, cy = origin.y - rect.top;
  const parts = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25;
    const speed = 7 + Math.random() * 11;
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 6, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      color: colors[(Math.random() * colors.length) | 0], shape: Math.random() < 0.7 ? "rect" : "dot",
      wobble: Math.random() * 10,
    };
  });
  const start = performance.now();
  let frame = 0;
  const tick = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, rect.width, rect.height);
    const fade = Math.max(0, 1 - Math.max(0, t - duration * 0.6) / (duration * 0.4));
    for (const p of parts) {
      p.vx *= 0.965; p.vy = p.vy * 0.96 + 0.2; p.x += p.vx + Math.sin(p.wobble) * 0.6; p.y += p.vy; p.rot += p.vr; p.wobble += 0.12;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * (0.6 + 0.4 * Math.abs(Math.cos(p.wobble))));
      else { ctx.beginPath(); ctx.arc(0, 0, p.size / 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (t < duration && canvas.isConnected) frame = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, rect.width, rect.height);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

/**
 * Apre il dettaglio del voto.
 * @param g voto ClasseViva
 * @param subjectGrades (opzionale) tutti i voti della stessa materia, per "cosa serve per recuperare"
 */
export function openGradeDetail(g, subjectGrades = null) {
  const v = gradeValue(g);
  const excluded = excludedFromAverage(g);
  const top = !excluded && v !== null && v >= 9;
  const low = !excluded && v !== null && v < 6;
  const { title, text } = headline(v, excluded);
  const cls = excluded ? "g-none" : gradeClass(v);

  let recovery = "";
  if (low && subjectGrades?.length) {
    const counted = subjectGrades.filter((x) => !excludedFromAverage(x));
    const avg = average(counted);
    if (avg !== null && avg < 6) {
      const need = neededGrade(avg, counted.length, 6, 1);
      const need2 = neededGrade(avg, counted.length, 6, 2);
      recovery = html`<div class="gd-recover card card-pad">
        <p class="title-3">${icon("target")} Per tornare al 6</p>
        <p class="body-2">${need <= 10
          ? html`Ti serve <strong>${gradeLabel(need)}</strong> al prossimo voto${need2 <= 10 && need2 < need ? html`, oppure <strong>${gradeLabel(need2)}</strong> di media nei prossimi due` : ""}.`
          : need2 <= 10 ? html`Servono due voti da <strong>${gradeLabel(need2)}</strong> di media.` : "Servono più voti buoni: chiedi un'interrogazione di recupero."}
        Media attuale ${fmtNum(avg, 2)}.</p></div>`;
    }
  }

  const facts = [
    ["Data", fmtDate(g.evtDate, { weekday: true, year: true })],
    ["Tipo", componentLabel(g)],
    ["Periodo", g.periodDesc ? g.periodDesc.charAt(0) + g.periodDesc.slice(1).toLowerCase() : ""],
    ["Docente", g.teacherName ? personName(g.teacherName) : ""],
    ["Peso", gradeWeight(g) !== 1 ? `${fmtNum(gradeWeight(g) * 100, 0)}%` : ""],
    ["Media", excluded ? "Non fa media" : "Fa media"],
  ].filter(([, val]) => val);

  const body = document.createElement("div");
  setHTML(body, html`
    <div class="gd-hero${top ? " is-top" : ""}${low ? " is-low" : ""}${reduced() ? " is-still" : ""}">
      ${top ? html`<div class="gd-rays" aria-hidden="true"></div>` : ""}
      <div class="gd-glow" aria-hidden="true"></div>
      <span class="grade gd-big ${cls}">${g.displayValue || "—"}</span>
      <div class="gd-copy"><p class="title-2">${title}</p><p class="body-2">${text}</p></div>
    </div>
    ${g.notesForFamily ? html`<p class="gd-note card card-pad">“${g.notesForFamily}”</p>` : ""}
    ${recovery}
    <ul class="card list gd-facts">${facts.map(([k, val]) => html`<li class="row"><div class="row-main"><p class="row-sub">${k}</p></div><span class="row-trail" style="color:var(--text)">${val}</span></li>`)}</ul>`);

  let stop = null, timer = 0;
  const sheet = openSheet({
    title: subjectName(g.subjectDesc),
    content: body,
    onClose: () => { clearTimeout(timer); stop?.(); },
  });
  if (top && !reduced()) {
    try { navigator.vibrate?.([18, 40, 18]); } catch { /* non supportato */ }
    // dopo l'entrata del pannello, così i coriandoli partono quando il voto "atterra"
    const canvas = document.createElement("canvas");
    canvas.className = "gd-confetti";
    canvas.setAttribute("aria-hidden", "true");
    sheet.el.append(canvas);
    timer = setTimeout(() => {
      const r = body.querySelector(".gd-big").getBoundingClientRect();
      stop = confetti(canvas, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }, 230);
  }
  return sheet;
}
