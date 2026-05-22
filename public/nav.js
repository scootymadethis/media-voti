(function () {
  const ADMIN_USERNAME = "S10371278X";
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

  function isAdminUser() {
    const username = (localStorage.getItem("username") || "").trim();
    return username === ADMIN_USERNAME;
  }

  function showAdminNavButtons() {
    document.querySelectorAll("[data-admin-nav]").forEach((btn) => {
      btn.hidden = false;
      btn.style.display = "";
    });
  }

  function hideAdminNavButtons() {
    document.querySelectorAll("[data-admin-nav]").forEach((btn) => {
      btn.hidden = true;
    });
  }

  async function refreshAdminNavFromServer() {
    if (localStorage.getItem("loggedIn") !== "true") {
      hideAdminNavButtons();
      return;
    }

    try {
      const res = await fetch(apiUrl("/api/admin/eligible"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        hideAdminNavButtons();
        return;
      }
      const data = await res.json();
      if (data?.eligible) {
        if (data.username) localStorage.setItem("username", data.username);
        showAdminNavButtons();
      } else {
        hideAdminNavButtons();
      }
    } catch (err) {
      console.warn("[nav] admin eligibility check failed:", err);
      if (isAdminUser()) showAdminNavButtons();
      else hideAdminNavButtons();
    }
  }

  window.goToAdmin = function goToAdmin() {
    window.location.href = "/admin/";
  };

  window.initAdminNav = function initAdminNav() {
    hideAdminNavButtons();
    if (isAdminUser()) showAdminNavButtons();
    refreshAdminNavFromServer();
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof window.initAdminNav === "function") {
      window.initAdminNav();
    }
  });
})();
