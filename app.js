const form = document.getElementById("loginForm");
const msg = document.getElementById("loginMsg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  msg.textContent = "Login in corso...";

  try {
    const res = await fetch("http://localhost:8000/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // IMPORTANTISSIMO: prende il cookie
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.detail || data.error || "Login fallito";
      return;
    }

    localStorage.setItem("loggedIn", "true");

    msg.textContent = "Login OK!";
    window.location.href = "/dashboard.html";
  } catch (err) {
    console.error(err);
    msg.textContent = "Errore di rete / backend non raggiungibile";
  }
});
