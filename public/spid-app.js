// Login SPID/CIE nell'app Android (Capacitor).
//
// Apre la pagina di login UFFICIALE di ClasseViva in una WebView interna
// (@capacitor/inappbrowser). Lo studente sceglie "Entra con SPID" o "Entra con CIE" e si
// autentica con il proprio gestore: Aulera non vede mai le credenziali. Quando ClasseViva
// ha creato la sessione, l'app legge il cookie PHPSESSID dal CookieManager di Android
// (CapacitorCookies, condiviso tra le WebView dell'app) e lo passa al backend
// (POST /api/login/web-session), che lo verifica su /rest/w1/misc/whoami.
//
// Requisiti nell'app: npm i @capacitor/inappbrowser@^2.5 && npx cap sync android
// Sul web questo modulo non fa nulla (isAvailable() === false).
(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
  const SPAGGIARI_ORIGIN = "https://web.spaggiari.eu";
  const LOGIN_URL = `${SPAGGIARI_ORIGIN}/home/app/default/login.php`;
  const CHECK_MIN_INTERVAL_MS = 2500;
  const FALLBACK_POLL_MS = 4000;
  const MAX_WAIT_MS = 10 * 60 * 1000;
  // Pagine del flusso di autenticazione: lì la sessione non è ancora pronta.
  const AUTH_PATH_HINTS = ["login", "auth-p7", "sso", "spid", "cie", "idp", "saml", "logout"];

  function plugins() {
    return window.Capacitor?.Plugins || {};
  }

  function isAvailable() {
    const cap = window.Capacitor;
    const native = typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
    return Boolean(native && plugins().InAppBrowser && plugins().CapacitorCookies);
  }

  function looksPostLogin(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.hostname !== "web.spaggiari.eu") return false;
      const path = u.pathname.toLowerCase();
      return !AUTH_PATH_HINTS.some((hint) => path.includes(hint));
    } catch {
      return false;
    }
  }

  async function readPhpSessId() {
    const cookies = await plugins().CapacitorCookies.getCookies({ url: SPAGGIARI_ORIGIN });
    return cookies?.PHPSESSID || null;
  }

  async function sendSessionToBackend(phpsessid) {
    const res = await fetch(apiUrl("/api/login/web-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ phpsessid }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  }

  async function start({ onStatus = () => {} } = {}) {
    if (!isAvailable()) {
      onStatus("Aggiorna l'app Aulera per accedere con SPID o CIE.");
      return;
    }
    const { InAppBrowser, CapacitorCookies } = plugins();
    const handles = [];
    let done = false;
    let checking = false;
    let lastCheck = 0;
    let lastCookie = null;
    let pollTimer = null;
    const startedAt = Date.now();

    async function cleanup() {
      clearInterval(pollTimer);
      for (const h of handles) {
        try {
          await h.remove();
        } catch {
          /* già rimosso */
        }
      }
    }

    async function tryComplete(url, { force = false } = {}) {
      if (done || checking) return;
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        done = true;
        await cleanup();
        onStatus("Tempo scaduto. Riprova l'accesso con SPID o CIE.");
        try {
          await InAppBrowser.close();
        } catch {
          /* già chiuso */
        }
        return;
      }
      if (!force && url && !looksPostLogin(url)) return;
      if (Date.now() - lastCheck < CHECK_MIN_INTERVAL_MS) return;
      checking = true;
      lastCheck = Date.now();
      try {
        const phpsessid = await readPhpSessId();
        // Senza navigazione, ricontrolla solo se il cookie è cambiato (ClasseViva lo rigenera al login).
        if (!phpsessid || (force && phpsessid === lastCookie)) return;
        lastCookie = phpsessid;
        const { res, data } = await sendSessionToBackend(phpsessid);
        if (res.ok) {
          done = true;
          await cleanup();
          try {
            await InAppBrowser.close();
          } catch {
            /* già chiuso */
          }
          if (data?.user) localStorage.setItem("username", data.user);
          onStatus("Accesso effettuato!");
          window.location.href = "/dashboard/";
        } else if (res.status !== 401) {
          onStatus(data?.detail || "Accesso non riuscito. Riprova.");
        }
      } catch (err) {
        console.warn("[spid] verifica sessione fallita:", err);
      } finally {
        checking = false;
      }
    }

    onStatus("Apro ClasseViva: scegli \"Entra con SPID\" o \"Entra con CIE\".");
    try {
      // Parte sempre da una sessione ClasseViva pulita.
      await CapacitorCookies.clearCookies({ url: SPAGGIARI_ORIGIN });
    } catch {
      /* nessun cookie */
    }

    handles.push(
      await InAppBrowser.addListener("browserPageNavigationCompleted", (event) => tryComplete(event?.url)),
    );
    handles.push(await InAppBrowser.addListener("browserPageLoaded", () => tryComplete(null, { force: true })));
    handles.push(
      await InAppBrowser.addListener("browserClosed", async () => {
        if (done) return;
        // Ultimo tentativo: l'utente potrebbe aver chiuso dopo aver completato il login.
        await tryComplete(null, { force: true });
        if (!done) {
          done = true;
          await cleanup();
          onStatus("Accesso annullato.");
        }
      }),
    );
    pollTimer = setInterval(() => tryComplete(null, { force: true }), FALLBACK_POLL_MS);

    await InAppBrowser.openInWebView({
      url: LOGIN_URL,
      options: {
        showURL: true,
        showToolbar: true,
        clearCache: false,
        clearSessionCache: true,
        mediaPlaybackRequiresUserAction: false,
        closeButtonText: "Chiudi",
        toolbarPosition: 0, // TOP
        showNavigationButtons: true,
        leftToRight: false,
        customWebViewUserAgent: null,
        android: { allowZoom: false, hardwareBack: true, pauseMedia: true },
        iOS: {
          allowOverScroll: true,
          enableViewportScale: false,
          allowInLineMediaPlayback: false,
          surpressIncrementalRendering: false,
          viewStyle: 2, // FULL_SCREEN
          animationEffect: 2, // COVER_VERTICAL
          allowsBackForwardNavigationGestures: true,
        },
      },
    });
  }

  window.AuleraSpid = { isAvailable, start };
})();
