(function () {
  const EASTER_EGG_USERNAMES = new Set([
    "S10371217U",
    "aaronrai829@gmail.com",
    "S10371278X",
    "510371115",
    "S9456217C",
    "S10371066B",
  ]);

  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

  function isEasterEggUser() {
    const username = (localStorage.getItem("username") || "").trim();
    return EASTER_EGG_USERNAMES.has(username);
  }

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
    if (localStorage.getItem("loggedIn") !== "true") {
      hideEasterEggButtons();
      return;
    }

    try {
      const res = await fetch(apiUrl("/api/easter-egg/eligible"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        hideEasterEggButtons();
        return;
      }
      const data = await res.json();
      if (data?.eligible) {
        if (data.username) localStorage.setItem("username", data.username);
        showEasterEggButtons();
      } else {
        hideEasterEggButtons();
      }
    } catch (err) {
      console.warn("[easter-egg] eligibility check failed:", err);
      if (isEasterEggUser()) showEasterEggButtons();
      else hideEasterEggButtons();
    }
  }

  window.goToEasterEggGame = function goToEasterEggGame() {
    window.location.href = "/game/";
  };

  window.initEasterEggNav = function initEasterEggNav() {
    hideEasterEggButtons();
    if (isEasterEggUser()) showEasterEggButtons();
    refreshEasterEggNavFromServer();
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof window.initEasterEggNav === "function") {
      window.initEasterEggNav();
    }
  });
})();
