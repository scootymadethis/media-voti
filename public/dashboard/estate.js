(() => {
  const SUMMER_STORAGE_KEY = "spaggiari2_summer_dismissed_year";

  function isItalianSchoolSummer(date = new Date()) {
    const month = date.getMonth();
    const day = date.getDate();
    if (month === 5 && day >= 15) return true;
    if (month === 6 || month === 7) return true;
    if (month === 8 && day <= 14) return true;
    return false;
  }

  function currentSummerKey(date = new Date()) {
    const year = date.getMonth() >= 8 ? date.getFullYear() : date.getFullYear() - 1;
    return `${year}-${year + 1}`;
  }

  function wasDismissed() {
    try {
      return localStorage.getItem(SUMMER_STORAGE_KEY) === currentSummerKey();
    } catch {
      return false;
    }
  }

  function markDismissed() {
    try {
      localStorage.setItem(SUMMER_STORAGE_KEY, currentSummerKey());
    } catch {}
  }

  function extractEventCount(agendaData) {
    if (!agendaData) return 0;
    if (Array.isArray(agendaData)) return agendaData.length;
    if (Array.isArray(agendaData.agenda)) return agendaData.agenda.length;
    if (agendaData.agenda && Array.isArray(agendaData.agenda.agenda)) {
      return agendaData.agenda.agenda.length;
    }
    for (const k of Object.keys(agendaData)) {
      if (Array.isArray(agendaData[k])) return agendaData[k].length;
    }
    return 0;
  }

  const SummerMode = {
    root: null,
    active: false,
    bound: false,

    shouldShow({ agendaData = null, agendaFailed = false } = {}) {
      const params = new URLSearchParams(window.location.search);
      if (params.get("estate") === "1") return true;
      if (params.get("estate") === "0") return false;
      if (!isItalianSchoolSummer()) return false;
      if (wasDismissed()) return false;
      if (agendaFailed) return true;
      return extractEventCount(agendaData) === 0;
    },

    mount() {
      this.root = document.getElementById("summerMode");
      if (!this.root) return false;

      const nameEl = document.getElementById("summerUserName");
      if (nameEl && window.studentName) {
        nameEl.textContent = window.studentName;
      } else if (nameEl) {
        const stored = (localStorage.getItem("fullName") || "").split(" ")[0];
        if (stored) nameEl.textContent = stored;
      }

      if (!this.bound) {
        document.getElementById("summerGoDashboard")?.addEventListener("click", () => {
          this.hide({ remember: true });
        });
        document.getElementById("summerStay")?.addEventListener("click", () => {
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        this.bound = true;
      }

      return true;
    },

    show({ name } = {}) {
      if (!this.mount()) return;
      if (name) {
        const nameEl = document.getElementById("summerUserName");
        if (nameEl) nameEl.textContent = name;
      }

      // Pulisce eventuali leftover della vecchia versione canvas/onde.
      document.getElementById("summerSea")?.remove();
      document.getElementById("summerSunGlow")?.remove();
      document.getElementById("summerWavesCss")?.remove();

      document.body.classList.add("summer-active");
      this.root.hidden = false;
      this.root.removeAttribute("hidden");
      this.root.setAttribute("aria-hidden", "false");
      this.active = true;
      window.scrollTo({ top: 0, behavior: "auto" });
    },

    hide({ remember = false } = {}) {
      if (!this.active) return;
      if (remember) markDismissed();
      document.body.classList.remove("summer-active");
      this.root.hidden = true;
      this.root.setAttribute("hidden", "");
      this.root.setAttribute("aria-hidden", "true");
      this.active = false;
    },
  };

  window.SummerMode = SummerMode;
  window.SummerMode.isItalianSchoolSummer = isItalianSchoolSummer;
})();
