const form = document.getElementById("loginForm");
const msg = document.getElementById("loginMsg");
const submitBtn = form?.querySelector('[type="submit"]');
const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch (err) {
    console.warn("[login] failed to parse JSON response:", err);
    return null;
  }
}

function clearClientLoginState() {
  window.SessionAuth?.clearLegacyClientState?.();
}

async function verifyLoginWithCard() {
  const res = await fetch(apiUrl("/api/card"), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });

  return {
    ok: res.ok,
    status: res.status,
    data: await readJsonSafe(res),
  };
}

function loginFailedMessage(status, data) {
  if (status === 401) return "Password errata";
  return data?.detail || data?.error || "Login fallito";
}

function authMessageFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get("auth");
  if (!auth) return "";
  if (auth === "session-expired") {
    return "Sessione scaduta, effettua di nuovo il login.";
  }
  if (auth === "auth-required") {
    return "Devi effettuare il login per continuare.";
  }
  return "";
}

function clearAuthMessageFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("auth")) return;
  url.searchParams.delete("auth");
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", next);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  clearClientLoginState();
  clearAuthMessageFromUrl();
  msg.textContent = "Login in corso...";
  if (submitBtn) submitBtn.disabled = true;

  try {
    console.log("[login] origin:", location.origin);
    console.log(
      "[login] before submit, localStorage.loggedIn:",
      localStorage.getItem("loggedIn"),
    );

    const res = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // IMPORTANTISSIMO: prende il cookie
      cache: "no-store",
      body: JSON.stringify({ username, password }),
    });

    console.log("[login] response URL:", res.url, "status:", res.status);
    const data = await readJsonSafe(res);
    console.log("[login] response body:", data);

    if (!res.ok) {
      msg.textContent = loginFailedMessage(res.status, data);
      console.warn("[login] login not ok, not setting localStorage.loggedIn");
      return;
    }

    // La libreria ClasseVivaAPI può far tornare 200 su /login anche con password errata.
    // Prima di segnare il login come valido, verifichiamo la sessione con /card:
    // 200 = credenziali valide, 401/altro = login fallito.
    msg.textContent = "Verifica credenziali...";
    const cardCheck = await verifyLoginWithCard();
    console.log("[login] card verification status:", cardCheck.status, cardCheck.data);

    if (!cardCheck.ok) {
      clearClientLoginState();
      msg.textContent = loginFailedMessage(cardCheck.status, cardCheck.data);
      console.warn("[login] card check failed, not setting localStorage.loggedIn");
      return;
    }

    if (username) localStorage.setItem("username", username);

    msg.textContent = "Login OK!";
    window.location.href = "/dashboard/";
  } catch (err) {
    console.error(err);
    clearClientLoginState();
    msg.textContent = "Errore di rete / backend non raggiungibile";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  const authMessage = authMessageFromUrl();
  msg.textContent = authMessage || "Verifica sessione...";
  try {
    const { res, data } = await window.SessionAuth.fetchSession();
    if (res.ok && data?.authenticated) {
      window.location.href = "/dashboard/";
      return;
    }
  } catch (err) {
    console.warn("[login] session verification failed:", err);
  }

  clearClientLoginState();
  if (!authMessage) {
    msg.textContent = "";
  }
  clearAuthMessageFromUrl();
});

// --- Modal credenziali ---
const credenzialiModal = document.getElementById("credenzialiModal");
const modalTitle = document.getElementById("credenzialiModalTitle");
const modalText = document.getElementById("credenzialiModalText");
const modalCloseBtn = document.getElementById("credenzialiModalClose");

function openModal() {
  if (!credenzialiModal) return;

  credenzialiModal.classList.add("show");
  credenzialiModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  modalCloseBtn?.focus();
}

function closeModal() {
  if (!credenzialiModal) return;
  credenzialiModal.classList.remove("show");
  credenzialiModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.addEventListener("click", (ev) => {
  const credenzialiText = ev.target.closest?.(".credenziali-model-open");
  if (!credenzialiText || credenzialiText.closest(".modal")) return;

  openModal();
});

modalCloseBtn?.addEventListener("click", closeModal);
credenzialiModal?.addEventListener("click", (e) => {
  if (e.target === credenzialiModal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

const passwordInput = document.getElementById("password");
const togglePasswordBtn = document.getElementById("togglePassword");

togglePasswordBtn?.addEventListener("click", () => {
  const isHidden = passwordInput.type === "password";

  passwordInput.type = isHidden ? "text" : "password";
  togglePasswordBtn.textContent = !isHidden ? "🙈" : "🐵";
  togglePasswordBtn.setAttribute(
    "aria-label",
    isHidden ? "Nascondi password" : "Mostra password",
  );
  togglePasswordBtn.setAttribute("aria-pressed", String(isHidden));
});
