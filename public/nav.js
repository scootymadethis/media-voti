(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

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
    try {
      const { res, data } = await window.SessionAuth.fetchSession();
      if (!res.ok || !data?.authenticated) {
        hideAdminNavButtons();
        return;
      }

      const adminRes = await fetch(apiUrl("/api/admin/eligible"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!adminRes.ok) {
        hideAdminNavButtons();
        return;
      }
      const adminData = await adminRes.json();
      if (adminData?.eligible) {
        if (adminData.username) localStorage.setItem("username", adminData.username);
        showAdminNavButtons();
      } else {
        hideAdminNavButtons();
      }
    } catch (err) {
      console.warn("[nav] admin eligibility check failed:", err);
      hideAdminNavButtons();
    }
  }

  window.goToAdmin = function goToAdmin() {
    window.location.href = "/admin/";
  };

  window.initAdminNav = function initAdminNav() {
    hideAdminNavButtons();
    refreshAdminNavFromServer();
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof window.initAdminNav === "function") {
      window.initAdminNav();
    }
    if (typeof window.initEasterEggNav === "function") {
      window.initEasterEggNav();
    }
  });
})();
