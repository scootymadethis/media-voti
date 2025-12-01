document.addEventListener("DOMContentLoaded", async () => {
  const loggedIn = localStorage.getItem("loggedIn");
  if (!loggedIn) {
    window.location.href = "/index.html";
    return;
  }

  try {
    const res = await fetch("http://localhost:8000/card", {
      method: "POST",
      credentials: "include",
    });

    const data = await res.json();
    if (!res.ok) {
      console.log(data);
      // sessione scaduta o non valida
      localStorage.removeItem("loggedIn");
      window.location.href = "/index.html";
      return;
    }

    console.log("Card:", data.card);
  } catch (err) {
    console.error(err);
  }
});
