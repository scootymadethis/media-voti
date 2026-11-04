// Dispositivi: collega un PC dal telefono (QR o codice) e gestisci gli accessi attivi.
import { get, post } from "aulera/api";
import { html, icon, setHTML, $, emptyState, errorState, openSheet, toast, fmtDate } from "aulera/ui";
import { pageHeader } from "aulera/main";

const ALPHABET = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g; // stesso alfabeto del server (niente 0/O/1/I)

function normalizeCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(ALPHABET, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
// Il QR contiene https://<sito>/collega?code=XXXX-XXXX (o, al limite, solo il codice).
function codeFromScan(text) {
  try {
    const code = new URL(text).searchParams.get("code");
    if (code) return normalizeCode(code);
  } catch { /* non è un URL */ }
  return normalizeCode(text);
}
const isPhoneLabel = (label) => /android|iphone|ipad|app aulera/i.test(label || "");
const clock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
function lastSeen(epoch) {
  if (!epoch) return "";
  const diff = Math.max(0, Date.now() / 1000 - epoch);
  if (diff < 90) return "attivo ora";
  if (diff < 3600) return `attivo ${Math.round(diff / 60)} min fa`;
  const d = new Date(epoch * 1000), today = new Date();
  if (d.toDateString() === today.toDateString()) return `attivo alle ${clock(epoch)}`;
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `attivo ieri alle ${clock(epoch)}`;
  return `attivo il ${fmtDate(d)}`;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;

export default {
  async render(root, ctx) {
    const scanner = window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.BarcodeScanner : null;
    const site = (window.APP_CONFIG?.HTTP_BASE || location.origin).replace(/^https?:\/\//, "");
    let pending = null; // { code, label, requestedAt, expiresAt }
    let countdown = null;
    let devices = [];
    let refreshTimers = [];

    setHTML(root, html`
      ${pageHeader({ eyebrow: "Account", title: "Dispositivi", subtitle: "Collega un computer al tuo account e controlla dove sei connesso." })}
      <div class="dispositivi-layout">
        <section class="card card-pad dispositivi-link" data-link aria-live="polite"></section>
        <section class="dispositivi-devices">
          <div class="section-head"><p class="overline">Dispositivi connessi</p><button type="button" class="btn btn-ghost dispositivi-refresh" data-refresh aria-label="Aggiorna l'elenco">${icon("refresh")}</button></div>
          <div data-devices></div>
        </section>
      </div>`);
    const linkBox = $("[data-link]", root), listBox = $("[data-devices]", root);

    /* ---------- collegamento ---------- */
    const stopCountdown = () => { clearInterval(countdown); countdown = null; };

    function drawIdle(message = "", tone = "") {
      stopCountdown();
      pending = null;
      setHTML(linkBox, html`
        <div class="dispositivi-intro">
          <span class="dispositivi-hero-icon" aria-hidden="true">${icon("devices")}</span>
          <div><h2 class="title-2">Collega un computer</h2>
            <p class="body-2">Sul PC apri <strong>${site}</strong> e scegli <strong>Accedi tramite telefono</strong>: comparirà un QR con un codice.</p></div>
        </div>
        ${scanner ? html`<button type="button" class="btn btn-primary btn-lg btn-block" data-scan>${icon("qr")}Inquadra il QR</button>
          <p class="dispositivi-or caption"><span>oppure scrivi il codice</span></p>` : ""}
        <form class="dispositivi-form" data-form novalidate>
          <label class="sr-only" for="pair-code">Codice di collegamento</label>
          <input id="pair-code" class="field dispositivi-code tnum" data-code type="text" inputmode="text" autocapitalize="characters"
            autocomplete="one-time-code" autocorrect="off" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" enterkeyhint="go" />
          <button type="submit" class="btn ${scanner ? "" : "btn-primary"}" data-submit disabled>Continua</button>
        </form>
        <p class="caption dispositivi-msg${tone ? ` is-${tone}` : ""}" data-msg role="status">${message || "Il codice ha 8 caratteri e vale pochi minuti."}</p>`);
      const input = $("[data-code]", linkBox), submit = $("[data-submit]", linkBox);
      input.addEventListener("input", () => {
        const pos = input.selectionStart, before = input.value.length;
        input.value = normalizeCode(input.value);
        const after = input.value.length;
        try { input.setSelectionRange(pos + (after - before), pos + (after - before)); } catch { /* niente */ }
        submit.disabled = input.value.length !== 9;
        if (input.value.length === 9 && !scanner) submit.focus({ preventScroll: true });
      });
      $("[data-form]", linkBox).addEventListener("submit", (e) => {
        e.preventDefault();
        const code = normalizeCode(input.value);
        if (code.length !== 9) return setMsg("Il codice ha 8 caratteri, ad esempio K7PQ-4XZ2.", "warn");
        lookup(code);
      });
      $("[data-scan]", linkBox)?.addEventListener("click", scan);
    }
    const setMsg = (text, tone = "") => {
      const el = $("[data-msg]", linkBox);
      if (!el) return;
      el.textContent = text;
      el.className = `caption dispositivi-msg${tone ? ` is-${tone}` : ""}`;
    };

    async function lookup(code) {
      const submit = $("[data-submit]", linkBox);
      if (submit) { submit.disabled = true; submit.textContent = "Verifico…"; }
      setMsg("Verifico il codice…");
      try {
        const data = await post("/pair/lookup", { code });
        pending = { code, label: data.device_label || "un computer", requestedAt: data.requested_at, expiresAt: Date.now() + (data.expires_in || 0) * 1000 };
        drawConfirm();
      } catch (err) {
        drawIdle(err.status === 404 ? "Codice non valido o scaduto. Generane uno nuovo sul PC." : err.message, "warn");
        const input = $("[data-code]", linkBox);
        if (input) { input.value = code; $("[data-submit]", linkBox).disabled = false; }
      }
    }

    function drawConfirm() {
      const left = () => Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
      setHTML(linkBox, html`<div class="dispositivi-confirm">
        <span class="dispositivi-hero-icon is-ask" aria-hidden="true">${icon(isPhoneLabel(pending.label) ? "phone" : "devices")}</span>
        <p class="overline">Richiesta di collegamento</p>
        <h2 class="title-1 dispositivi-question">Collegare ${pending.label}?</h2>
        <p class="body-2">Conferma solo se il computer è davanti a te. Chi lo usa vedrà il tuo registro finché non lo scolleghi.</p>
        <p class="caption tnum dispositivi-meta">${pending.requestedAt ? `Richiesto alle ${clock(pending.requestedAt)} · ` : ""}<span data-left>scade tra ${mmss(left())}</span></p>
        <div class="dispositivi-actions">
          <button type="button" class="btn" data-cancel>Annulla</button>
          <button type="button" class="btn btn-primary" data-confirm>${icon("check")}Collega</button>
        </div>
      </div>`);
      stopCountdown();
      countdown = setInterval(() => {
        const s = left();
        const el = $("[data-left]", linkBox);
        if (el) el.textContent = `scade tra ${mmss(s)}`;
        if (s <= 0) drawIdle("Il codice è scaduto. Generane uno nuovo sul PC.", "warn");
      }, 1000);
      $("[data-cancel]", linkBox).addEventListener("click", () => drawIdle("Collegamento annullato."));
      const confirmBtn = $("[data-confirm]", linkBox);
      confirmBtn.focus({ preventScroll: true });
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        $("[data-cancel]", linkBox).disabled = true;
        try {
          const data = await post("/pair/confirm", { code: pending.code });
          drawDone(data.device_label || pending.label);
        } catch (err) {
          drawIdle(err.status === 404 ? "Il codice è scaduto. Generane uno nuovo sul PC." : err.message, "warn");
        }
      });
    }

    function drawDone(label) {
      stopCountdown();
      pending = null;
      setHTML(linkBox, html`<div class="dispositivi-done">
        <span class="dispositivi-check" aria-hidden="true">${icon("check")}</span>
        <h2 class="title-2">${label} collegato</h2>
        <p class="body-2">Sul computer si sta aprendo il tuo spazio Skoolio. Puoi scollegarlo quando vuoi da qui sotto.</p>
        <button type="button" class="btn" data-again>${icon("plus")}Collega un altro computer</button>
      </div>`);
      $("[data-again]", linkBox).addEventListener("click", () => drawIdle());
      // Il PC crea la sessione al suo prossimo controllo (ogni pochi secondi).
      refreshTimers.push(setTimeout(loadDevices, 2500), setTimeout(loadDevices, 7000));
    }

    async function scan() {
      const btn = $("[data-scan]", linkBox);
      try {
        const mod = await scanner.isGoogleBarcodeScannerModuleAvailable?.();
        if (mod && mod.available === false) {
          await scanner.installGoogleBarcodeScannerModule();
          setMsg("Sto scaricando lo scanner QR: riprova tra qualche secondo, o scrivi il codice.");
          return;
        }
        if (btn) btn.disabled = true;
        const result = await scanner.scan({ formats: ["QR_CODE"] });
        const raw = result?.barcodes?.[0]?.rawValue;
        if (!raw) return;
        const code = codeFromScan(raw);
        if (code.length !== 9) return setMsg("Questo QR non è un codice di Skoolio.", "warn");
        const input = $("[data-code]", linkBox);
        if (input) input.value = code;
        lookup(code);
      } catch (err) {
        if (!/cancel/i.test(String(err?.message || err))) setMsg("Non riesco ad aprire la fotocamera. Scrivi il codice qui sotto.", "warn");
      } finally {
        if (btn?.isConnected) btn.disabled = false;
      }
    }

    /* ---------- elenco dispositivi ---------- */
    function drawDevices() {
      if (!devices.length) {
        setHTML(listBox, html`<div class="card">${emptyState({ iconName: "devices", title: "Nessun dispositivo", text: "Quando colleghi un computer lo vedrai qui." })}</div>`);
        return;
      }
      const others = devices.filter((d) => !d.current);
      setHTML(listBox, html`<ul class="card list dispositivi-list">${devices.map((d) => html`<li class="row" data-row="${d.device_id}">
          <span class="row-icon${d.current ? "" : " is-muted"}">${icon(isPhoneLabel(d.label) ? "phone" : "devices")}</span>
          <div class="row-main">
            <p class="row-title">${d.label}</p>
            <p class="row-sub">${d.current ? "Questo dispositivo" : [d.linked_via === "pairing" ? "Collegato dal telefono" : "Accesso con SPID o CIE", lastSeen(d.last_seen)].filter(Boolean).join(" · ")}</p>
            ${d.created_at ? html`<p class="row-sub faint">Dal ${fmtDate(new Date(d.created_at * 1000))} alle ${clock(d.created_at)}</p>` : ""}
          </div>
          ${d.current ? html`<span class="chip chip-good">In uso</span>` : html`<button type="button" class="btn btn-danger dispositivi-revoke" data-revoke="${d.device_id}">Scollega</button>`}
        </li>`)}</ul>
        ${others.length > 1 ? html`<button type="button" class="btn btn-block dispositivi-revoke-all" data-revoke-all>${icon("logout")}Scollega tutti gli altri (${others.length})</button>` : ""}
        <p class="caption dispositivi-foot">Scollegando un dispositivo, lì dovrai accedere di nuovo. Per uscire da questo usa Esci nel profilo.</p>`);
    }

    async function loadDevices() {
      try {
        const data = await get("/devices");
        devices = data.devices || [];
        drawDevices();
      } catch (err) {
        if (devices.length) return toast(err.message, { error: true });
        setHTML(listBox, errorState(err));
        $("[data-retry]", listBox)?.addEventListener("click", () => { setHTML(listBox, skeleton()); loadDevices(); });
      }
    }
    const skeleton = () => html`<div class="card list">${[0, 1].map(() => html`<div class="row"><div class="skeleton" style="width:34px;height:34px;border-radius:10px"></div>
      <div class="row-main stack-sm"><div class="skeleton-line" style="width:45%"></div><div class="skeleton-line" style="width:65%;height:11px"></div></div></div>`)}</div>`;

    function confirmSheet({ title, text, action }) {
      return new Promise((resolve) => {
        let done = false;
        const sheet = openSheet({
          title,
          content: html`<p class="body-2">${text}</p><div class="dispositivi-sheet-actions">
            <button type="button" class="btn" data-no>Annulla</button><button type="button" class="btn btn-danger" data-yes>${action}</button></div>`,
          onClose: () => { if (!done) resolve(false); },
        });
        $("[data-no]", sheet.body).addEventListener("click", () => sheet.close());
        $("[data-yes]", sheet.body).addEventListener("click", () => { done = true; resolve(true); sheet.close(); });
      });
    }

    async function revoke(ids) {
      for (const id of ids) {
        await post("/devices/revoke", { device_id: id }).catch((err) => { if (err.status !== 404) throw err; });
      }
    }

    listBox.addEventListener("click", async (e) => {
      const one = e.target.closest("[data-revoke]");
      const all = e.target.closest("[data-revoke-all]");
      if (!one && !all) return;
      const targets = one ? devices.filter((d) => d.device_id === one.dataset.revoke) : devices.filter((d) => !d.current);
      if (!targets.length) return;
      const ok = await confirmSheet(one
        ? { title: `Scollegare ${targets[0].label}?`, text: "Su quel dispositivo dovrai accedere di nuovo con il telefono o con SPID/CIE.", action: "Scollega" }
        : { title: "Scollegare gli altri dispositivi?", text: `Verranno disconnessi ${targets.length} dispositivi. Resterai connesso solo qui.`, action: "Scollega tutti" });
      if (!ok) return;
      const btn = one || all;
      btn.disabled = true;
      try {
        await revoke(targets.map((d) => d.device_id));
        const rows = targets.map((d) => $(`[data-row="${CSS.escape(d.device_id)}"]`, listBox)).filter(Boolean);
        rows.forEach((r) => r.classList.add("is-leaving"));
        await new Promise((r) => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200));
        devices = devices.filter((d) => !targets.includes(d));
        drawDevices();
        toast(targets.length === 1 ? `${targets[0].label} scollegato` : `${targets.length} dispositivi scollegati`);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, { error: true });
      }
    });
    $("[data-refresh]", root).addEventListener("click", loadDevices);

    /* ---------- avvio ---------- */
    drawIdle();
    setHTML(listBox, skeleton());
    const fromQr = normalizeCode(ctx.params.get("code") || "");
    if (ctx.params.has("code")) history.replaceState({}, "", location.pathname);
    if (fromQr.length === 9) lookup(fromQr);
    else if (ctx.params.has("code")) setMsg("Il codice del QR non è valido. Scrivilo a mano.", "warn");
    await loadDevices();

    return () => { stopCountdown(); refreshTimers.forEach(clearTimeout); };
  },
};

