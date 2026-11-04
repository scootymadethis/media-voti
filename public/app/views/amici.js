// Amici: codice amico (link/QR), richieste, elenco con media e tendenza, profilo condiviso,
// confronto "tu vs amico" e privacy (chiusa per default, eccezioni per singolo amico).
import { get, post, put, del, load, invalidate } from "aulera/api";
import { state } from "aulera/state";
import { html, raw, icon, setHTML, $, $$, ring, animateRings, gradeClass, fmtDate, relativeDay, subjectName, personName, initials, emptyState, errorState, segmented, bindSegmented, openSheet, openMenu, toast, fmtNum, staggerIndex } from "aulera/ui";
import { pageHeader } from "aulera/main";

/* ---------------- costanti e piccoli helper locali ---------------- */
const LEVELS = [
  { value: "none", short: "Niente", long: "Niente", text: "Solo nome e classe" },
  { value: "average", short: "Media", long: "Solo media generale", text: "Media generale e tendenza" },
  { value: "subjects", short: "Materie", long: "Medie per materia", text: "Media generale e medie per materia" },
  { value: "grades", short: "Voti", long: "Anche i singoli voti", text: "Medie e ultimi 30 voti" },
];
const RANK = { none: 0, average: 1, subjects: 2, grades: 3 };
const INCLUDES = [
  ["average", "Media generale e tendenza"],
  ["subjects", "Medie per materia"],
  ["grades", "Ultimi 30 voti"],
];
const levelOf = (v) => LEVELS.find((l) => l.value === v) || LEVELS[0];

// Icone che mancano nel set condiviso (stesso stile: tratto 1.7).
const EXTRA = {
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4M8 10.5H6.5A1.5 1.5 0 0 0 5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
  userPlus: '<circle cx="10" cy="8.5" r="3.6"/><path d="M3.5 19.5c1-3.4 3.4-5 6.5-5s5.5 1.6 6.5 5M18.5 7.5v6M15.5 10.5h6"/>',
  block: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  ellipsis: '<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
};
const ico = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA[name]}</svg>`);

// Colori dei badge decisi dall'admin: accettati solo #hex, rgb() e rgba().
const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\))$/i;
const safeColor = (v) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : null);
function badgeChips(list) {
  if (!list?.length) return "";
  return html`<span class="amici-badges">${list.map((b) => {
    const style = [["color", safeColor(b?.text_color)], ["background", safeColor(b?.background_color)], ["border-color", safeColor(b?.border_color)]]
      .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(";");
    return html`<span class="amici-badge" style="${style}">${b?.label || ""}</span>`;
  })}</span>`;
}

const nameOf = (p) => personName(p?.name || "") || "Studente";
const firstOf = (p) => nameOf(p).split(" ")[0];
const avatar = (p, cls = "") => html`<span class="amici-avatar ${cls}" aria-hidden="true">${initials(nameOf(p))}</span>`;
const avgPill = (v, cls = "") => html`<span class="grade ${cls} ${gradeClass(v)}">${v === null || v === undefined ? "—" : fmtNum(v, 2)}</span>`;

function trendChip(t) {
  if (t === null || t === undefined || Math.abs(t) < 0.05) return "";
  const up = t > 0;
  return html`<span class="chip ${up ? "chip-good" : "chip-bad"} amici-trend" aria-label="${up ? "In salita" : "In discesa"} di ${fmtNum(Math.abs(t), 2)}">${icon(up ? "arrowUp" : "arrowDown")}${fmtNum(Math.abs(t), 2)}</span>`;
}

function updatedText(ts) {
  if (!ts) return "Aggiornamento: data sconosciuta";
  const d = new Date(ts * 1000);
  const rel = relativeDay(d);
  const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return ["Oggi", "Ieri"].includes(rel) ? `Aggiornato ${rel.toLowerCase()} alle ${time}` : `Aggiornato il ${fmtDate(d)}`;
}
function shortUpdated(ts) {
  if (!ts) return "data sconosciuta";
  const d = new Date(ts * 1000);
  const rel = relativeDay(d);
  if (rel === "Oggi") return `oggi ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
  return rel === "Ieri" ? "ieri" : fmtDate(d);
}
function sinceText(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `Amici dal ${fmtDate(d, { year: d.getFullYear() !== new Date().getFullYear() })}`;
}
function agoText(ts) {
  if (!ts) return "";
  const rel = relativeDay(new Date(ts * 1000));
  return rel === "Oggi" || rel === "Ieri" ? rel.toLowerCase() : `il ${fmtDate(new Date(ts * 1000))}`;
}

