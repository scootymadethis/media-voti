(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

  function clearLegacyClientState() {
    localStorage.removeItem("loggedIn");
    localStorage.removeItem("username");
    localStorage.removeItem("fullName");
    localStorage.removeItem("schoolCode");
    localStorage.removeItem("media_generale");
  }

  async function readJsonSafe(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function profileFromCardPayload(cardData) {
    const inner =
      cardData?.card?.card ??
      cardData?.card ??
      cardData ??
      {};
    const username =
      (localStorage.getItem("username") || "").trim() ||
      String(inner.uid || inner.userId || inner.username || "").trim() ||
      null;
    const fullName = [inner.firstName, inner.lastName]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    const schoolCode = inner.schCode || inner.miurSchoolCode || null;

    return {
      ok: true,
      authenticated: true,
      username,
      full_name: fullName || null,
      school_code: schoolCode ? String(schoolCode).trim().toUpperCase() : null,
      class_code: null,
    };
  }

  /**
   * Verifica sessione: preferisce GET /api/session/me, con fallback su POST /api/card
   * se il backend in produzione non è ancora aggiornato (404).
   */
  async function fetchSession() {
    const sessionRes = await fetch(apiUrl("/api/session/me"), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });

    if (sessionRes.status !== 404 && sessionRes.status !== 405) {
      const data = await readJsonSafe(sessionRes);
      return { res: sessionRes, data, via: "session/me" };
    }

    console.warn(
      "[session] /api/session/me non disponibile (%s), fallback su /api/card",
      sessionRes.status,
    );

    const cardRes = await fetch(apiUrl("/api/card"), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    const cardData = await readJsonSafe(cardRes);

    if (!cardRes.ok) {
      return { res: cardRes, data: cardData, via: "card" };
    }

    return {
      res: cardRes,
      data: profileFromCardPayload(cardData),
      via: "card",
    };
  }

  async function requireAuth({ redirectTo = "/" } = {}) {
    const { res, data } = await fetchSession();
    if (!res.ok || !data?.authenticated) {
      clearLegacyClientState();
      if (redirectTo) {
        window.location.href = redirectTo;
      }
      return null;
    }

    if (data.username) {
      localStorage.setItem("username", data.username);
    }
    if (data.full_name) {
      localStorage.setItem("fullName", data.full_name);
    }
    if (data.school_code) {
      localStorage.setItem("schoolCode", data.school_code);
    }

    return data;
  }

  async function logout({ redirectTo = "/" } = {}) {
    try {
      await fetch(apiUrl("/api/logout"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
    } catch (err) {
      console.warn("[session] logout request failed:", err);
    }
    clearLegacyClientState();
    if (redirectTo) {
      window.location.href = redirectTo;
    }
  }

  window.SessionAuth = {
    apiUrl,
    fetchSession,
    requireAuth,
    logout,
    clearLegacyClientState,
  };

  window.logout = function logout() {
    return window.SessionAuth.logout();
  };
})();
