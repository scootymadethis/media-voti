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

  async function fetchSession() {
    const res = await fetch(apiUrl("/api/session/me"), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    const data = await readJsonSafe(res);
    return { res, data };
  }

  /**
   * Verifica la sessione HttpOnly lato server.
   * @returns {Promise<object|null>} profilo sessione o null se non autenticato
   */
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
