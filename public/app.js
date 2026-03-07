const form = document.getElementById("loginForm");
const msg = document.getElementById("loginMsg");

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
    const res = await fetch("/api/login", {
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
    console.log(
      "[login] set localStorage.loggedIn = true; origin:",
      location.origin,
    );

    msg.textContent = "Login OK!";
    window.location.href = "/dashboard.html";
  } catch (err) {
    console.error(err);
    msg.textContent = "Errore di rete / backend non raggiungibile";
  }
});

document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("loggedIn") === "true") {
    window.location.href = "/dashboard.html";
  }
});
