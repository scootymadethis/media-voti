document.addEventListener("DOMContentLoaded", async () => {
  const loading = document.getElementById("loading-overlay");
  if (loading) loading.classList.remove("hidden");

  if (localStorage.getItem("loggedIn") !== "true") {
    window.location.href = "/index.html";
    return;
  }

  try {
    let materie = [];
    const votiData = await fetchVoti();

    if (votiData) console.log(votiData.voti.grades);

    const voti = votiData.voti.grades;
    voti.forEach((voto) => {
      if (!materie.includes(voto.subjectDesc)) {
        materie.push(voto.subjectDesc);
      }
    });

    if(materie != null && voti != null) renderVoti(materie, voti);

    loading?.classList.add("hidden");
  } catch (err) {
    console.error(err);
    document.getElementById("loading-overlay")?.classList.add("hidden");
  }
});

// --- Voti ---
async function fetchVoti() {
  const res = await fetch("http://localhost:8000/voti", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    await handleAuthFail(res);
    throw new Error("Failed to fetch voti");
  }
  return await res.json();
}

function renderVoti(materie, voti) {
  const materieDiv = document.querySelector(".voti-materie");
  const votiDiv = document.querySelector(".actual-voti");
  const averageDiv = document.querySelector(".average");

  materieDiv.innerHTML = "";
  votiDiv.innerHTML = "";
  averageDiv.innerHTML = "";

  materie.forEach((materia) => {
    let materiaDiv = document.createElement("div");
    materiaDiv.classList.add("materia");
    materiaDiv.textContent = materia;
    materieDiv.appendChild(materiaDiv);
  });
}

async function handleAuthFail(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  console.log("Auth fail:", res.status, body);
  localStorage.removeItem("loggedIn");
  window.location.href = "/index.html";
}
