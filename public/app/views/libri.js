// Libri di testo: adozioni per materia, filtro "Da acquistare", totale della spesa, ISBN copiabile.
import { get, load } from "aulera/api";
import { html, raw, icon, setHTML, $, toast, segmented, bindSegmented, subjectName, titleCase, emptyState, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

const COPY = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>');
const EUR = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const price = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? EUR.format(Number(v)) : "");
const mustBuy = (b) => !!b.toBuy && !b.alreadyOwned;
const TONES = ["accent", "blue", "violet", "ok", "good", "bad"];
function toneOf(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}
/** "5EI INFORMATICA" → "5EI Informatica" (sigle con cifre restano maiuscole). */
const courseName = (s) => String(s || "").trim().split(/\s+/).map((w) => (/\d/.test(w) ? w.toUpperCase() : titleCase(w))).join(" ");
const tidyTitle = (s) => { const t = String(s || "").trim(); return t && t === t.toUpperCase() && /\p{L}{4}/u.test(t) ? titleCase(t) : t; };
const coverInitials = (title) => String(title || "").replace(/[^\p{L}\d\s]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function bookRow(b) {
  const tags = [
    mustBuy(b) && html`<span class="chip chip-accent">Da acquistare</span>`,
    b.alreadyOwned && html`<span class="chip chip-good">${icon("check")}Già tuo</span>`,
    b.newAdoption && html`<span class="chip chip-ok">Nuova adozione</span>`,
    b.alreadyInUse && html`<span class="chip">Già in uso</span>`,
    b.recommended && html`<span class="chip">Consigliato</span>`,
  ].filter(Boolean);
  const volume = b.volume && String(b.volume).toUpperCase() !== "U" ? `Vol. ${b.volume}` : "";
  const subtitle = [tidyTitle(b.subheading), volume].filter(Boolean).join(" · ");
  const by = [b.author ? titleCase(b.author) : "", b.publisher ? titleCase(b.publisher) : ""].filter(Boolean).join(" · ");
  const p = price(b.price);
  return html`<article class="libri-book${mustBuy(b) ? " is-to-buy" : ""}">
    <div class="libri-cover c-${toneOf(b.subjectDesc)}" aria-hidden="true">
      <span>${coverInitials(b.title)}</span>
      ${b.coverUrl ? html`<img src="${b.coverUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ""}
    </div>
    <div class="libri-info">
      <div class="libri-top">
        <div class="row-main"><h3 class="row-title clamp-2">${tidyTitle(b.title) || "Titolo non indicato"}</h3>
          ${subtitle ? html`<p class="row-sub">${subtitle}</p>` : ""}</div>
        ${p ? html`<p class="libri-price tnum">${p}</p>` : ""}
      </div>
      ${by ? html`<p class="caption libri-by">${by}</p>` : ""}
      <div class="libri-foot">
        ${tags}
        ${b.isbnCode ? html`<button type="button" class="libri-isbn" data-isbn="${b.isbnCode}" aria-label="Copia ISBN ${b.isbnCode}">
          <span class="faint">ISBN</span><span class="tnum">${b.isbnCode}</span>${COPY}</button>` : ""}
      </div>
    </div>
  </article>`;
}

export default {
  async render(root) {
    let courses = [];
    let filter = "all";

    setHTML(root, html`${pageHeader({ eyebrow: "Comunicazioni", title: "Libri di testo", subtitle: "Le adozioni della tua classe." })}
      <div data-body><div class="card card-pad"><div class="skeleton" style="height:84px"></div></div><div style="height:24px"></div>${skeletonList(4)}</div>`);
    const body = $("[data-body]", root);
    const subtitle = $(".page-header .subtitle", root);

    const drawList = () => {
      const list = $("[data-list]", body);
      if (!list) return;
      const multi = courses.length > 1;
      const sections = courses.map((c) => {
        const books = (c.books || []).filter((b) => b && (filter === "all" || mustBuy(b)));
        const bySubject = new Map();
        books.forEach((b) => {
          const k = subjectName(b.subjectDesc || "Altro");
          if (!bySubject.has(k)) bySubject.set(k, []);
          bySubject.get(k).push(b);
        });
        return { course: c, groups: [...bySubject.entries()].sort((a, b) => a[0].localeCompare(b[0], "it")) };
      }).filter((s) => s.groups.length);
      if (!sections.length) {
        setHTML(list, html`<div class="card">${emptyState({ iconName: "check", title: "Niente da acquistare", text: "Nessun libro risulta da comprare: sei a posto." })}</div>`);
        return;
      }
      setHTML(list, html`${sections.map((s) => html`
        ${multi ? html`<h2 class="title-3 libri-course">${courseName(s.course.courseDesc) || "Corso"}</h2>` : ""}
        <div class="libri-groups">${s.groups.map(([subject, books]) => html`<section class="com-group">
          <h2 class="overline com-group-label">${subject}<span class="faint tnum">${books.length > 1 ? ` · ${books.length}` : ""}</span></h2>
          <div class="card libri-list">${books.map(bookRow)}</div>
        </section>`)}</div>`)}`);
    };

    const draw = () => {
      const books = courses.flatMap((c) => c.books || []).filter(Boolean);
      const course = courses.length === 1 ? courseName(courses[0].courseDesc) : "";
      if (subtitle) subtitle.textContent = course ? `Le adozioni della classe ${course}.` : "Le adozioni della tua classe.";
      if (!books.length) {
        setHTML(body, html`<div class="card">${emptyState({ iconName: "books", title: "Nessun libro", text: "La scuola non ha ancora pubblicato l'elenco dei libri di testo." })}</div>`);
        return;
      }
      const toBuy = books.filter(mustBuy);
      const total = toBuy.reduce((s, b) => s + (Number(b.price) || 0), 0);
      const missingPrice = toBuy.some((b) => !(Number(b.price) > 0));
      if (filter === "buy" && !toBuy.length) filter = "all";
      setHTML(body, html`
        <section class="card libri-summary">
          <div class="libri-total">
            <p class="overline">Da spendere</p>
            <p class="libri-total-num tnum">${EUR.format(total)}</p>
            <p class="caption">${toBuy.length ? `Per ${toBuy.length} ${toBuy.length === 1 ? "libro" : "libri"} da acquistare${missingPrice ? ", alcuni senza prezzo" : ""}. Prezzi di copertina.` : "Nessun libro da acquistare."}</p>
          </div>
          <div class="stats-row cols-3 libri-stats">
            <div class="stat"><span class="stat-num">${books.length}</span><span class="stat-label">in elenco</span></div>
            <div class="stat"><span class="stat-num" style="color:var(--accent)">${toBuy.length}</span><span class="stat-label">da acquistare</span></div>
            <div class="stat"><span class="stat-num">${books.filter((b) => b.newAdoption).length}</span><span class="stat-label">nuove adozioni</span></div>
          </div>
        </section>
        <div class="com-toolbar libri-toolbar">${segmented("filter", [{ value: "all", label: "Tutti" }, { value: "buy", label: toBuy.length ? `Da acquistare · ${toBuy.length}` : "Da acquistare" }], filter)}</div>
        <div data-list></div>`);
      bindSegmented(body, "filter", (v) => { filter = v; drawList(); });
      drawList();
    };

    body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-isbn]");
      if (!b) return;
      const ok = await copyText(b.dataset.isbn);
      toast(ok ? `ISBN ${b.dataset.isbn} copiato` : "Impossibile copiare: tieni premuto sul codice.", { error: !ok });
    });
    // Copertina non caricabile → resta il segnaposto con le iniziali.
    body.addEventListener("error", (e) => { if (e.target.matches?.(".libri-cover img")) e.target.remove(); }, true);

    const fetchData = async () => {
      try {
        await load("libri", () => get("/libri"), (data) => {
          courses = (data?.courses || []).filter(Boolean);
          draw();
        }, { maxAge: 300_000 });
      } catch (err) {
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => { setHTML(body, skeletonList(4)); fetchData(); });
      }
    };
    await fetchData();
  },
};
