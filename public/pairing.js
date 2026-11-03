// Accesso con SPID/CIE dalla pagina di login.
// - Nell'app (Capacitor): avvia il login SPID/CIE sul sito ufficiale ClasseViva (spid-app.js).
// - Sul web: mostra QR + codice; il telefono già autenticato li conferma da /collega/.
(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
  const POLL_MS = 2000;

  const form = document.getElementById("loginForm");
  const loginMsg = document.getElementById("loginMsg");
  const spidBtn = document.getElementById("spidLoginBtn");
  const panel = document.getElementById("pairPanel");
  if (!form || !spidBtn || !panel) return;

  const qrBox = document.getElementById("pairQr");
  const codeEl = document.getElementById("pairCode");
  const expiryEl = document.getElementById("pairExpiry");
  const statusEl = document.getElementById("pairStatus");
  const renewBtn = document.getElementById("pairRenew");
  const backBtn = document.getElementById("pairBack");
  const manualBox = document.getElementById("manualSession");
  const manualForm = document.getElementById("manualSessionForm");
  const manualInput = document.getElementById("manualSessionInput");
  const manualMsg = document.getElementById("manualSessionMsg");

  let pairId = null;
  let expiresAt = 0;
  let pollTimer = null;
  let tickTimer = null;
  let polling = false;

  async function readJsonSafe(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function consentGiven() {
    const box = form.querySelector('.login-consent input[type="checkbox"]');
    return !box || box.checked;
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function renderQr(text) {
    qrBox.textContent = "";
    if (typeof window.qrcode !== "function") {
      qrBox.hidden = true;
      return;
    }
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    // createSvgTag produce SVG generato localmente dalla libreria (nessun input utente).
    qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    qrBox.hidden = false;
  }

  function setStatus(text, tone = "") {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  }

  function updateExpiry() {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (left <= 0) {
      expired();
      return;
    }
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, "0");
    expiryEl.textContent = `Scade tra ${m}:${s}`;
  }

  function expired() {
    stopTimers();
    pairId = null;
    panel.classList.add("is-expired");
    expiryEl.textContent = "Codice scaduto";
    setStatus("Il codice è scaduto. Generane uno nuovo.", "warn");
    renewBtn.hidden = false;
  }

  async function poll() {
    if (!pairId || polling) return;
    polling = true;
    try {
      const res = await fetch(apiUrl("/api/pair/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ pair_id: pairId }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) return;
      if (data?.status === "approved") {
        stopTimers();
        panel.classList.add("is-approved");
        setStatus("Collegato! Ti porto nel tuo spazio…", "ok");
        if (data.user) localStorage.setItem("username", data.user);
        window.location.href = "/dashboard/";
      } else if (data?.status === "expired") {
        expired();
      }
    } catch (err) {
      console.warn("[pair] polling fallito:", err);
    } finally {
      polling = false;
    }
  }

  async function startPairing() {
    stopTimers();
    panel.classList.remove("is-expired", "is-approved");
    renewBtn.hidden = true;
    codeEl.textContent = "····-····";
    expiryEl.textContent = "";
    setStatus("Genero il codice…");
    try {
      const res = await fetch(apiUrl("/api/pair/start"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.pair_id) {
        setStatus(data?.detail || "Impossibile generare il codice. Riprova.", "warn");
        renewBtn.hidden = false;
        return;
      }
      pairId = data.pair_id;
      expiresAt = Date.now() + (data.expires_in || 300) * 1000;
      codeEl.textContent = data.code;
      renderQr(`${window.location.origin}/collega/?code=${encodeURIComponent(data.code)}`);
      setStatus("In attesa di conferma dal telefono…");
      updateExpiry();
      tickTimer = setInterval(updateExpiry, 1000);
      pollTimer = setInterval(poll, POLL_MS);
    } catch (err) {
      console.error(err);
      setStatus("Errore di rete / backend non raggiungibile", "warn");
      renewBtn.hidden = false;
    }
  }

  function showPanel() {
    form.hidden = true;
    panel.hidden = false;
    panel.querySelector("h2")?.focus?.();
    startPairing();
  }

  function hidePanel() {
    stopTimers();
    pairId = null;
    panel.hidden = true;
    form.hidden = false;
    spidBtn.focus();
  }

  spidBtn.addEventListener("click", () => {
    if (!consentGiven()) {
      loginMsg.textContent = "Per continuare accetta l'informativa sul trattamento dei dati.";
      form.querySelector('.login-consent input[type="checkbox"]')?.focus();
      return;
    }
    loginMsg.textContent = "";
    if (window.APP_CONFIG?.isEmbeddedApp && window.AuleraSpid?.isAvailable?.()) {
      window.AuleraSpid.start({ onStatus: (text) => (loginMsg.textContent = text) });
      return;
    }
    showPanel();
  });

  renewBtn.addEventListener("click", startPairing);
  backBtn.addEventListener("click", hidePanel);

  // Solo test/sviluppo: incolla il cookie PHPSESSID (abilitato lato server con
  // ALLOW_MANUAL_WEB_SESSION_LOGIN=true). Mai mostrato in produzione.
  async function loadAuthOptions() {
    try {
      const res = await fetch(apiUrl("/api/auth/options"), { credentials: "include", cache: "no-store" });
      const data = await readJsonSafe(res);
      if (res.ok && data?.manual_web_session && manualBox) manualBox.hidden = false;
    } catch {
      /* opzionale */
    }
  }

  manualForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    manualMsg.textContent = "Verifica sessione…";
    try {
      const res = await fetch(apiUrl("/api/login/web-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ phpsessid: manualInput.value.trim() }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        manualMsg.textContent = data?.detail || "Sessione non valida";
        return;
      }
      if (data?.user) localStorage.setItem("username", data.user);
      window.location.href = "/dashboard/";
    } catch {
      manualMsg.textContent = "Errore di rete / backend non raggiungibile";
    }
  });

  loadAuthOptions();
})();
