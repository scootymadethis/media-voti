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
      { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
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
      const y = Math.round(window.scrollY * 0.06);
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

  function syncSegmented(container) {
    const indicator = container.querySelector(":scope > .segmented-indicator");
    if (!indicator) return;
    const menuIsYear = container.classList.contains("school-year-menu");
    const compactYear =
      menuIsYear &&
      (window.matchMedia("(max-width: 759px)").matches ||
        container.closest(".school-year-switcher")?.classList.contains("is-many"));
    if (compactYear) {
      indicator.hidden = true;
      return;
    }
    indicator.hidden = false;
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

  function watchNumbers() {
    if (prefersReduced()) return;
    const selector = ".average-score:not(.average-score--mini), .actual-media-generale-value";
    const seen = new WeakSet();

    const animate = (el) => {
      const raw = el.textContent.trim();
      const target = Number.parseFloat(raw.replace(",", "."));
      if (!Number.isFinite(target)) return;
      if (el.dataset.countTarget === raw) return;
      el.dataset.countTarget = raw;
      const started = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / 680);
        const eased = 1 - (1 - progress) ** 3;
        const next = target * eased;
        const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
        el.textContent = decimals ? next.toFixed(decimals) : String(Math.round(next));
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = raw;
      };
      requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || seen.has(entry.target)) return;
          seen.add(entry.target);
          animate(entry.target);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.5 },
    );

    const scan = () => {
      document.querySelectorAll(selector).forEach((el) => {
        if (!seen.has(el)) observer.observe(el);
      });
    };
    scan();
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
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
    watchSegmented();
    watchNumbers();
    watchCharts();
  });

  window.AuleraMotion = {
    initReveal,
    bindSegmented,
    syncSegmented,
  };
})();
