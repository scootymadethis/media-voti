// Profilo: chi sei, preferenze (tema, anno), visibilità nelle classifiche, dispositivi, informativa, esci.
import { get, post, load, invalidate } from "aulera/api";
import { state, setTheme, yearLabel, on } from "aulera/state";
import { html, icon, setHTML, $, segmented, bindSegmented, openSheet, toast, titleCase, initials, fmtDate } from "aulera/ui";
import { pageHeader, yearButton, bindYearPicker, logout } from "aulera/main";

const AVG = { subject_name: "Media generale", period_key: "generale" };
const AVG_Q = new URLSearchParams(AVG).toString();
const WEB_VERSION = new URL(import.meta.url).searchParams.get("v") || "1";

// Colori dei badge: solo #hex, rgb() e rgba() (stessa regola della Classifica).
const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\))$/i;
const safeColor = (v) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : null);
const badgeChip = (b) => {
  const style = [["color", safeColor(b?.text_color)], ["background", safeColor(b?.background_color)], ["border-color", safeColor(b?.border_color)]]
    .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(";");
  return html`<span class="account-badge" style="${style}">${b?.label || ""}</span>`;
};

async function loadVisibility() {
  const pick = (r) => (r?.item ? r.item.visible_in_leaderboard !== false : r?.default_visible_in_leaderboard !== false);
  const [abs, avg] = await Promise.all([get("/leaderboard/me"), get(`/average-leaderboard/me?${AVG_Q}`)]);
  return { assenze: pick(abs), media: pick(avg) };
}
function saveVisibility(kind, visible) {
  invalidate("lb:");
  if (kind === "assenze") return post("/leaderboard/update", { hours: 0, visible_in_leaderboard: visible });
  return post("/average-leaderboard/update", { ...AVG, period_label: "Media generale", average: 0, visible_in_leaderboard: visible });
}

