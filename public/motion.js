(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  {
    const glow = document.createElement("div");
    glow.className = "cursor-glow";
    glow.setAttribute("aria-hidden", "true");
    const ring = document.createElement("div");
    ring.className = "cursor-ring";
    ring.setAttribute("aria-hidden", "true");
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 3;
    let cx = x;
    let cy = y;
    let rx = x;
    let ry = y;
    let raf = 0;

    glow.classList.add("is-on");
    ring.classList.add("is-on");
    document.body.append(glow, ring);

    const tick = () => {
      const glide = reduce ? 1 : 0.12;
      const snap = reduce ? 1 : 0.35;
      cx += (x - cx) * glide;
      cy += (y - cy) * glide;
      rx += (x - rx) * snap;
      ry += (y - ry) * snap;
      glow.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      raf = requestAnimationFrame(tick);
    };

    const onMove = (event) => {
      x = event.clientX;
      y = event.clientY;
      glow.classList.add("is-on");
      ring.classList.add("is-on");
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => {
      glow.classList.remove("is-on");
      ring.classList.remove("is-on");
    });
    raf = requestAnimationFrame(tick);
  }

  const nodes = [...document.querySelectorAll("[data-reveal]")];
  nodes.forEach((node) => {
    if (node.style.getPropertyValue("--d")) return;
    const siblings = [...(node.parentElement?.querySelectorAll(":scope > [data-reveal]") || [])];
    const index = Math.max(0, siblings.indexOf(node));
    node.style.setProperty("--d", String(Math.min(index, 8)));
  });

  if (reduce || !("IntersectionObserver" in window)) {
    nodes.forEach((node) => node.classList.add("is-in"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
  );
  nodes.forEach((node) => observer.observe(node));
})();
