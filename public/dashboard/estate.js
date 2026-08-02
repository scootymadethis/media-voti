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

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  class SeaEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.t = 0;
      this.scroll = 0;
      this.pointer = { x: 0.55, y: 0.3 };
      this.targetPointer = { x: 0.55, y: 0.3 };
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
      const count = Math.floor((this.w * this.h) / (12000 * this.dpr * this.dpr));
      this.sparks = Array.from({ length: Math.max(30, count) }, () => ({
        x: Math.random(),
        y: 0.42 + Math.random() * 0.52,
        r: 0.7 + Math.random() * 2.4,
        speed: 0.2 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
        glow: 0.4 + Math.random() * 0.6,
      }));
    }

    seedBirds() {
      this.birds = Array.from({ length: 5 }, (_, i) => ({
        x: Math.random(),
        y: 0.1 + Math.random() * 0.2,
        speed: 0.018 + Math.random() * 0.02,
        amp: 0.01 + Math.random() * 0.015,
        phase: Math.random() * Math.PI * 2,
        scale: 0.75 + i * 0.12,
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

    waveY(nx, base, amp, freq, speed, phase) {
      const px = this.pointer.x - 0.5;
      return (
        base +
        Math.sin(nx * freq + this.t * speed + phase) * amp +
        Math.sin(nx * freq * 2.05 - this.t * speed * 0.75 + phase * 1.7) * amp * 0.4 +
        Math.sin(nx * freq * 0.45 + this.t * speed * 0.35) * amp * 0.25 +
        px * amp * 0.9
      );
    }

    drawSky() {
      const { ctx, w, h, scroll, pointer } = this;
      ctx.clearRect(0, 0, w, h);

      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0b4470");
      g.addColorStop(0.35, "#1280a0");
      g.addColorStop(0.62, "#14a0b0");
      g.addColorStop(1, "#04556a");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const bloom = ctx.createRadialGradient(
        w * (0.72 + (pointer.x - 0.5) * 0.1),
        h * (0.18 + scroll * 0.06),
        0,
        w * 0.72,
        h * 0.22,
        h * 0.55,
      );
      bloom.addColorStop(0, "rgba(255, 220, 130, 0.55)");
      bloom.addColorStop(0.35, "rgba(120, 220, 255, 0.16)");
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, w, h);
    }

    drawSun() {
      const { ctx, w, h, t, scroll, pointer } = this;
      const sx = w * (0.74 + (pointer.x - 0.5) * 0.06);
      const sy = h * (0.17 + scroll * 0.07 + Math.sin(t * 0.45) * 0.008);
      const r = Math.min(w, h) * (0.1 + scroll * 0.015);

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(t * 0.12);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        ctx.rotate(a);
        const ray = ctx.createLinearGradient(0, 0, 0, r * 3.4);
        ray.addColorStop(0, "rgba(255, 225, 140, 0.45)");
        ray.addColorStop(1, "rgba(255, 225, 140, 0)");
        ctx.fillStyle = ray;
        ctx.beginPath();
        ctx.moveTo(-7, r * 0.85);
        ctx.lineTo(7, r * 0.85);
        ctx.lineTo(2, r * 3.3);
        ctx.lineTo(-2, r * 3.3);
        ctx.closePath();
        ctx.fill();
        ctx.rotate(-a);
      }
      ctx.restore();

      const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 1.9);
      core.addColorStop(0, "rgba(255, 252, 230, 1)");
      core.addColorStop(0.3, "rgba(255, 210, 110, 0.98)");
      core.addColorStop(0.65, "rgba(255, 150, 80, 0.4)");
      core.addColorStop(1, "rgba(255, 150, 80, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    drawBirds() {
      const { ctx, w, h, t } = this;
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 2.2 * this.dpr;
      ctx.lineCap = "round";
      for (const b of this.birds) {
        const x = ((b.x + t * b.speed) % 1.25) * w - w * 0.12;
        const y = h * (b.y + Math.sin(t * 1.5 + b.phase) * b.amp);
        const flap = Math.sin(t * 9 + b.phase) * 0.4;
        const s = 11 * this.dpr * b.scale;
        ctx.beginPath();
        ctx.moveTo(x - s, y + flap * s);
        ctx.quadraticCurveTo(x - s * 0.15, y - s * 0.4, x, y);
        ctx.quadraticCurveTo(x + s * 0.15, y - s * 0.4, x + s, y + flap * s);
        ctx.stroke();
      }
    }

    fillWave(baseRatio, ampRatio, freq, speed, phase, colorTop, colorBottom, foamAlpha) {
      const { ctx, w, h, t, scroll } = this;
      const base = h * (baseRatio - scroll * 0.035);
      const amp = h * (ampRatio + scroll * 0.012);
      const steps = Math.ceil(w / (8 * this.dpr));

      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const y = this.waveY(i / steps, base, amp, freq, speed, phase);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();

      const g = ctx.createLinearGradient(0, base - amp * 2.2, 0, h);
      g.addColorStop(0, colorTop);
      g.addColorStop(1, colorBottom);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        const y = this.waveY(i / steps, base, amp, freq, speed, phase);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(255,255,255,${foamAlpha})`;
      ctx.lineWidth = 2.6 * this.dpr;
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.7)";
      for (let i = 0; i < steps; i += 6) {
        const twinkle = 0.5 + 0.5 * Math.sin(t * 7 + i + phase);
        if (twinkle < 0.72) continue;
        const x = (i / steps) * w;
        const y = this.waveY(i / steps, base, amp, freq, speed, phase);
        ctx.beginPath();
        ctx.arc(x, y - 2.5 * this.dpr, 1.6 * this.dpr * twinkle, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawCaustics() {
      const { ctx, w, h, t, scroll } = this;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 8; i++) {
        const x = ((t * (22 + i * 9) + i * 110) % (w + 220)) - 110;
        const top = h * (0.5 - scroll * 0.03);
        const beam = ctx.createLinearGradient(x, top, x + 50, h);
        beam.addColorStop(0, "rgba(160, 240, 255, 0)");
        beam.addColorStop(0.3, `rgba(160, 240, 255, ${0.06 + (i % 3) * 0.025})`);
        beam.addColorStop(1, "rgba(160, 240, 255, 0)");
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x + 60 + i * 5, top);
        ctx.lineTo(x + 150 + i * 10, h);
        ctx.lineTo(x - 50 - i * 8, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    drawSparks() {
      const { ctx, w, h, t, sparks } = this;
      for (const s of sparks) {
        const x = s.x * w + Math.sin(t * s.speed + s.phase) * 20;
        const y = s.y * h + Math.cos(t * s.speed * 1.25 + s.phase) * 12;
        const a = (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 5.5 + s.phase))) * s.glow;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r * this.dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawBoat() {
      const { ctx, w, h, t, scroll } = this;
      const x = w * (0.22 + Math.sin(t * 0.28) * 0.04);
      const water = h * (0.6 - scroll * 0.035);
      const bob = Math.sin(t * 1.8) * 7 * this.dpr;
      const y = water + bob;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * 1.8) * 0.06);
      ctx.fillStyle = "rgba(7, 40, 60, 0.9)";
      ctx.beginPath();
      ctx.moveTo(-40 * this.dpr, 0);
      ctx.lineTo(44 * this.dpr, 0);
      ctx.quadraticCurveTo(30 * this.dpr, 20 * this.dpr, 0, 20 * this.dpr);
      ctx.quadraticCurveTo(-32 * this.dpr, 20 * this.dpr, -40 * this.dpr, 0);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 2.2 * this.dpr;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -46 * this.dpr);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 214, 120, 0.95)";
      ctx.beginPath();
      ctx.moveTo(2 * this.dpr, -44 * this.dpr);
      ctx.lineTo(30 * this.dpr, -20 * this.dpr);
      ctx.lineTo(2 * this.dpr, -14 * this.dpr);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    draw() {
      this.pointer.x += (this.targetPointer.x - this.pointer.x) * 0.07;
      this.pointer.y += (this.targetPointer.y - this.pointer.y) * 0.07;

      const { ctx, w, h } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawSky();
      this.drawSun();
      this.drawBirds();

      this.fillWave(0.52, 0.035, 7.2, 1.15, 0.2, "rgba(90, 220, 230, 0.72)", "rgba(20, 110, 140, 0.9)", 0.28);
      this.fillWave(0.6, 0.042, 5.6, 1.4, 1.3, "rgba(50, 200, 210, 0.8)", "rgba(12, 90, 120, 0.95)", 0.32);
      this.fillWave(0.7, 0.05, 4.1, 1.75, 2.2, "rgba(30, 160, 190, 0.92)", "rgba(6, 60, 90, 1)", 0.26);
      this.fillWave(0.8, 0.06, 3.2, 2.15, 3.4, "rgba(14, 100, 140, 0.98)", "rgba(2, 28, 48, 1)", 0.2);

      this.drawBoat();
      this.drawCaustics();
      this.drawSparks();

      const vig = ctx.createRadialGradient(w * 0.5, h * 0.42, h * 0.18, w * 0.5, h * 0.5, h * 0.9);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0, 18, 32, 0.35)");
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

  function ensureBackdrop() {
    let canvas = document.getElementById("summerSea");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "summerSea";
      canvas.className = "summer-sea-canvas";
      canvas.setAttribute("aria-hidden", "true");
    }
    if (canvas.parentElement !== document.body) {
      document.body.prepend(canvas);
    }

    let sun = document.getElementById("summerSunGlow");
    if (!sun) {
      sun = document.createElement("div");
      sun.id = "summerSunGlow";
      sun.className = "summer-sun-glow";
      sun.setAttribute("aria-hidden", "true");
      document.body.prepend(sun);
    }

    let waves = document.getElementById("summerWavesCss");
    if (!waves) {
      waves = document.createElement("div");
      waves.id = "summerWavesCss";
      waves.className = "summer-waves-css";
      waves.setAttribute("aria-hidden", "true");
      waves.innerHTML = `
        <svg class="wave-a" viewBox="0 0 1440 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="rgba(94, 231, 240, 0.45)" d="M0,192L48,176C96,160,192,128,288,133.3C384,139,480,181,576,186.7C672,192,768,160,864,154.7C960,149,1056,171,1152,181.3C1248,192,1344,192,1392,192L1440,192L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path>
          <path fill="rgba(94, 231, 240, 0.45)" transform="translate(1440)" d="M0,192L48,176C96,160,192,128,288,133.3C384,139,480,181,576,186.7C672,192,768,160,864,154.7C960,149,1056,171,1152,181.3C1248,192,1344,192,1392,192L1440,192L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path>
        </svg>
        <svg class="wave-b" viewBox="0 0 1440 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="rgba(14, 165, 233, 0.4)" d="M0,224L60,208C120,192,240,160,360,165.3C480,171,600,213,720,224C840,235,960,213,1080,192C1200,171,1320,149,1380,138.7L1440,128L1440,320L1380,320C1320,320,1200,320,1080,320C960,320,840,320,720,320C600,320,480,320,360,320C240,320,120,320,60,320L0,320Z"></path>
          <path fill="rgba(14, 165, 233, 0.4)" transform="translate(1440)" d="M0,224L60,208C120,192,240,160,360,165.3C480,171,600,213,720,224C840,235,960,213,1080,192C1200,171,1320,149,1380,138.7L1440,128L1440,320L1380,320C1320,320,1200,320,1080,320C960,320,840,320,720,320C600,320,480,320,360,320C240,320,120,320,60,320L0,320Z"></path>
        </svg>
        <svg class="wave-c" viewBox="0 0 1440 320" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <path fill="rgba(3, 70, 100, 0.75)" d="M0,288L48,272C96,256,192,224,288,224C384,224,480,256,576,250.7C672,245,768,203,864,197.3C960,192,1056,224,1152,234.7C1248,245,1344,235,1392,229.3L1440,224L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path>
          <path fill="rgba(3, 70, 100, 0.75)" transform="translate(1440)" d="M0,288L48,272C96,256,192,224,288,224C384,224,480,256,576,250.7C672,245,768,203,864,197.3C960,192,1056,224,1152,234.7C1248,245,1344,235,1392,229.3L1440,224L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z"></path>
        </svg>
      `;
      document.body.prepend(waves);
    }

    return canvas;
  }

  function removeBackdrop() {
    document.getElementById("summerSea")?.remove();
    document.getElementById("summerSunGlow")?.remove();
    document.getElementById("summerWavesCss")?.remove();
  }

  const SummerMode = {
    root: null,
    canvas: null,
    engine: null,
    observer: null,
    hint: null,
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
      this.hint = this.root?.querySelector(".summer-scroll-hint");
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
          window.scrollTo({
            top: 0,
            behavior: prefersReducedMotion() ? "auto" : "smooth",
          });
        });
        this.bound = true;
      }

      return true;
    },

    bindScroll() {
      const panels = [...this.root.querySelectorAll("[data-summer-reveal]")];
      this.observer?.disconnect();
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-inview");
            }
          }
        },
        { threshold: [0.12, 0.25, 0.4], rootMargin: "0px 0px -5% 0px" },
      );
      panels.forEach((p) => {
        p.classList.remove("is-inview");
        this.observer.observe(p);
      });
      // force hero visible after paint
      requestAnimationFrame(() => panels[0]?.classList.add("is-inview"));

      this.onScroll = () => {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const p = window.scrollY / max;
        this.engine?.setScrollProgress(p);
        if (this.hint) {
          this.hint.style.opacity = String(Math.max(0, 1 - p * 3.5));
          this.hint.style.visibility = p > 0.35 ? "hidden" : "visible";
        }
      };
      window.addEventListener("scroll", this.onScroll, { passive: true });
      this.onScroll();
    },

    bindPointer() {
      this.onPointer = (e) => {
        const x = "touches" in e ? e.touches[0]?.clientX : e.clientX;
        const y = "touches" in e ? e.touches[0]?.clientY : e.clientY;
        if (x == null || y == null) return;
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

      this.canvas = ensureBackdrop();
      // Hint fisso su body: evita clip da contenitori/navbar.
      if (this.hint && this.hint.parentElement !== document.body) {
        document.body.appendChild(this.hint);
      }
      document.body.classList.add("summer-active");
      this.root.hidden = false;
      this.root.removeAttribute("hidden");
      this.root.setAttribute("aria-hidden", "false");
      this.active = true;
      window.scrollTo({ top: 0, behavior: "auto" });

      try {
        if (!prefersReducedMotion()) {
          this.engine = new SeaEngine(this.canvas);
          this.engine.start();
          this.onResize = () => this.engine?.resize();
          window.addEventListener("resize", this.onResize);
          this.bindPointer();
        }
      } catch (err) {
        console.error("Summer sea engine failed, CSS waves still active", err);
      }

      this.bindScroll();
    },

    hide({ remember = false } = {}) {
      if (!this.active) return;
      if (remember) markDismissed();
      document.body.classList.remove("summer-active");
      this.root.hidden = true;
      this.root.setAttribute("hidden", "");
      this.root.setAttribute("aria-hidden", "true");
      this.active = false;
      this.engine?.stop();
      this.engine = null;
      this.observer?.disconnect();
      window.removeEventListener("scroll", this.onScroll);
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("pointermove", this.onPointer);
      window.removeEventListener("touchmove", this.onPointer);
      if (this.hint && this.root && this.hint.parentElement !== this.root) {
        this.root.prepend(this.hint);
      }
      removeBackdrop();
    },
  };

  window.SummerMode = SummerMode;
  window.SummerMode.isItalianSchoolSummer = isItalianSchoolSummer;
})();
