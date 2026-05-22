const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
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

function enterGameLayoutMode() {
  document.body.classList.add("game-page--playing");
}

function toggleGameFullscreen() {
  const frame = document.getElementById("gameFrameWrap");
  if (!frame) return;

  if (document.fullscreenElement === frame) {
    document.exitFullscreen?.();
    return;
  }

  frame.requestFullscreen?.().catch((err) => {
    console.warn("[game] fullscreen not available:", err);
  });
}

function renderGameFrame(gameUrl) {
  const shell = document.getElementById("gameContent");
  if (!shell) return;

  enterGameLayoutMode();

  shell.innerHTML = `
    <div class="game-toolbar">
      <button type="button" id="gameFullscreenBtn">Schermo intero</button>
    </div>
    <div class="game-frame-wrap" id="gameFrameWrap">
      <iframe
        id="godotFrame"
        src="${gameUrl}"
        title="Gioco Easter egg"
        allow="fullscreen"
        loading="eager"
      ></iframe>
    </div>
  `;

  document.getElementById("gameFullscreenBtn")?.addEventListener("click", toggleGameFullscreen);

  const frame = document.getElementById("godotFrame");
  frame?.addEventListener("load", () => {
    try {
      frame.focus();
    } catch {
      /* ignore */
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/";
    return;
  }

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
      renderGameFrame(data.game_url);
    } else {
      renderSetupPanel();
    }
  } catch (err) {
    console.error("[game] gate failed:", err);
    window.location.href = "/dashboard/";
  }
});

function goToHome() {
  window.location.href = "/dashboard/";
}
