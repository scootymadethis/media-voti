(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

  const ICONS = {
    goToHome:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    goToOrario:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3.5v3M16 3.5v3M3.5 9.5h17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    goToVoti:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V10M12 19V5M19 19v-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    goToAssenze:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v4.5l3 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    goToAdmin:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 19.5c1.2-3 3.4-4.5 6.5-4.5s5.3 1.5 6.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    logout:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v9A1.5 1.5 0 0 0 6.5 18H9M10 12h9M16 8.5 19.5 12 16 15.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    egg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c3.2 0 5.5 4.2 5.5 8.2 0 3.6-2.2 8.8-5.5 8.8s-5.5-5.2-5.5-8.8c0-4 2.3-8.2 5.5-8.2Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  };

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

  function decorateNavButton(btn) {
    if (btn.dataset.iconized === "1" || btn.classList.contains("navbar-toggle")) return;
    const action = btn.getAttribute("onclick") || "";
    let icon = "";
    let label = btn.textContent.trim();
    if (btn.hasAttribute("data-easter-egg-nav")) {
      icon = ICONS.egg;
      label = "Segreto";
    } else if (action.includes("goToHome")) icon = ICONS.goToHome;
    else if (action.includes("goToOrario")) icon = ICONS.goToOrario;
    else if (action.includes("goToVoti")) icon = ICONS.goToVoti;
    else if (action.includes("goToAssenze")) icon = ICONS.goToAssenze;
    else if (action.includes("goToAdmin")) icon = ICONS.goToAdmin;
    else if (action.includes("logout")) icon = ICONS.logout;
    if (!icon) return;
    btn.dataset.iconized = "1";
    btn.innerHTML = `${icon}<span class="nav-label">${label}</span>`;
  }

  function decorateNavigation() {
    document.querySelectorAll(".navbar .nav-link, .nav-drawer .nav-link").forEach(decorateNavButton);
  }

  window.goToAdmin = function goToAdmin() {
    window.location.href = "/admin/";
  };

  window.initAdminNav = function initAdminNav() {
    hideAdminNavButtons();
    refreshAdminNavFromServer();
  };

  document.addEventListener("DOMContentLoaded", () => {
    decorateNavigation();
    if (typeof window.initAdminNav === "function") {
      window.initAdminNav();
    }
    if (typeof window.initEasterEggNav === "function") {
      window.initEasterEggNav();
    }
  });
})();
