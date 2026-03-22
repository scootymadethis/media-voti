const form = document.getElementById("loginForm");
const msg = document.getElementById("loginMsg");
const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  msg.textContent = "Login in corso...";

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
      body: JSON.stringify({ username, password }),
    });
    console.log("[login] response URL:", res.url, "status:", res.status);
    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.warn("[login] failed to parse JSON response:", err);
      data = null;
    }
    console.log("[login] response body:", data);
    if (!res.ok) {
      msg.textContent = data?.detail || data?.error || "Login fallito";
      console.warn("[login] login not ok, not setting localStorage.loggedIn");
      return;
    }

    localStorage.setItem("loggedIn", "true");
    localStorage.setItem("username", username);
    console.log(
      "[login] set localStorage.loggedIn = true; origin:",
      location.origin,
    );

    msg.textContent = "Login OK!";
    window.location.href = "/dashboard/";
  } catch (err) {
    console.error(err);
    msg.textContent = "Errore di rete / backend non raggiungibile";
  }
});

document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("loggedIn") === "true") {
    window.location.href = "/dashboard/";
  }
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