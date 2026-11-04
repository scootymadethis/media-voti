// Login SPID/CIE nell'app Android di Skoolio.
//
// Il plugin nativo "SpaggiariLogin" (android/app/.../SpaggiariLoginPlugin.java) apre la pagina
// di login UFFICIALE di ClasseViva in una WebView dedicata. Lo studente sceglie "Entra con SPID"
// o "Entra con CIE" e si autentica con il proprio gestore (o con l'app CieID): Skoolio non vede
// mai le credenziali. Dopo il login il plugin legge il cookie PHPSESSID (HttpOnly) dal
// CookieManager di Android e lo invia qui con l'evento "sessionCandidate"; questo modulo lo fa
// verificare al backend (POST /api/login/web-session) e, se valido, chiude la WebView.
//
// Sul web (o in una versione dell'app senza il plugin) isAvailable() è false.
(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
  const LOGIN_URL = "https://web.spaggiari.eu/home/app/default/login.php";
  const CHECK_MIN_INTERVAL_MS = 400;

  function plugin() {
    return window.Capacitor?.Plugins?.SpaggiariLogin || null;
  }

  function isAvailable() {
    const cap = window.Capacitor;
    const native = typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
    return Boolean(native && plugin());
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

  async function start({ onStatus = () => {}, onSuccess = null } = {}) {
    const SpaggiariLogin = plugin();
    if (!isAvailable()) {
      onStatus("Aggiorna l'app Skoolio per accedere con SPID o CIE.");
      return;
    }
    const handles = [];
    let done = false;
    let checking = false;
    let lastCheck = 0;

    async function cleanup() {
      for (const h of handles) {
        try {
          await h.remove();
        } catch {
          /* già rimosso */
        }
      }
    }

    async function onCandidate(event) {
      const phpsessid = event?.phpsessid;
      if (done || checking || !phpsessid) return;
      if (Date.now() - lastCheck < CHECK_MIN_INTERVAL_MS) return;
      checking = true;
      lastCheck = Date.now();
      try {
        const { res, data } = await sendSessionToBackend(phpsessid);
        if (res.ok) {
          done = true;
          await cleanup();
          await SpaggiariLogin.close();
          if (data?.user) localStorage.setItem("username", data.user);
          onStatus("Accesso effettuato!");
          if (typeof onSuccess === "function") onSuccess(data);
          else window.location.href = "/oggi";
        } else {
          // Sessione non ancora valida (pagina intermedia): torna a mostrare ClasseViva.
          await SpaggiariLogin.resume?.();
          if (res.status !== 401) onStatus(data?.detail || "Accesso non riuscito. Riprova.");
        }
      } catch (err) {
        console.warn("[spid] verifica sessione fallita:", err);
        await SpaggiariLogin.resume?.();
        onStatus("Errore di rete / backend non raggiungibile");
      } finally {
        checking = false;
      }
    }

    handles.push(await SpaggiariLogin.addListener("sessionCandidate", onCandidate));
    handles.push(
      await SpaggiariLogin.addListener("closed", async () => {
        if (done) return;
        done = true;
        await cleanup();
        onStatus("Accesso annullato.");
      }),
    );

    onStatus("Scegli \"Entra con SPID\" o \"Entra con CIE\" nella pagina di ClasseViva.");
    await SpaggiariLogin.open({ url: LOGIN_URL, clearSession: true });
  }

  window.SkoolioSpid = { isAvailable, start };
})();
