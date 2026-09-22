(() => {
  const STORAGE_PREFIX = "spaggiari2_known_grades:";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function extractGrades(data) {
    let arr = [];
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data?.voti?.grades)) arr = data.voti.grades;
    else if (Array.isArray(data?.voti)) arr = data.voti;
    else if (Array.isArray(data?.grades)) arr = data.grades;
    else if (data?.voti && typeof data.voti === "object") {
      for (const key of Object.keys(data.voti)) {
        if (Array.isArray(data.voti[key])) {
          arr = data.voti[key];
          break;
        }
      }
    }
    return Array.isArray(arr) ? arr : [];
  }

  function gradeKey(voto) {
    if (!voto || typeof voto !== "object") return "";
    const evtId = voto.evtId ?? voto.eventId ?? voto.id;
    if (evtId != null && String(evtId).trim()) return `id:${String(evtId).trim()}`;
    const subject = String(voto.subjectDesc || voto.materia || voto.discipline || voto.name || "").trim();
    const date = String(voto.evtDate || voto.date || voto.data || "").trim();
    const display = String(voto.displayValue || voto.grade || voto.value || voto.voto || "").trim();
    const decimal = String(voto.decimalValue ?? "").trim();
    const period = String(voto.periodPos ?? "").trim();
    return `f:${subject}|${date}|${display}|${decimal}|${period}`;
  }

  function storageKey(username) {
    const user = String(username || localStorage.getItem("username") || "anon").trim().toLowerCase();
    return `${STORAGE_PREFIX}${user}`;
  }

  function loadKnownKeys(username) {
    try {
      const raw = localStorage.getItem(storageKey(username));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return new Set(parsed.map(String));
    } catch (_) {
      return null;
    }
  }

  function saveKnownKeys(username, keys) {
    try {
      localStorage.setItem(storageKey(username), JSON.stringify([...keys]));
    } catch (_) {}
  }

  function formatGradeLabel(voto) {
    const subject = String(voto.subjectDesc || voto.materia || "Materia").trim();
    const display = String(voto.displayValue || voto.grade || voto.value || voto.voto || "—").trim();
    return { subject, display, color: String(voto.color || "").trim() || "blue" };
  }

  function ensureBanner() {
    let banner = document.getElementById("newGradesBanner");
    if (banner) return banner;

    banner = document.createElement("section");
    banner.id = "newGradesBanner";
    banner.className = "new-grades-banner";
    banner.hidden = true;
    banner.setAttribute("aria-live", "polite");

    const main = document.querySelector(".main");
    const greeting = document.getElementById("greeting");
    if (main && greeting) {
      main.insertBefore(banner, greeting);
    } else if (main) {
      main.prepend(banner);
    } else {
      document.body.prepend(banner);
    }
    return banner;
  }

  function setNavBadge(count) {
    const buttons = [
      document.getElementById("votiBtn"),
      ...document.querySelectorAll('[onclick="goToVoti()"]'),
    ];
    buttons.forEach((btn) => {
      if (!btn) return;
      let badge = btn.querySelector(".nav-new-grades-badge");
      if (count <= 0) {
        badge?.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-new-grades-badge";
        btn.appendChild(badge);
      }
      badge.textContent = count > 9 ? "9+" : String(count);
    });
  }

  function hideBanner() {
    const banner = document.getElementById("newGradesBanner");
    if (banner) {
      banner.hidden = true;
      banner.innerHTML = "";
    }
    setNavBadge(0);
  }

  function showBanner(newGrades) {
    const banner = ensureBanner();
    const count = newGrades.length;
    setNavBadge(count);

    const preview = newGrades.slice(0, 4).map((voto) => {
      const { subject, display, color } = formatGradeLabel(voto);
      return `
        <li class="new-grades-item">
          <span class="new-grades-score grade-${escapeHtml(color)}">${escapeHtml(display)}</span>
          <span class="new-grades-subject">${escapeHtml(subject)}</span>
        </li>
      `;
    }).join("");

    const more = count > 4
      ? `<p class="new-grades-more">+${count - 4} altri</p>`
      : "";

    banner.hidden = false;
    banner.innerHTML = `
      <div class="new-grades-banner-inner">
        <div class="new-grades-copy">
          <span class="new-grades-kicker">Novità</span>
          <h2 class="new-grades-title">${count === 1 ? "C’è un nuovo voto" : `Ci sono ${count} nuovi voti`}</h2>
          <p class="new-grades-subtitle">Dal tuo ultimo accesso su Spaggiari 2.</p>
        </div>
        <ul class="new-grades-list">${preview}</ul>
        ${more}
        <div class="new-grades-actions">
          <button type="button" class="btn-secondary" id="newGradesOpenVoti">Apri voti</button>
          <button type="button" class="btn-secondary" id="newGradesDismiss">Ho visto</button>
        </div>
      </div>
    `;

    document.getElementById("newGradesOpenVoti")?.addEventListener("click", () => {
      window.location.href = "/voti/";
    });
    document.getElementById("newGradesDismiss")?.addEventListener("click", () => {
      hideBanner();
    });
  }

  /**
   * Confronta i voti correnti con quelli già visti.
   * Prima visita: salva lo snapshot senza banner (evita flood al primo login).
   */
  function processVotiPayload(data, { username } = {}) {
    const grades = extractGrades(data);
    const keys = grades.map(gradeKey).filter(Boolean);
    const keySet = new Set(keys);
    const known = loadKnownKeys(username);

    if (!known) {
      saveKnownKeys(username, keySet);
      hideBanner();
      return { isFirstSync: true, newGrades: [] };
    }

    const newGrades = grades.filter((voto) => {
      const key = gradeKey(voto);
      return key && !known.has(key);
    });

    // Unisci sempre le chiavi correnti (così i voti rimossi non restano “fantasma”).
    saveKnownKeys(username, keySet);

    if (newGrades.length) {
      // Ordina dal più recente
      newGrades.sort((a, b) => {
        const dateA = String(a.evtDate || a.date || "");
        const dateB = String(b.evtDate || b.date || "");
        return dateB.localeCompare(dateA);
      });
      showBanner(newGrades);
    } else {
      hideBanner();
    }

    return { isFirstSync: false, newGrades };
  }

  window.NewGradesAlert = {
    processVotiPayload,
    hideBanner,
  };
})();
