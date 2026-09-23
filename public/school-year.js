(() => {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
  const STORAGE_KEY = "selectedSchoolYear";

  let yearsCache = null;
  let currentYear = null;
  let selectedYear = null;

  function labelFor(year) {
    return `A.S. ${year}`;
  }

  function readStoredYear() {
    try {
      return localStorage.getItem(STORAGE_KEY) || null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredYear(year) {
    try {
      localStorage.setItem(STORAGE_KEY, year);
    } catch (_) {}
  }

  async function loadSchoolYears() {
    if (yearsCache) {
      return { current: currentYear, years: yearsCache };
    }
    const res = await fetch(apiUrl("/api/school-years"), {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error("Impossibile caricare gli anni scolastici");
    }
    const data = await res.json();
    currentYear = data.current || null;
    yearsCache = Array.isArray(data.years) ? data.years : [];
    const stored = readStoredYear();
    const known = new Set(yearsCache.map((y) => y.id));
    selectedYear = known.has(stored) ? stored : currentYear || yearsCache[0]?.id || null;
    return { current: currentYear, years: yearsCache };
  }

  function getSelectedSchoolYear() {
    return selectedYear || currentYear;
  }

  function isCurrentSchoolYear() {
    const selected = getSelectedSchoolYear();
    return Boolean(selected && currentYear && selected === currentYear);
  }

  function setSelectedSchoolYear(year, { persist = true } = {}) {
    selectedYear = year;
    if (persist) writeStoredYear(year);
  }

  function appendSchoolYearParam(params, year = getSelectedSchoolYear()) {
    const target = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    if (year) target.set("school_year", year);
    return target;
  }

  function schoolYearQuery(year = getSelectedSchoolYear()) {
    return appendSchoolYearParam(new URLSearchParams(), year).toString();
  }

  function mountSwitcher(container, { onChange } = {}) {
    if (!container) return null;

    const closeMenu = () => container.classList.remove("is-open");

    const render = () => {
      const years = yearsCache || [];
      container.innerHTML = "";
      container.classList.add("school-year-switcher");
      container.classList.remove("is-open");
      container.setAttribute("aria-label", "Anno scolastico");

      if (!years.length) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      container.classList.toggle("is-many", years.length > 4);

      const selected = years.find((year) => year.id === getSelectedSchoolYear()) || years[0];
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "school-year-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.innerHTML = `<span>${selected?.label || labelFor(selected?.id || "")}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = container.classList.toggle("is-open");
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
      });

      const menu = document.createElement("div");
      menu.className = "school-year-menu segmented";
      menu.setAttribute("role", "tablist");
      menu.setAttribute("aria-label", "Anno scolastico");

      years.forEach((year) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "school-year-btn";
        btn.dataset.schoolYear = year.id;
        btn.setAttribute("role", "tab");
        const active = year.id === getSelectedSchoolYear();
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.textContent = year.label || labelFor(year.id);
        if (year.is_current) btn.title = "Anno scolastico corrente";
        btn.addEventListener("click", async () => {
          closeMenu();
          if (year.id === getSelectedSchoolYear()) return;
          setSelectedSchoolYear(year.id);
          render();
          if (typeof onChange === "function") await onChange(year.id);
        });
        menu.appendChild(btn);
      });

      container.append(trigger, menu);
      window.AuleraMotion?.bindSegmented?.(container);
    };

    if (!container.dataset.yearDismissBound) {
      container.dataset.yearDismissBound = "1";
      document.addEventListener("click", (event) => {
        if (!container.contains(event.target)) closeMenu();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMenu();
      });
    }

    return {
      async init() {
        await loadSchoolYears();
        render();
      },
      render,
      getSelectedSchoolYear,
      isCurrentSchoolYear,
    };
  }

  window.SchoolYear = {
    loadSchoolYears,
    getSelectedSchoolYear,
    isCurrentSchoolYear,
    setSelectedSchoolYear,
    appendSchoolYearParam,
    schoolYearQuery,
    mountSwitcher,
    labelFor,
  };
})();
