const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

let currentGameUrl = null;

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function gameUrlWithCacheBust(baseUrl) {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}t=${Date.now()}`;
}

function renderSetupPanel() {
  const shell = document.getElementById("gameContent");
  if (!shell) return;
  shell.innerHTML = `
    <section class="game-setup panel">
      <h2>Gioco non ancora caricato sul server</h2>
      <p>
        Il pulsante easter egg funziona, ma nella cartella
        <code>public/game/godot/</code> manca ancora l'export Web di Godot.
      </p>
      <p>Segui la guida in <code>public/game/GODOT.md</code> nel repository.</p>
      <ul>
        <li>Esporta il progetto Godot come <strong>Web</strong></li>
        <li>Copia tutti i file generati dentro <code>public/game/godot/</code></li>
        <li>Ricarica questa pagina</li>
      </ul>
    </section>
  `;
}

function getGameFrameWrap() {
  return document.getElementById("gameFrameWrap");
}

function getGodotFrame() {
  return document.getElementById("godotFrame");
}

function ensureGameFrameDom() {
  let wrap = getGameFrameWrap();
  if (wrap) return wrap;

  const shell = document.getElementById("gameContent");
  if (!shell) return null;

  wrap = document.createElement("div");
  wrap.id = "gameFrameWrap";
  wrap.className = "game-frame-wrap game-frame-wrap--hidden";
  wrap.setAttribute("aria-hidden", "true");

  const iframe = document.createElement("iframe");
  iframe.id = "godotFrame";
  iframe.title = "Gioco Easter egg";
  iframe.setAttribute("allow", "fullscreen");
  iframe.setAttribute("loading", "eager");

  wrap.appendChild(iframe);
  shell.appendChild(wrap);
  return wrap;
}

function loadGame({ reload = false } = {}) {
  if (!currentGameUrl) return null;

  const wrap = ensureGameFrameDom();
  const iframe = getGodotFrame();
  if (!wrap || !iframe) return null;

  const targetUrl = reload ? gameUrlWithCacheBust(currentGameUrl) : currentGameUrl;
  iframe.src = targetUrl;

  iframe.addEventListener(
    "load",
    () => {
      try {
        iframe.focus();
      } catch {
        /* ignore */
      }
    },
    { once: true },
  );

  return iframe;
}

function hideGameFrame() {
  const wrap = getGameFrameWrap();
  if (!wrap) return;
  wrap.classList.add("game-frame-wrap--hidden");
  wrap.setAttribute("aria-hidden", "true");
}

function showGameFrameForFullscreen() {
  const wrap = getGameFrameWrap();
  if (!wrap) return;
  wrap.classList.remove("game-frame-wrap--hidden");
  wrap.setAttribute("aria-hidden", "false");
}

async function openGameFullscreen() {
  if (!currentGameUrl) return;

  const iframe = getGodotFrame();
  if (!iframe?.src) {
    loadGame({ reload: false });
  }

  const wrap = ensureGameFrameDom();
  if (!wrap) return;

  showGameFrameForFullscreen();

  try {
    if (document.fullscreenElement !== wrap) {
      await wrap.requestFullscreen();
    }
  } catch (err) {
    console.warn("[game] fullscreen not available:", err);
    hideGameFrame();
  }
}

function reloadGame() {
  if (!currentGameUrl) return;
  loadGame({ reload: true });

  const wrap = getGameFrameWrap();
  if (document.fullscreenElement === wrap) return;

  const hint = document.getElementById("gameReloadHint");
  if (hint) {
    hint.textContent = "Gioco ricaricato. Apri Schermo intero per giocare.";
    hint.classList.add("visible");
    window.setTimeout(() => hint.classList.remove("visible"), 3200);
  }
}

function bindLauncherActions() {
  document.getElementById("gameFullscreenBtn")?.addEventListener("click", () => {
    openGameFullscreen();
  });
  document.getElementById("gameReloadBtn")?.addEventListener("click", () => {
    reloadGame();
  });
}

function onFullscreenChange() {
  const wrap = getGameFrameWrap();
  if (!wrap) return;

  if (document.fullscreenElement === wrap) return;

  hideGameFrame();
}

function renderGameLauncher(gameUrl) {
  currentGameUrl = gameUrl;
  const shell = document.getElementById("gameContent");
  if (!shell) return;

  shell.innerHTML = `
    <section class="game-launcher panel">
      <p class="game-launcher-hint">
        Per un'esperienza di gioco migliore, clicca <strong>Schermo intero</strong>.
      </p>
      <p id="gameReloadHint" class="game-reload-hint" aria-live="polite"></p>
      <div class="game-launcher-actions">
        <button type="button" class="btn-primary" id="gameFullscreenBtn">Schermo intero</button>
        <button type="button" class="btn-secondary" id="gameReloadBtn">Ricarica gioco</button>
      </div>
    </section>
  `;

  ensureGameFrameDom();
  bindLauncherActions();

  document.addEventListener("fullscreenchange", onFullscreenChange);
}

document.addEventListener("DOMContentLoaded", async () => {
  initMobileMenu();

  const session = await window.SessionAuth?.requireAuth();
  if (!session) return;

  try {
    const res = await fetch(apiUrl("/api/easter-egg/eligible"), {
      credentials: "include",
      cache: "no-store",
    });
    const data = await readJsonSafe(res);

    if (!res.ok || !data?.eligible) {
      window.location.href = "/dashboard/";
      return;
    }

    if (data.username) localStorage.setItem("username", data.username);

    if (data.game_ready && data.game_url) {
      renderGameLauncher(data.game_url);
    } else {
      renderSetupPanel();
    }
  } catch (err) {
    console.error("[game] gate failed:", err);
    window.location.href = "/dashboard/";
  }
});

function goToHome() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  }
  window.location.href = "/dashboard/";
}

function goToOrario() {
  window.location.href = "/orario/";
}

function goToVoti() {
  window.location.href = "/voti/";
}

function goToAssenze() {
  window.location.href = "/assenze/";
}

function logout() {
  window.SessionAuth?.logout();
}

function initMobileMenu() {
  const toggle = document.getElementById("navToggle");
  const drawer = document.getElementById("mobileNavDrawer");
  const backdrop = document.getElementById("mobileNavBackdrop");
  const closeBtn = document.getElementById("navDrawerClose");
  if (!toggle || !drawer || !backdrop) return;

  const openMenu = () => {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    document.body.classList.add("menu-open");
    toggle.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    drawer.setAttribute("aria-hidden", "false");
  };

  const closeMenu = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    document.body.classList.remove("menu-open");
    toggle.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
  };

  toggle.addEventListener("click", () =>
    drawer.classList.contains("open") ? closeMenu() : openMenu(),
  );
  backdrop.addEventListener("click", closeMenu);
  closeBtn?.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  drawer
    .querySelectorAll("button")
    .forEach((btn) => btn.addEventListener("click", closeMenu));
}
