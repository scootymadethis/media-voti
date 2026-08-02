(() => {
  const SUMMER_STORAGE_KEY = "spaggiari2_summer_dismissed_year";

  function isItalianSchoolSummer(date = new Date()) {
    const month = date.getMonth();
    const day = date.getDate();
    if (month === 5 && day >= 15) return true; // metà giugno
    if (month === 6 || month === 7) return true; // luglio / agosto
    if (month === 8 && day <= 14) return true; // inizio settembre
    return false;
  }

  function currentSummerKey(date = new Date()) {
    // Chiave anno scolastico: estate 2026 → "2025-2026"
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

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  class SeaEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.t = 0;
      this.scroll = 0;
      this.pointer = { x: 0.5, y: 0.35 };
      this.targetPointer = { x: 0.5, y: 0.35 };
      this.sparks = [];
      this.birds = [];
      this.running = false;
      this.raf = 0;
      this.resize();
      this.seedSparks();
      this.seedBirds();
    }

    resize() {
      const { canvas, dpr } = this;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      this.w = canvas.width;
      this.h = canvas.height;
      this.seedSparks();
    }

    seedSparks() {
      const count = Math.floor((this.w * this.h) / (14000 * this.dpr * this.dpr));
      this.sparks = Array.from({ length: Math.max(24, count) }, () => ({
        x: Math.random(),
        y: 0.45 + Math.random() * 0.5,
        r: 0.6 + Math.random() * 2.2,
        speed: 0.15 + Math.random() * 0.55,
        phase: Math.random() * Math.PI * 2,
        glow: 0.35 + Math.random() * 0.65,
      }));
    }

    seedBirds() {
      this.birds = Array.from({ length: 4 }, (_, i) => ({
        x: Math.random(),
        y: 0.12 + Math.random() * 0.18,
        speed: 0.015 + Math.random() * 0.02,
        amp: 0.01 + Math.random() * 0.015,
        phase: Math.random() * Math.PI * 2,
        scale: 0.7 + i * 0.15,
      }));
    }

    setScrollProgress(p) {
      this.scroll = Math.max(0, Math.min(1, p));
    }

    setPointer(nx, ny) {
      this.targetPointer.x = nx;
      this.targetPointer.y = ny;
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = (now) => {
        if (!this.running) return;
        this.t = now * 0.001;
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }

    waveY(x, base, amp, freq, speed, phase) {
      const px = this.pointer.x - 0.5;
      return (
        base +
        Math.sin(x * freq + this.t * speed + phase) * amp +
        Math.sin(x * freq * 2.1 - this.t * speed * 0.7 + phase) * amp * 0.35 +
        px * amp * 0.8
      );
    }

    drawSky() {
      const { ctx, w, h, scroll, t, pointer } = this;
      const dive = scroll * 0.18;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `rgb(${8 + dive * 20}, ${28 + dive * 40}, ${68 + dive * 30})`);
      g.addColorStop(0.42, `rgb(${18}, ${90 + scroll * 20}, ${140})`);
      g.addColorStop(0.7, `rgb(${10}, ${120}, ${150})`);
      g.addColorStop(1, `rgb(${2}, ${40 + scroll * 30}, ${70})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // soft horizon bloom
      const bloom = ctx.createRadialGradient(
        w * (0.5 + (pointer.x - 0.5) * 0.15),
        h * (0.38 - scroll * 0.05),
        0,
        w * 0.5,
        h * 0.42,
        h * 0.55,
      );
      bloom.addColorStop(0, "rgba(255, 214, 120, 0.28)");
      bloom.addColorStop(0.35, "rgba(80, 200, 255, 0.12)");
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, w, h);

      // drifting clouds
      for (let i = 0; i < 5; i++) {
        const cx = ((t * (8 + i * 3) + i * 180) % (w + 240)) - 120;
        const cy = h * (0.1 + i * 0.035) + Math.sin(t * 0.4 + i) * 8;
        ctx.fillStyle = `rgba(255,255,255,${0.05 + i * 0.015})`;
        this.roundCloud(cx, cy, 60 + i * 18);
      }
    }

    roundCloud(x, y, s) {
      const { ctx } = this;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * 0.38, 0, 0, Math.PI * 2);
      ctx.ellipse(x - s * 0.45, y + 4, s * 0.55, s * 0.28, 0, 0, Math.PI * 2);
      ctx.ellipse(x + s * 0.5, y + 2, s * 0.5, s * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    drawSun() {
      const { ctx, w, h, t, scroll, pointer } = this;
      const sx = w * (0.72 + (pointer.x - 0.5) * 0.08);
      const sy = h * (0.2 + scroll * 0.08 + Math.sin(t * 0.5) * 0.01);
      const r = Math.min(w, h) * (0.09 + scroll * 0.02);

      // rays
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(t * 0.15);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ctx.rotate(a);
        const ray = ctx.createLinearGradient(0, 0, 0, r * 3.2);
        ray.addColorStop(0, "rgba(255, 220, 120, 0.35)");
        ray.addColorStop(1, "rgba(255, 220, 120, 0)");
        ctx.fillStyle = ray;
        ctx.beginPath();
        ctx.moveTo(-6, r * 0.9);
        ctx.lineTo(6, r * 0.9);
        ctx.lineTo(1.5, r * 3.1);
        ctx.lineTo(-1.5, r * 3.1);
        ctx.closePath();
        ctx.fill();
        ctx.rotate(-a);
      }
      ctx.restore();

      const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 1.8);
      core.addColorStop(0, "rgba(255, 250, 220, 1)");
      core.addColorStop(0.35, "rgba(255, 209, 102, 0.95)");
      core.addColorStop(0.7, "rgba(255, 140, 70, 0.35)");
      core.addColorStop(1, "rgba(255, 140, 70, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    drawBirds() {
      const { ctx, w, h, t } = this;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 2 * this.dpr;
      ctx.lineCap = "round";
      for (const b of this.birds) {
        const x = ((b.x + t * b.speed) % 1.2) * w - w * 0.1;
        const y = h * (b.y + Math.sin(t * 1.4 + b.phase) * b.amp);
        const flap = Math.sin(t * 8 + b.phase) * 0.35;
        const s = 10 * this.dpr * b.scale;
        ctx.beginPath();
        ctx.moveTo(x - s, y + flap * s);
        ctx.quadraticCurveTo(x - s * 0.2, y - s * 0.35, x, y);
        ctx.quadraticCurveTo(x + s * 0.2, y - s * 0.35, x + s, y + flap * s);
        ctx.stroke();
      }
    }

    fillWave(baseRatio, ampRatio, freq, speed, phase, colorTop, colorBottom) {
      const { ctx, w, h, t, scroll } = this;
      const base = h * (baseRatio - scroll * 0.04);
      const amp = h * (ampRatio + scroll * 0.01);
      ctx.beginPath();
      ctx.moveTo(0, h);
      const steps = Math.ceil(w / (10 * this.dpr));
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const y = this.waveY(x / w, base, amp, freq, speed, phase);
        if (i === 0) ctx.lineTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, base - amp * 2, 0, h);
      g.addColorStop(0, colorTop);
      g.addColorStop(1, colorBottom);
      ctx.fillStyle = g;
      ctx.fill();

      // foam line
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const y = this.waveY(x / w, base, amp, freq, speed, phase);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 2.2 * this.dpr;
      ctx.stroke();

      // crest sparkles
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      for (let i = 0; i < steps; i += 7) {
        const x = (i / steps) * w;
        const y = this.waveY(x / w, base, amp, freq, speed, phase);
        const twinkle = 0.5 + 0.5 * Math.sin(t * 6 + i + phase);
        if (twinkle < 0.75) continue;
        ctx.beginPath();
        ctx.arc(x, y - 2 * this.dpr, 1.4 * this.dpr * twinkle, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawCaustics() {
      const { ctx, w, h, t, scroll } = this;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 7; i++) {
        const x =
          ((t * (20 + i * 8) + i * 97) % (w + 200)) - 100 + Math.sin(t + i) * 30;
        const top = h * (0.52 - scroll * 0.03);
        const beam = ctx.createLinearGradient(x, top, x + 40, h);
        beam.addColorStop(0, "rgba(120, 230, 255, 0)");
        beam.addColorStop(0.25, `rgba(120, 230, 255, ${0.05 + (i % 3) * 0.02})`);
        beam.addColorStop(1, "rgba(120, 230, 255, 0)");
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x + 55 + i * 6, top);
        ctx.lineTo(x + 140 + i * 12, h);
        ctx.lineTo(x - 40 - i * 8, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    drawSparks() {
      const { ctx, w, h, t, sparks } = this;
      for (const s of sparks) {
        const x = s.x * w + Math.sin(t * s.speed + s.phase) * 18;
        const y = s.y * h + Math.cos(t * s.speed * 1.3 + s.phase) * 10;
        const a = (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 5 + s.phase))) * s.glow;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r * this.dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawBoat() {
      const { ctx, w, h, t, scroll } = this;
      const x = w * (0.2 + Math.sin(t * 0.25) * 0.03);
      const water = h * (0.62 - scroll * 0.04);
      const bob = Math.sin(t * 1.7) * 6 * this.dpr;
      const y = water + bob;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * 1.7) * 0.05);
      ctx.fillStyle = "rgba(7, 32, 51, 0.85)";
      ctx.beginPath();
      ctx.moveTo(-36 * this.dpr, 0);
      ctx.lineTo(40 * this.dpr, 0);
      ctx.quadraticCurveTo(28 * this.dpr, 18 * this.dpr, 0, 18 * this.dpr);
      ctx.quadraticCurveTo(-30 * this.dpr, 18 * this.dpr, -36 * this.dpr, 0);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -42 * this.dpr);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 214, 120, 0.9)";
      ctx.beginPath();
      ctx.moveTo(2 * this.dpr, -40 * this.dpr);
      ctx.lineTo(28 * this.dpr, -18 * this.dpr);
      ctx.lineTo(2 * this.dpr, -12 * this.dpr);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    draw() {
      this.pointer.x += (this.targetPointer.x - this.pointer.x) * 0.06;
      this.pointer.y += (this.targetPointer.y - this.pointer.y) * 0.06;

      const { ctx, w, h } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawSky();
      this.drawSun();
      this.drawBirds();

      this.fillWave(
        0.58,
        0.028,
        7.5,
        1.1,
        0.2,
        "rgba(40, 170, 200, 0.75)",
        "rgba(8, 70, 110, 0.95)",
      );
      this.fillWave(
        0.64,
        0.034,
        5.8,
        1.35,
        1.4,
        "rgba(30, 200, 200, 0.72)",
        "rgba(6, 60, 100, 0.98)",
      );
      this.fillWave(
        0.72,
        0.045,
        4.2,
        1.7,
        2.1,
        "rgba(20, 150, 190, 0.9)",
        "rgba(2, 30, 60, 1)",
      );
      this.fillWave(
        0.8,
        0.055,
        3.4,
        2.1,
        3.3,
        "rgba(10, 90, 140, 0.95)",
        "rgba(1, 16, 34, 1)",
      );

      this.drawBoat();
      this.drawCaustics();
      this.drawSparks();

      // vignette
      const vig = ctx.createRadialGradient(w * 0.5, h * 0.45, h * 0.2, w * 0.5, h * 0.5, h * 0.85);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0, 10, 20, 0.45)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);
    }
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
    canvas: null,
    engine: null,
    observer: null,
    hint: null,
    active: false,

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
      this.canvas = document.getElementById("summerSea");
      this.hint = this.root?.querySelector(".summer-scroll-hint");
      if (!this.root || !this.canvas) return false;

      const nameEl = document.getElementById("summerUserName");
      if (nameEl && window.studentName) {
        nameEl.textContent = window.studentName;
      } else if (nameEl) {
        const stored = (localStorage.getItem("fullName") || "").split(" ")[0];
        if (stored) nameEl.textContent = stored;
      }

      document.getElementById("summerGoDashboard")?.addEventListener("click", () => {
        this.hide({ remember: true });
      });
      document.getElementById("summerStay")?.addEventListener("click", () => {
        window.scrollTo({
          top: 0,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      });

      return true;
    },

    bindScroll() {
      const panels = [...this.root.querySelectorAll("[data-summer-reveal]")];
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) entry.target.classList.add("is-inview");
          }
        },
        { threshold: 0.28, rootMargin: "0px 0px -8% 0px" },
      );
      panels.forEach((p) => this.observer.observe(p));
      // hero visible immediately
      panels[0]?.classList.add("is-inview");

      this.onScroll = () => {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const p = window.scrollY / max;
        this.engine?.setScrollProgress(p);
        if (this.hint) {
          this.hint.style.opacity = String(Math.max(0, 1 - p * 4));
        }
      };
      window.addEventListener("scroll", this.onScroll, { passive: true });
      this.onScroll();
    },

    bindPointer() {
      this.onPointer = (e) => {
        const x = "touches" in e ? e.touches[0].clientX : e.clientX;
        const y = "touches" in e ? e.touches[0].clientY : e.clientY;
        this.engine?.setPointer(x / window.innerWidth, y / window.innerHeight);
      };
      window.addEventListener("pointermove", this.onPointer, { passive: true });
      window.addEventListener("touchmove", this.onPointer, { passive: true });
    },

    show({ name } = {}) {
      if (!this.mount()) return;
      if (name) {
        const nameEl = document.getElementById("summerUserName");
        if (nameEl) nameEl.textContent = name;
      }

      document.body.classList.add("summer-active");
      this.root.hidden = false;
      this.root.setAttribute("aria-hidden", "false");
      this.active = true;
      window.scrollTo({ top: 0, behavior: "auto" });

      if (!prefersReducedMotion()) {
        this.engine = new SeaEngine(this.canvas);
        this.engine.start();
        this.onResize = () => this.engine?.resize();
        window.addEventListener("resize", this.onResize);
        this.bindPointer();
      } else {
        // static gradient fallback
        this.canvas.style.background =
          "linear-gradient(180deg, #08305a 0%, #0e7c8a 48%, #06263f 100%)";
      }

      this.bindScroll();
    },

    hide({ remember = false } = {}) {
      if (!this.active) return;
      if (remember) markDismissed();
      document.body.classList.remove("summer-active");
      this.root.hidden = true;
      this.root.setAttribute("aria-hidden", "true");
      this.active = false;
      this.engine?.stop();
      this.observer?.disconnect();
      window.removeEventListener("scroll", this.onScroll);
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("pointermove", this.onPointer);
      window.removeEventListener("touchmove", this.onPointer);
    },
  };

  window.SummerMode = SummerMode;
  window.SummerMode.isItalianSchoolSummer = isItalianSchoolSummer;
})();