export default {
  async render(root) {
    const s = state.session || {};
    const name = titleCase(s.full_name || "") || s.username || "Studente";
    let card = null;
    let vis = null;

    setHTML(root, html`
      ${pageHeader({ eyebrow: "Account", title: "Profilo" })}
      <section class="card profilo-hero">
        <div class="account-avatar xl" aria-hidden="true">${initials(name)}</div>
        <div class="profilo-hero-main">
          <h2 class="title-1 profilo-name">${name}</h2>
          <p class="body-2" data-hero-sub>${s.class_code ? `Classe ${s.class_code}` : "Studente"}</p>
          ${s.badges?.length ? html`<div class="account-badges profilo-badges">${s.badges.map(badgeChip)}</div>` : ""}
        </div>
      </section>

      <div class="profilo-grid">
        <div class="profilo-col">
          <section class="profilo-section">
            <p class="overline profilo-label">Dati scolastici</p>
            <div data-card><div class="card list">${[60, 40, 50, 35].map((w) => html`<div class="row"><div class="row-main stack-sm"><div class="skeleton-line" style="width:${w}%"></div></div></div>`)}</div></div>
          </section>

          <section class="profilo-section">
            <p class="overline profilo-label">Aspetto</p>
            <div class="card card-pad profilo-theme">
              <div class="profilo-theme-preview">
                ${[["auto", "Automatico"], ["light", "Chiaro"], ["dark", "Scuro"]].map(([t, l]) => html`<button type="button" class="profilo-swatch pressable is-${t}" data-swatch="${t}" tabindex="-1" aria-label="${l}"><i></i><i></i><i></i></button>`)}
              </div>
              ${segmented("theme", [{ value: "auto", label: "Automatico" }, { value: "light", label: "Chiaro" }, { value: "dark", label: "Scuro" }], state.theme || "auto")}
              <p class="caption" data-theme-note></p>
            </div>
          </section>

          <section class="profilo-section">
            <p class="overline profilo-label">Anno scolastico</p>
            <div class="card list"><div class="row profilo-year">
              <span class="row-icon">${icon("history")}</span>
              <div class="row-main"><p class="row-title">Anno visualizzato</p><p class="row-sub">Gli anni passati restano consultabili.</p></div>
              ${yearButton() || html`<span class="caption">${yearLabel()}</span>`}
            </div></div>
          </section>
        </div>

        <div class="profilo-col">
          <section class="profilo-section">
            <p class="overline profilo-label">Classifiche</p>
            <div class="card list" data-privacy>
              ${[["media", "Media generale"], ["assenze", "Ore di assenza"]].map(([k, t]) => html`<div class="row">
                <span class="row-icon">${icon(k === "media" ? "grades" : "absences")}</span>
                <div class="row-main"><p class="row-title">${t}</p><p class="row-sub" data-vis-sub="${k}">Caricamento…</p></div>
                <button type="button" class="switch" role="switch" aria-checked="true" aria-label="Mostrami nella classifica ${t}" data-vis="${k}" disabled></button>
              </div>`)}
            </div>
            <p class="caption profilo-note">Riguarda l'anno in corso. Se ti nascondi, nessuno vede la tua posizione; i singoli voti non sono mai condivisi.</p>
          </section>

          <section class="profilo-section">
            <p class="overline profilo-label">Account</p>
            <div class="card list">
              <a class="row" href="/dispositivi"><span class="row-icon">${icon("devices")}</span>
                <div class="row-main"><p class="row-title">Dispositivi</p><p class="row-sub">Collega un computer, scollega gli accessi</p></div>${icon("chevronRight", "chev")}</a>
              <a class="row" href="/classifica"><span class="row-icon">${icon("trophy")}</span>
                <div class="row-main"><p class="row-title">Classifica</p><p class="row-sub">La tua posizione in classe</p></div>${icon("chevronRight", "chev")}</a>
              ${s.is_admin ? html`<a class="row" href="/admin"><span class="row-icon">${icon("shield")}</span>
                <div class="row-main"><p class="row-title">Pannello admin</p><p class="row-sub">Classifiche, badge e annunci</p></div>${icon("chevronRight", "chev")}</a>` : ""}
            </div>
          </section>

          <section class="profilo-section">
            <p class="overline profilo-label">Informazioni</p>
            <div class="card list profilo-info">
              <div class="row"><span class="row-icon">${icon("info")}</span><div class="row-main"><p class="row-title">Progetto indipendente</p>
                <p class="row-sub">Aulera non è affiliato a ClasseViva né a Gruppo Spaggiari Parma.</p></div></div>
              <div class="row"><span class="row-icon">${icon("spid")}</span><div class="row-main"><p class="row-title">Accesso ufficiale</p>
                <p class="row-sub">Entri dalla pagina ufficiale di ClasseViva con SPID o CIE: le tue credenziali non passano da Aulera.</p></div></div>
              <div class="row"><span class="row-icon">${icon("lock")}</span><div class="row-main"><p class="row-title">Solo la sessione</p>
                <p class="row-sub">Aulera riceve solo la sessione temporanea di ClasseViva, che scade quando esci o dopo qualche ora.</p></div></div>
            </div>
            <p class="caption profilo-version tnum" data-version>Aulera · versione web ${WEB_VERSION}</p>
          </section>

          <button type="button" class="btn btn-danger btn-block btn-lg profilo-logout" data-logout>${icon("logout")}Esci</button>
        </div>
      </div>`);

    /* ---------- dati scolastici (card) ---------- */
    const cardBox = $("[data-card]", root);
    const drawCard = () => {
      const c = card || {};
      const school = titleCase([c.schName, c.schDedication].filter(Boolean).join(" "));
      const city = c.schCity ? `${titleCase(c.schCity)}${c.schProv ? ` (${String(c.schProv).toUpperCase()})` : ""}` : "";
      const rows = [
        ["Scuola", school],
        ["Città", city],
        ["Classe", s.class_code],
        ["Codice scuola", c.schCode || s.school_code],
        ["Data di nascita", c.birthDate ? fmtDate(c.birthDate, { year: true }) : ""],
        ["Codice utente", s.username],
      ].filter(([, v]) => v);
      setHTML(cardBox, html`<dl class="card list profilo-facts">${rows.map(([k, v]) => html`<div class="row"><dt class="row-sub">${k}</dt><dd class="row-title tnum">${v}</dd></div>`)}</dl>`);
      const sub = $("[data-hero-sub]", root);
      if (sub && school) sub.textContent = [s.class_code ? `Classe ${s.class_code}` : "", school].filter(Boolean).join(" · ");
    };
    load("card", () => post("/card"), (data) => { card = data?.card?.card || data?.card || null; drawCard(); }, { maxAge: 10 * 60_000 })
      .catch(() => { card = null; drawCard(); });

    /* ---------- tema ---------- */
    const themeNote = () => {
      const t = state.theme || "auto";
      const sys = matchMedia("(prefers-color-scheme: light)").matches ? "chiaro" : "scuro";
      root.querySelectorAll("[data-swatch]").forEach((b) => b.classList.toggle("is-active", b.dataset.swatch === t));
      $("[data-theme-note]", root).textContent = t === "auto" ? `Segue il sistema: ora è ${sys}.` : t === "light" ? "Sempre chiaro." : "Sempre scuro.";
    };
    themeNote();
    bindSegmented(root, "theme", (v) => { setTheme(v); themeNote(); });
    // Le anteprime sono scorciatoie del segmented (che resta il controllo accessibile).
    $(".profilo-theme-preview", root).addEventListener("click", (e) => {
      const b = e.target.closest("[data-swatch]");
      if (b) $(`[data-seg="theme"] button[data-value="${b.dataset.swatch}"]`, root)?.click();
    });

    /* ---------- anno ---------- */
    bindYearPicker(root, () => {
      const label = $("[data-year-picker] span", root);
      if (label) label.textContent = yearLabel();
    });

    /* ---------- visibilità classifiche ---------- */
    const privacy = $("[data-privacy]", root);
    const drawVis = () => {
      ["media", "assenze"].forEach((k) => {
        const sw = $(`[data-vis="${k}"]`, privacy), sub = $(`[data-vis-sub="${k}"]`, privacy);
        if (!vis) { sw.disabled = true; sub.textContent = "Non disponibile al momento"; return; }
        sw.disabled = false;
        sw.setAttribute("aria-checked", String(vis[k]));
        sub.textContent = vis[k] ? "Visibile agli altri studenti" : "Nascosto";
      });
    };
    loadVisibility().then((v) => { vis = v; drawVis(); }).catch(() => { vis = null; drawVis(); });
    privacy.addEventListener("click", async (e) => {
      const sw = e.target.closest("[data-vis]");
      if (!sw || sw.disabled || !vis) return;
      const k = sw.dataset.vis, next = !vis[k];
      sw.setAttribute("aria-checked", String(next));
      sw.disabled = true;
      try {
        await saveVisibility(k, next);
        vis[k] = next;
        toast(next ? "Ora compari in classifica" : "Non compari più in classifica");
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        drawVis();
      }
    });

    /* ---------- versione app nativa ---------- */
    const appInfo = window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.App?.getInfo : null;
    if (appInfo) {
      appInfo().then((info) => {
        if (info?.version) $("[data-version]", root).textContent = `Aulera ${info.version}${info.build ? ` (${info.build})` : ""} · web ${WEB_VERSION}`;
      }).catch(() => {});
    }

    /* ---------- esci ---------- */
    $("[data-logout]", root).addEventListener("click", () => {
      const sheet = openSheet({
        title: "Uscire da Aulera?",
        content: html`<p class="body-2">Per rientrare servirà di nuovo SPID o CIE. I computer collegati restano connessi finché non li scolleghi.</p>
          <div class="profilo-sheet-actions"><button type="button" class="btn" data-no>Annulla</button><button type="button" class="btn btn-danger" data-yes>${icon("logout")}Esci</button></div>`,
      });
      $("[data-no]", sheet.body).addEventListener("click", () => sheet.close());
      $("[data-yes]", sheet.body).addEventListener("click", (ev) => { ev.currentTarget.disabled = true; sheet.close(); logout(); });
    });

    return on("theme", themeNote);
  },
};