const shareBase = () => {
  const b = window.APP_CONFIG?.HTTP_BASE;
  return b && /^https?:\/\//.test(b) ? b : location.origin;
};
const inviteLink = (code) => `${shareBase()}/amici?aggiungi=${encodeURIComponent(code)}`;

function formatTyped(v) {
  const s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback sotto */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Conferma in un pannello (niente confirm() di sistema). */
function confirmSheet({ title, text, confirm, danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const sheet = openSheet({
      title,
      content: html`<p class="body-2">${text}</p>
        <div class="amici-confirm"><button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"} btn-block btn-lg" data-yes>${confirm}</button>
        <button type="button" class="btn btn-block btn-lg" data-no>Annulla</button></div>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $("[data-yes]", sheet.body).addEventListener("click", () => { done = true; resolve(true); sheet.close(); });
    $("[data-no]", sheet.body).addEventListener("click", () => sheet.close());
  });
}

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    let data = null;
    let alive = true;

    setHTML(root, html`
      ${pageHeader({
        eyebrow: "Community",
        title: "Amici",
        subtitle: "Confrontati con chi vuoi tu. Sei tu a decidere cosa vedono.",
        actions: html`<button type="button" class="btn btn-primary" data-add>${ico("userPlus")}Aggiungi</button>`,
      })}
      <div data-body>
        <div class="amici-layout">
          <div class="amici-hero-slot"><div class="card card-pad"><div class="skeleton-line" style="width:40%"></div><div class="skeleton" style="height:56px;margin-top:14px"></div></div></div>
          <div class="amici-main">${raw('<div class="card list">' + '<div class="row"><div class="skeleton" style="width:44px;height:44px;border-radius:50%"></div><div class="row-main stack-sm"><div class="skeleton-line" style="width:55%"></div><div class="skeleton-line" style="width:35%;height:11px"></div></div></div>'.repeat(3) + "</div>")}</div>
        </div>
      </div>`);
    $("[data-add]", root).addEventListener("click", () => openAddSheet());

    const refresh = async () => {
      invalidate("amici");
      await fetchData();
    };

    const fetchData = async () => {
      const body = $("[data-body]", root);
      try {
        await load("amici", () => get("/friends"), (d) => { if (alive) { data = d; draw(); } }, { maxAge: 0 });
      } catch (err) {
        if (!alive) return;
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", fetchData);
      }
    };

    /* ---------- disegno principale ---------- */
    const draw = () => {
      const body = $("[data-body]", root);
      const { me, friends, incoming, outgoing, blocked, limits } = data;
      const level = levelOf(me.privacy);
      setHTML(body, html`
        <div class="amici-layout ${friends.length || incoming.length ? "has-friends" : ""}">
          <section class="card amici-hero">
            <div class="amici-hero-top">
              <div class="row-main">
                <p class="overline">Il tuo codice amico</p>
                <p class="amici-code" data-code>${me.code}</p>
              </div>
              <button type="button" class="amici-qr-mini pressable" data-qr aria-label="Mostra il QR del tuo codice">${icon("qr")}</button>
            </div>
            <p class="caption">Chi ha il tuo codice può chiederti l'amicizia. Vede i tuoi voti solo se scegli di condividerli.</p>
            <div class="amici-hero-actions">
              <button type="button" class="btn btn-primary" data-share>${ico("share")}Condividi codice</button>
              <button type="button" class="btn" data-qr>${icon("qr")}Mostra QR</button>
            </div>
            <a class="amici-sharing pressable" href="#amici-privacy" data-goto-privacy>
              <span class="amici-sharing-icon ${me.privacy === "none" ? "" : "is-on"}">${icon(me.privacy === "none" ? "lock" : "eye")}</span>
              <span class="row-main"><span class="caption">Condividi con gli amici</span><span class="amici-sharing-val">${level.long}</span></span>
              ${icon("chevronRight", "chev")}
            </a>
          </section>

          <div class="amici-main">
            ${incoming.length ? html`<section class="amici-section">
              <div class="section-head"><h2 class="title-2">Richieste</h2><span class="chip chip-accent">${incoming.length}</span></div>
              <ul class="card list">${incoming.map((r) => html`<li class="row amici-req" data-req="${r.id}">
                ${avatar(r)}
                <div class="row-main"><p class="row-title">${nameOf(r)} ${badgeChips(r.badges)}</p>
                  <p class="row-sub">${[r.class_code ? `Classe ${r.class_code}` : "", agoText(r.created_at)].filter(Boolean).join(" · ")}</p></div>
                <div class="amici-req-actions">
                  <button type="button" class="btn btn-icon amici-act" data-req-more aria-label="Altre azioni">${ico("ellipsis")}</button>
                  <button type="button" class="btn btn-icon amici-act" data-decline aria-label="Rifiuta">${icon("close")}</button>
                  <button type="button" class="btn btn-primary btn-icon amici-act" data-accept aria-label="Accetta">${icon("check")}</button>
                </div>
              </li>`)}</ul>
            </section>` : ""}

            <section class="amici-section">
              <div class="section-head"><h2 class="title-2">I tuoi amici</h2>${friends.length ? html`<span class="caption tnum">${friends.length} di ${limits.friends}</span>` : ""}</div>
              ${friends.length ? html`<ul class="card list amici-list stagger">${friends.map((f, i) => {
                const shares = f.shares !== "none";
                const sub = !shares ? "Non condivide i voti" : !f.has_data ? "Nessun voto salvato" : shortUpdated(f.updated_at);
                return html`<li><button type="button" class="row amici-friend" data-friend="${i}">
                  ${avatar(f)}
                  <div class="row-main"><p class="row-title"><span class="amici-name">${nameOf(f)}</span>${badgeChips(f.badges?.slice(0, 2))}</p>
                    <p class="row-sub">${f.class_code ? `${f.class_code} · ` : ""}${sub}</p></div>
                  <span class="row-trail">${shares && f.has_data ? html`${trendChip(f.trend)}${avgPill(f.general_average, "grade-sm")}` : shares ? "" : icon("lock", "amici-lock")}${icon("chevronRight", "chev")}</span>
                </button></li>`;
              })}</ul>` : html`<div class="card amici-empty">${emptyState({ iconName: "friends", title: "Ancora nessun amico", text: "Condividi il tuo codice o cerca i compagni della tua classe." })}
                <div class="amici-empty-actions"><button type="button" class="btn btn-primary" data-add-empty>${ico("userPlus")}Aggiungi un amico</button></div></div>`}
            </section>

            ${outgoing.length ? html`<section class="amici-section">
              <div class="section-head"><h2 class="title-3 muted">In attesa di risposta</h2><span class="caption tnum">${outgoing.length} di ${limits.pending}</span></div>
              <ul class="card list">${outgoing.map((r) => html`<li class="row" data-out="${r.id}">
                ${avatar(r, "is-muted")}
                <div class="row-main"><p class="row-title">${nameOf(r)}</p><p class="row-sub">Richiesta inviata ${agoText(r.created_at)}</p></div>
                <button type="button" class="btn btn-ghost" data-cancel>Annulla</button>
              </li>`)}</ul>
            </section>` : ""}
          </div>

          <section class="amici-privacy" id="amici-privacy">
            <div class="section-head"><h2 class="title-2">Cosa vedono i tuoi amici</h2></div>
            <div class="card card-pad stack">
              ${segmented("privacy", LEVELS.map((l) => ({ value: l.value, label: l.short })), me.privacy)}
              <ul class="amici-includes" data-includes>${includesList(me.privacy)}</ul>
              <p class="caption">Vale per tutti gli amici, tranne le eccezioni che imposti nel profilo di ciascuno. Le note dei docenti non vengono mai condivise.</p>
              <button type="button" class="btn btn-block" data-preview>${icon("eye")}Guarda come ti vedono</button>
            </div>
            ${!me.has_snapshot ? html`<p class="caption amici-note">${icon("info")}Non hai ancora voti salvati: apri <a class="link" href="/voti">Voti</a> per renderli visibili agli amici.</p>` : html`<p class="caption amici-note">${icon("history")}I tuoi amici vedono i voti salvati l'ultima volta che hai aperto Skoolio (${updatedText(me.updated_at).toLowerCase()}).</p>`}
            ${blocked.length ? html`<div class="amici-blocked">
              <p class="overline amici-label">Bloccati</p>
              <ul class="card list">${blocked.map((b) => html`<li class="row" data-blocked="${b.code}">
                ${avatar(b, "is-muted")}<div class="row-main"><p class="row-title">${nameOf(b)}</p><p class="row-sub">Non può trovarti né scriverti</p></div>
                <button type="button" class="btn btn-ghost" data-unblock>Sblocca</button></li>`)}</ul></div>` : ""}
          </section>
        </div>`);
      staggerIndex(body);
      bind(body);
    };

    const includesList = (lvl) => INCLUDES.map(([k, label]) => {
      const on = RANK[lvl] >= RANK[k];
      return html`<li class="${on ? "is-on" : ""}"><span class="amici-inc-icon">${icon(on ? "check" : "minus")}</span><span>${label}</span></li>`;
    });

    /* ---------- eventi ---------- */
    const bind = (body) => {
      const { me } = data;
      $$("[data-qr]", body).forEach((b) => b.addEventListener("click", () => openQrSheet(me)));
      $("[data-share]", body)?.addEventListener("click", () => shareCode(me));
      $("[data-add-empty]", body)?.addEventListener("click", () => openAddSheet());
      $("[data-goto-privacy]", body)?.addEventListener("click", (e) => {
        e.preventDefault();
        $("#amici-privacy", body)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      });
      $("[data-preview]", body)?.addEventListener("click", () => openPreview());

      bindSegmented(body, "privacy", async (v) => {
        const prev = data.me.privacy;
        setHTML($("[data-includes]", body), html`${includesList(v)}`);
        try {
          await put("/friends/privacy", { level: v });
          data.me.privacy = v;
          toast(v === "none" ? "Non condividi più i voti con gli amici" : `Ora gli amici vedono: ${levelOf(v).text.toLowerCase()}`);
          invalidate("amici");
          draw();
        } catch (err) {
          toast(err.message, { error: true });
          data.me.privacy = prev;
          draw();
        }
      });

    };

    const act = async (fn, okMsg) => {
      try {
        await fn();
        if (okMsg) toast(okMsg);
      } catch (err) {
        toast(err.message, { error: true });
      }
      await refresh();
    };

    /* ---------- condividi / QR ---------- */
    const shareCode = async (me) => {
      const url = inviteLink(me.code);
      const text = `Aggiungimi su Skoolio: il mio codice è ${me.code}`;
      if (navigator.share) {
        try { await navigator.share({ title: "Skoolio", text, url }); return; } catch (err) { if (err?.name === "AbortError") return; }
      }
      toast((await copyText(`${text}\n${url}`)) ? "Codice e link copiati" : "Impossibile copiare il codice", { error: false });
    };

    const openQrSheet = (me) => {
      const url = inviteLink(me.code);
      const sheet = openSheet({
        title: "Il tuo QR",
        content: html`<div class="amici-qr-wrap">
          <div class="amici-qr" data-qr-box aria-label="QR del codice ${me.code}" role="img"></div>
          <p class="amici-code amici-code-lg">${me.code}</p>
          <p class="caption">Fallo inquadrare con la fotocamera: si apre Skoolio con la richiesta pronta da inviare.</p>
          <div class="amici-hero-actions amici-qr-actions">
            <button type="button" class="btn" data-copy-link>${ico("copy")}Copia link</button>
            <button type="button" class="btn btn-primary" data-share-qr>${ico("share")}Condividi</button>
          </div></div>`,
      });
      const box = $("[data-qr-box]", sheet.body);
      if (typeof window.qrcode === "function") {
        const qr = window.qrcode(0, "M");
        qr.addData(url);
        qr.make();
        box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // SVG generato localmente
      } else box.hidden = true;
      $("[data-copy-link]", sheet.body).addEventListener("click", async () => toast((await copyText(url)) ? "Link copiato" : "Impossibile copiare il link", { error: false }));
      $("[data-share-qr]", sheet.body).addEventListener("click", () => shareCode(me));
    };

    /* ---------- aggiungi: codice o ricerca nella classe ---------- */
    const openAddSheet = (prefill = "") => {
      const sheet = openSheet({
        title: "Aggiungi un amico",
        content: html`
          <form class="amici-add-form" data-code-form novalidate>
            <label class="overline amici-label" for="amici-code-input">Codice amico</label>
            <div class="amici-code-row">
              <input id="amici-code-input" class="field amici-code-field" data-code-input inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="9" placeholder="K7PQ-4XZ2" value="${formatTyped(prefill)}" enterkeyhint="go" />
              <button type="submit" class="btn btn-primary" data-code-submit>Avanti</button>
            </div>
            <p class="caption amici-code-msg" data-code-msg aria-live="polite">Lo trovi nella sezione Amici del tuo compagno.</p>
          </form>
          <div class="amici-or" aria-hidden="true"><span>oppure</span></div>
          <p class="overline amici-label">Cerca nella tua classe</p>
          <label class="search">${icon("search")}<input class="field" type="search" data-search placeholder="Nome o cognome" aria-label="Cerca un compagno di classe" autocomplete="off" enterkeyhint="search" /></label>
          <div data-results class="amici-results"><p class="caption amici-hint">Trovi i compagni della tua classe che compaiono nella classifica.</p></div>`,
      });
      const form = $("[data-code-form]", sheet.body);
      const input = $("[data-code-input]", sheet.body);
      const msg = $("[data-code-msg]", sheet.body);
      input.addEventListener("input", () => {
        const pos = input.selectionStart === input.value.length;
        input.value = formatTyped(input.value);
        if (pos) input.setSelectionRange(input.value.length, input.value.length);
        msg.classList.remove("is-error");
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = formatTyped(input.value);
        if (code.replace("-", "").length !== 8) {
          msg.textContent = "Il codice ha 8 caratteri, per esempio K7PQ-4XZ2.";
          msg.classList.add("is-error");
          input.focus();
          return;
        }
        const btn = $("[data-code-submit]", sheet.body);
        btn.disabled = true;
        try {
          const res = await post("/friends/lookup", { code });
          sheet.close();
          confirmAdd(res);
        } catch (err) {
          msg.textContent = err.message;
          msg.classList.add("is-error");
        } finally { btn.disabled = false; }
      });

      const results = $("[data-results]", sheet.body);
      const search = $("[data-search]", sheet.body);
      let timer = null;
      let seq = 0;
      const runSearch = async () => {
        const q = search.value.trim();
        const my = ++seq;
        if (q.length < 2) {
          setHTML(results, html`<p class="caption amici-hint">Trovi i compagni della tua classe che compaiono nella classifica.</p>`);
          return;
        }
        try {
          const res = await get(`/friends/search?q=${encodeURIComponent(q)}`);
          if (my !== seq) return;
          if (res.reason === "no_class") {
            setHTML(results, html`<p class="caption amici-hint">Non conosciamo ancora la tua classe: usa il codice del tuo compagno.</p>`);
            return;
          }
          if (!res.items.length) {
            setHTML(results, html`<p class="caption amici-hint">Nessun compagno con questo nome. Forse non è in classifica: chiedigli il codice.</p>`);
            return;
          }
          setHTML(results, html`<ul class="card list">${res.items.map((p) => html`<li class="row" data-code="${p.code}">
            ${avatar(p)}<div class="row-main"><p class="row-title">${nameOf(p)}</p><p class="row-sub">Classe ${p.class_code}</p></div>
            ${searchAction(p.status)}</li>`)}</ul>`);
        } catch (err) {
          if (my === seq) setHTML(results, html`<p class="caption amici-hint is-error">${err.message}</p>`);
        }
      };
      search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 250); });
      results.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-send]");
        if (!b) return;
        const row = b.closest("[data-code]");
        b.disabled = true;
        try {
          const res = await post("/friends/requests", { code: row.dataset.code });
          const chip = document.createElement("span");
          chip.className = res.status === "friend" ? "chip chip-good" : "chip";
          chip.textContent = res.status === "friend" ? "Amici" : "Inviata";
          b.replaceWith(chip);
          toast(res.status === "friend" ? `Tu e ${firstOf(res.person)} ora siete amici` : `Richiesta inviata a ${firstOf(res.person)}`);
          refresh();
        } catch (err) {
          b.disabled = false;
          toast(err.message, { error: true });
        }
      });
      if (!prefill) setTimeout(() => input.focus({ preventScroll: true }), 350);
    };

    const searchAction = (status) => {
      if (status === "friend") return html`<span class="chip chip-good">Amici</span>`;
      if (status === "outgoing") return html`<span class="chip">Inviata</span>`;
      if (status === "incoming") return html`<button type="button" class="btn btn-primary amici-send" data-send>Accetta</button>`;
      if (status === "blocked") return html`<span class="chip">Bloccato</span>`;
      return html`<button type="button" class="btn amici-send" data-send>${icon("plus")}Aggiungi</button>`;
    };

    /** Conferma con nome e classe prima di inviare la richiesta (codice o link/QR). */
    const confirmAdd = ({ person, status }) => {
      const first = firstOf(person);
      const states = {
        self: ["Questo è il tuo codice", "Condividilo con i compagni che vuoi aggiungere."],
        friend: [`Tu e ${first} siete già amici`, ""],
        outgoing: ["Richiesta già inviata", `Aspetta che ${first} la accetti.`],
        blocked: [`Hai bloccato ${first}`, "Sbloccalo in fondo alla pagina Amici per aggiungerlo."],
      };
      const info = states[status];
      const sheet = openSheet({
        title: "Aggiungi un amico",
        content: html`<div class="amici-confirm-person">
            ${avatar(person, "lg")}
            <p class="title-2">${nameOf(person)}</p>
            <p class="body-2">${person.class_code ? `Classe ${person.class_code}` : "Studente"}</p>
            ${badgeChips(person.badges)}
          </div>
          ${info ? html`<div class="amici-confirm-info"><p class="title-3">${info[0]}</p>${info[1] ? html`<p class="caption">${info[1]}</p>` : ""}</div>
            <button type="button" class="btn btn-block btn-lg" data-ok>${status === "friend" ? "Apri il profilo" : "Ok"}</button>`
          : html`<p class="caption amici-confirm-note">${status === "incoming" ? `${first} ti ha già chiesto l'amicizia: inviandola diventerete subito amici.` : `${first} riceverà la tua richiesta. Finché non accetta, nessuno dei due vede i voti dell'altro.`}</p>
            <button type="button" class="btn btn-primary btn-block btn-lg" data-send-req>${ico("userPlus")}${status === "incoming" ? "Accetta l'amicizia" : "Invia richiesta"}</button>`}`,
      });
      $("[data-ok]", sheet.body)?.addEventListener("click", () => { sheet.close(); if (status === "friend") openFriend(person.code); });
      $("[data-send-req]", sheet.body)?.addEventListener("click", async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          const res = await post("/friends/requests", { code: person.code });
          sheet.close();
          toast(res.status === "friend" ? `Tu e ${first} ora siete amici` : `Richiesta inviata a ${first}`);
          refresh();
        } catch (err) {
          b.disabled = false;
          toast(err.message, { error: true });
        }
      });
    };

    /* ---------- anteprima: come mi vedono ---------- */
    const openPreview = async () => {
      try {
        const res = await get("/friends/preview");
        const sheet = openSheet({ title: "Come ti vedono", content: html`<p class="caption amici-preview-note">${icon("eye")}Anteprima di quello che vedono i tuoi amici adesso.</p>${sharedProfile(res.person, res.shared, null, true)}` });
        animateRings(sheet.body);
      } catch (err) { toast(err.message, { error: true }); }
    };

    /* ---------- profilo condiviso di un amico ---------- */
    const sharedProfile = (person, shared, comparison, self = false) => {
      const first = self ? "Tu" : firstOf(person);
      const head = html`<div class="amici-person">
        ${avatar(person, "lg")}
        <div class="stack-sm row-main">
          <p class="title-2">${nameOf(person)}</p>
          <p class="body-2">${[person.class_code ? `Classe ${person.class_code}` : "", sinceText(person.since)].filter(Boolean).join(" · ")}</p>
          ${badgeChips(person.badges)}
        </div></div>`;
      if (shared.level === "none") {
        return html`${head}<div class="card">${emptyState({ iconName: "lock", title: self ? "Non condividi niente" : `${first} non condivide i voti`, text: self ? "I tuoi amici vedono solo nome e classe. Scegli cosa condividere in fondo alla pagina Amici." : "Vedi solo nome e classe. Può scegliere di condividere la media o i voti nelle impostazioni di Amici." })}</div>`;
      }
      if (!shared.has_data) {
        return html`${head}<div class="card">${emptyState({ iconName: "grades", title: "Nessun voto salvato", text: self ? "Apri la sezione Voti: da quel momento gli amici vedranno i tuoi dati." : `I voti compariranno quando ${first} aprirà Skoolio.` })}</div>`;
      }
      const lvl = levelOf(shared.level);
      return html`${head}
        <section class="card card-pad amici-summary">
          ${ring(shared.general_average, { size: 112, stroke: 10, sub: "media" })}
          <div class="stack-sm row-main">
            <p class="overline">Media generale</p>
            <div class="hstack amici-summary-chips">${trendChip(shared.trend) || html`<span class="chip">Stabile</span>`}${shared.count ? html`<span class="chip">${shared.count} voti</span>` : ""}</div>
            <p class="caption">${updatedText(shared.updated_at)}</p>
          </div>
        </section>
        ${comparison ? compareBlock(comparison, first) : shared.subjects ? html`<section class="amici-block">
          <p class="overline amici-label">Medie per materia</p>
          <ul class="card list">${shared.subjects.map((s) => html`<li class="row"><div class="row-main"><p class="row-title">${subjectName(s.name)}</p>
            <p class="row-sub">${s.count} ${s.count === 1 ? "voto" : "voti"}</p></div>${avgPill(s.average, "grade-sm")}</li>`)}</ul>
        </section>` : ""}
        ${shared.grades ? html`<section class="amici-block">
          <p class="overline amici-label">Ultimi voti</p>
          <ul class="card list">${shared.grades.map((g) => html`<li class="row">
            <span class="grade ${g.counted ? gradeClass(g.value) : "g-none"}">${g.display}</span>
            <div class="row-main"><p class="row-title">${subjectName(g.subject)}</p>
              <p class="row-sub">${[relativeDay(g.date), g.component, g.counted ? "" : "non fa media"].filter(Boolean).join(" · ")}</p></div></li>`)}</ul>
        </section>` : ""}
        ${RANK[shared.level] < 3 ? html`<p class="caption amici-level-note">${icon("lock")}${self ? "Condividi" : `${first} condivide`}: ${lvl.text.toLowerCase()}.</p>` : ""}`;
    };

    const compareBlock = (cmp, first) => {
      const bar = (v, who) => html`<span class="amici-bar ${who}"><span style="transform:scaleX(${v === null || v === undefined ? 0 : Math.max(0.03, Math.min(1, v / 10))})"></span></span>`;
      const val = (v) => html`<span class="amici-cmp-val tnum">${v === null || v === undefined ? "—" : fmtNum(v, 2)}</span>`;
      return html`<section class="amici-block">
        <div class="spread amici-label-row"><p class="overline">Tu e ${first}</p>
          <span class="amici-legend"><span class="is-me">Tu</span><span class="is-friend">${first}</span></span></div>
        <div class="card card-pad amici-compare">
          <div class="amici-cmp-head">
            <div><p class="caption">Tu</p><p class="amici-cmp-big tnum is-me">${fmtNum(cmp.me, 2)}</p></div>
            <div class="amici-cmp-vs caption">media generale</div>
            <div class="end"><p class="caption">${first}</p><p class="amici-cmp-big tnum is-friend">${fmtNum(cmp.friend, 2)}</p></div>
          </div>
          <ul class="amici-cmp-list">${cmp.subjects.map((s) => html`<li>
            <p class="amici-cmp-name">${subjectName(s.name)}</p>
            <div class="amici-cmp-line">${bar(s.me, "is-me")}${val(s.me)}</div>
            <div class="amici-cmp-line">${bar(s.friend, "is-friend")}${val(s.friend)}</div>
          </li>`)}</ul>
        </div>
      </section>`;
    };

    const openFriend = async (code) => {
      const body = document.createElement("div");
      setHTML(body, html`<div class="amici-person"><div class="skeleton" style="width:64px;height:64px;border-radius:50%"></div><div class="row-main stack-sm"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div></div>
        <div class="card card-pad"><div class="skeleton" style="height:112px"></div></div>`);
      const sheet = openSheet({ title: "Amico", content: body });
      const titleEl = $(".sheet-head .title-2", sheet.el);
      let detail;
      const drawDetail = () => {
        const p = detail.person;
        const first = firstOf(p);
        if (titleEl) titleEl.textContent = first;
        const mine = detail.my_override ? levelOf(detail.my_override).long : `Come per tutti · ${levelOf(detail.my_global).long}`;
        setHTML(body, html`${sharedProfile(p, detail.shared, detail.comparison)}
          ${!detail.comparison && RANK[detail.shared.level] >= 2 && RANK[detail.my_level] < 2 ? html`<p class="caption amici-level-note">${icon("info")}Condividi anche tu le medie per materia con ${first} per confrontarvi.</p>` : ""}
          <section class="amici-block">
            <p class="overline amici-label">Cosa vede ${first} di te</p>
            <div class="card list">
              <button type="button" class="row" data-my-level>
                <span class="row-icon">${icon(detail.my_level === "none" ? "lock" : "eye")}</span>
                <div class="row-main"><p class="row-title">${levelOf(detail.my_level).text}</p><p class="row-sub">${mine}</p></div>
                ${icon("chevronDown", "chev")}
              </button>
            </div>
          </section>
          <div class="amici-danger">
            <button type="button" class="btn btn-danger" data-remove>Rimuovi amico</button>
            <button type="button" class="btn btn-ghost amici-block-btn" data-block>${ico("block")}Blocca</button>
          </div>`);
        animateRings(body);
      };
      const reload = async () => {
        try {
          detail = await get(`/friends/${encodeURIComponent(code)}`);
          drawDetail();
        } catch (err) {
          setHTML(body, errorState(err));
          $("[data-retry]", body)?.addEventListener("click", reload);
        }
      };
      body.addEventListener("click", async (e) => {
        if (!detail) return;
        const first = firstOf(detail.person);
        const lv = e.target.closest("[data-my-level]");
        if (lv) {
          const items = [{ value: "inherit", label: `Come per tutti (${levelOf(detail.my_global).short})`, checked: !detail.my_override },
            ...LEVELS.map((l) => ({ value: l.value, label: l.long, checked: detail.my_override === l.value }))];
          return openMenu(lv, items, async (v) => {
            try {
              await put(`/friends/${encodeURIComponent(code)}/privacy`, { level: v === "inherit" ? null : v });
              invalidate("amici");
              await reload();
              toast(v === "inherit" ? `${first} vede quello che vedono tutti` : `${first} ora vede: ${levelOf(v).text.toLowerCase()}`);
              fetchData();
            } catch (err) { toast(err.message, { error: true }); }
          });
        }
        if (e.target.closest("[data-remove]")) {
          if (!(await confirmSheet({ title: `Rimuovere ${first}?`, text: "Non vedrete più i dati dell'altro. Potrete tornare amici con una nuova richiesta.", confirm: "Rimuovi" }))) return;
          try { await del(`/friends/${encodeURIComponent(code)}`); sheet.close(); toast(`${first} rimosso dagli amici`); } catch (err) { toast(err.message, { error: true }); }
          return refresh();
        }
        if (e.target.closest("[data-block]")) {
          if (!(await confirmSheet({ title: `Bloccare ${first}?`, text: "Smetterete di essere amici e non potrà più trovarti né inviarti richieste. Puoi sbloccarlo quando vuoi.", confirm: "Blocca" }))) return;
          try { await post("/friends/blocks", { code }); sheet.close(); toast(`${first} è bloccato`); } catch (err) { toast(err.message, { error: true }); }
          return refresh();
        }
      });
      reload();
    };

    // Delega una sola volta sul contenitore: legge sempre i dati correnti.
    $("[data-body]", root).addEventListener("click", async (e) => {
      if (!data) return;
      const { friends, incoming } = data;
      const fr = e.target.closest("[data-friend]");
      if (fr) return openFriend(friends[Number(fr.dataset.friend)].code);
      const req = e.target.closest("[data-req]");
      if (req) {
        const r = incoming.find((x) => String(x.id) === req.dataset.req);
        if (e.target.closest("[data-accept]")) return act(() => post(`/friends/requests/${r.id}/accept`), `Tu e ${firstOf(r)} ora siete amici`);
        if (e.target.closest("[data-decline]")) return act(() => post(`/friends/requests/${r.id}/decline`), "Richiesta rifiutata");
        const more = e.target.closest("[data-req-more]");
        if (more) {
          return openMenu(more, [{ value: "block", label: `Blocca ${firstOf(r)}` }], async () => {
            if (await confirmSheet({ title: `Bloccare ${firstOf(r)}?`, text: "Non potrà più trovarti né inviarti richieste. Puoi sbloccarlo quando vuoi.", confirm: "Blocca" })) {
              act(() => post("/friends/blocks", { code: r.code }), `${firstOf(r)} è bloccato`);
            }
          });
        }
        return;
      }
      const out = e.target.closest("[data-out]");
      if (out && e.target.closest("[data-cancel]")) {
        return act(() => del(`/friends/requests/${out.dataset.out}`), "Richiesta annullata");
      }
      const bl = e.target.closest("[data-blocked]");
      if (bl && e.target.closest("[data-unblock]")) {
        return act(() => del(`/friends/blocks/${encodeURIComponent(bl.dataset.blocked)}`), "Sbloccato");
      }
    });

    /* ---------- avvio ---------- */
    await fetchData();

    // Link/QR: /amici?aggiungi=CODICE → conferma con nome prima di inviare.
    const toAdd = ctx?.params?.get("aggiungi");
    if (toAdd) {
      history.replaceState({}, "", "/amici");
      try {
        confirmAdd(await post("/friends/lookup", { code: toAdd }));
      } catch (err) {
        toast(err.message, { error: true });
        openAddSheet(toAdd);
      }
    }

    // I dati che vedono gli amici sono quelli salvati da /voti: li aggiorno in sottofondo.
    const cur = state.years?.current;
    if (cur) {
      load(`voti:${cur}`, () => post(`/voti?school_year=${encodeURIComponent(cur)}`), () => {}, { maxAge: 300_000 })
        .then(() => { if (alive && data && !data.me.has_snapshot) refresh(); })
        .catch(() => {});
    }

    return () => { alive = false; };
  },
};
