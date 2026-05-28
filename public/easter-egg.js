(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

  function showEasterEggButtons() {
    document.querySelectorAll("[data-easter-egg-nav]").forEach((btn) => {
      btn.hidden = false;
      btn.style.display = "";
    });
  }

  function hideEasterEggButtons() {
    document.querySelectorAll("[data-easter-egg-nav]").forEach((btn) => {
      btn.hidden = true;
    });
  }

  async function refreshEasterEggNavFromServer() {
    try {
      const { res, data } = await window.SessionAuth.fetchSession();
      if (!res.ok || !data?.authenticated) {
        hideEasterEggButtons();
        return;
      }

      const eggRes = await fetch(apiUrl("/api/easter-egg/eligible"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!eggRes.ok) {
        hideEasterEggButtons();
        return;
      }
      const eggData = await eggRes.json();
      if (eggData?.eligible) {
        if (eggData.username) localStorage.setItem("username", eggData.username);
        showEasterEggButtons();
      } else {
        hideEasterEggButtons();
      }
    } catch (err) {
      console.warn("[easter-egg] eligibility check failed:", err);
      hideEasterEggButtons();
    }
  }

  window.goToEasterEggGame = function goToEasterEggGame() {
    window.location.href = "/game/";
  };

  window.initEasterEggNav = function initEasterEggNav() {
    hideEasterEggButtons();
    refreshEasterEggNavFromServer();
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof window.initEasterEggNav === "function") {
      window.initEasterEggNav();
    }
  });
})();
