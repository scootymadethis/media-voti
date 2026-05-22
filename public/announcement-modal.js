(function () {
  const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;
  let markedReady = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }

  async function ensureMarked() {
    if (window.marked) {
      markedReady = true;
      return true;
    }
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";
      script.async = true;
      script.onload = () => {
        markedReady = true;
        resolve(true);
      };
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  function renderMarkdown(markdown) {
    const raw = String(markdown || "");
    if (markedReady && window.marked) {
      try {
        window.marked.setOptions({ breaks: true, gfm: true });
        return window.marked.parse(raw);
      } catch (err) {
        console.warn("[announcement] markdown parse failed:", err);
      }
    }
    return escapeHtml(raw).replace(/\n/g, "<br>");
  }

  function ensureModalDom() {
    if (document.getElementById("siteAnnouncementModal")) {
      return document.getElementById("siteAnnouncementModal");
    }

    const modal = document.createElement("div");
    modal.id = "siteAnnouncementModal";
    modal.className = "modal announcement-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="siteAnnouncementTitle">
        <div class="modal-header">
          <h3 id="siteAnnouncementTitle">Annuncio</h3>
          <button type="button" id="siteAnnouncementClose" class="modal-close" aria-label="Chiudi">✕</button>
        </div>
        <div class="modal-body">
          <div id="siteAnnouncementBody" class="announcement-body"></div>
          <div class="announcement-modal-footer">
            <button type="button" id="siteAnnouncementOk">Ho capito</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeAnnouncementModal();
    });
    document.getElementById("siteAnnouncementClose")?.addEventListener("click", closeAnnouncementModal);
    document.getElementById("siteAnnouncementOk")?.addEventListener("click", closeAnnouncementModal);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("show")) {
        closeAnnouncementModal();
      }
    });

    return modal;
  }

  let dismissInFlight = false;

  async function dismissAnnouncement() {
    if (dismissInFlight) return;
    dismissInFlight = true;
    try {
      await fetch(apiUrl("/api/announcement/dismiss"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
    } catch (err) {
      console.warn("[announcement] dismiss failed:", err);
    } finally {
      dismissInFlight = false;
    }
  }

  function closeAnnouncementModal() {
    const modal = document.getElementById("siteAnnouncementModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    dismissAnnouncement();
  }

  function openAnnouncementModal(payload) {
    const modal = ensureModalDom();
    const titleEl = document.getElementById("siteAnnouncementTitle");
    const bodyEl = document.getElementById("siteAnnouncementBody");
    if (!titleEl || !bodyEl) return;

    titleEl.textContent = payload.title?.trim() || "Novità";
    bodyEl.innerHTML = renderMarkdown(payload.body_markdown || "");

    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    document.getElementById("siteAnnouncementOk")?.focus();
  }

  window.renderAnnouncementMarkdown = function renderAnnouncementMarkdown(markdown) {
    return renderMarkdown(markdown);
  };

  window.initSiteAnnouncementModal = async function initSiteAnnouncementModal() {
    if (localStorage.getItem("loggedIn") !== "true") return;

    try {
      const res = await fetch(apiUrl("/api/announcement/me"), {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.should_show) return;

      await ensureMarked();
      openAnnouncementModal(data);
    } catch (err) {
      console.warn("[announcement] could not load modal:", err);
    }
  };
})();
