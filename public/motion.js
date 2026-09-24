(() => {
  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const prefersReduced = () => reduceQuery.matches;

  function ensureAmbient() {
    if (document.querySelector(".ambient")) return;
    const layer = document.createElement("div");
    layer.className = "ambient";
    layer.setAttribute("aria-hidden", "true");
    layer.innerHTML = `
      <div class="ambient-shift">
        <span class="ambient-glow ambient-glow-a"></span>
        <span class="ambient-glow ambient-glow-b"></span>
      </div>
      <span class="ambient-cursor-glow"></span>
      <span class="ambient-grain"></span>
    `;
    document.body.prepend(layer);
  }

  function initReveal(root = document) {
    const nodes = [...root.querySelectorAll("[data-reveal]:not([data-reveal-bound])")];
    if (!nodes.length) return;
    if (prefersReduced()) {
      nodes.forEach((node) => {
        node.dataset.revealBound = "1";
        node.classList.add("is-revealed");
      });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const siblings = [...(el.parentElement?.children || [])].filter((child) =>
            child.hasAttribute("data-reveal"),
          );
          const index = Math.max(0, siblings.indexOf(el));
          el.style.setProperty("--reveal-delay", `${Math.min(index, 7) * 60}ms`);
          el.classList.add("is-revealed");
          observer.unobserve(el);
        });
      },
      { threshold: 0, rootMargin: "0px 0px -24px 0px" },
    );
    nodes.forEach((node) => {
      node.dataset.revealBound = "1";
      observer.observe(node);
    });
  }

  function initNavScroll() {
    const nav = document.querySelector(".navbar");
    if (!nav) return;
    const apply = () => nav.classList.toggle("is-scrolled", window.scrollY > 10);
    apply();
    window.addEventListener("scroll", apply, { passive: true });
  }

  function initParallax() {
    if (prefersReduced()) return;
    const shift = document.querySelector(".ambient-shift");
    if (!shift) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = Math.min(120, Math.round(window.scrollY * 0.035));
      shift.style.transform = `translate3d(0, ${y}px, 0)`;
    };
    window.addEventListener(
      "scroll",
      () => {
        if (frame) return;
        frame = requestAnimationFrame(update);
      },
      { passive: true },
    );
  }

  function initCursorGlow() {
    if (prefersReduced() || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const glow = document.querySelector(".ambient-cursor-glow");
    if (!glow) return;

    let frame = 0;
    let x = 0;
    let y = 0;
    window.addEventListener("pointermove", (event) => {
      x = event.clientX;
      y = event.clientY;
      glow.classList.add("is-active");
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        glow.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      });
    }, { passive: true });
    window.addEventListener("pointerleave", () => glow.classList.remove("is-active"));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) glow.classList.remove("is-active");
    });
  }

  function syncSegmented(container) {
    const indicator = container.querySelector(":scope > .segmented-indicator");
    if (!indicator) return;
    const menuIsYear = container.classList.contains("school-year-menu");
    const compactYear =
      menuIsYear &&
      (window.matchMedia("(max-width: 759px)").matches ||
        container.closest(".school-year-switcher")?.classList.contains("is-many"));
    if (compactYear) {
      if (!indicator.hidden) indicator.hidden = true;
      return;
    }
    if (indicator.hidden) indicator.hidden = false;
    const active = container.querySelector(
      ":scope > .active, :scope > .selected, :scope > [aria-selected='true']",
    );
    if (!active) {
      indicator.style.opacity = "0";
      return;
    }
    const parent = container.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    indicator.style.opacity = "1";
    indicator.style.width = `${rect.width}px`;
    indicator.style.transform = `translate3d(${rect.left - parent.left}px, 0, 0)`;
  }

  function bindSegmented(root = document) {
    root.querySelectorAll(".segmented").forEach((container) => {
      if (!container.querySelector(":scope > .segmented-indicator")) {
        const indicator = document.createElement("span");
        indicator.className = "segmented-indicator";
        indicator.setAttribute("aria-hidden", "true");
        container.prepend(indicator);
      }
      if (container.dataset.segmentedBound !== "1") {
        container.dataset.segmentedBound = "1";
        container.addEventListener("click", () => {
          requestAnimationFrame(() => syncSegmented(container));
        });
      }
      syncSegmented(container);
    });
  }

  function watchSegmented() {
    let frame = 0;
    const refresh = () => {
      frame = 0;
      bindSegmented();
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(refresh);
    };
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-selected"],
    });
    refresh();
  }

  function armChart(chart) {
    if (!chart || chart.dataset.drawArmed === "1") return;
    chart.dataset.drawArmed = "1";
    if (prefersReduced()) {
      chart.classList.add("is-drawn");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        chart.classList.add("is-drawn");
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(chart);
  }

  function watchCharts() {
    const scan = () => {
      document.querySelectorAll("#andamentoChart svg").forEach((svg) => {
        armChart(svg.closest("#andamentoChart"));
      });
    };
    scan();
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureAmbient();
    initReveal();
    initNavScroll();
    initParallax();
    initCursorGlow();
    watchSegmented();
    // Values are live school data: keep their text under the data renderer's control.
    watchCharts();
  });

  window.AuleraMotion = {
    initReveal,
    bindSegmented,
    syncSegmented,
  };
})();
