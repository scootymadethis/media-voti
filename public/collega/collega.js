// Pagina "Dispositivi": conferma il collegamento di un PC (codice o QR) ed elenca/scollega
// i dispositivi che usano lo stesso accesso a ClasseViva.
const apiUrl = (path) => window.APP_CONFIG?.apiUrl?.(path) ?? path;

function goToHome() {
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

const codeForm = document.getElementById("codeForm");
const codeInput = document.getElementById("codeInput");
const codeMsg = document.getElementById("codeMsg");
const confirmBox = document.getElementById("confirmBox");
const confirmDevice = document.getElementById("confirmDevice");
const confirmTime = document.getElementById("confirmTime");
const confirmBtn = document.getElementById("confirmBtn");
const cancelBtn = document.getElementById("cancelBtn");
const scanBtn = document.getElementById("scanQrBtn");
const deviceList = document.getElementById("deviceList");

let pendingCode = null;

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function api(path, body) {
  const res = await fetch(apiUrl(path), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readJsonSafe(res);
  if (res.status === 401) {
    await window.SessionAuth?.handleAuthFail?.(res);
  }
  return { res, data };
}

function normalizeCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

// Il QR contiene https://<sito>/collega/?code=XXXX-XXXX
function codeFromScan(text) {
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (code) return normalizeCode(code);
  } catch {
    /* non è un URL: forse il codice da solo */
  }
  return normalizeCode(text);
}

function resetConfirm() {
  pendingCode = null;
  confirmBox.hidden = true;
  codeForm.hidden = false;
}

async function lookup(code) {
  codeMsg.textContent = "Verifico il codice…";
  codeMsg.dataset.tone = "";
  const { res, data } = await api("/api/pair/lookup", { code });
  if (!res.ok) {
    codeMsg.textContent = data?.detail || "Codice non valido o scaduto.";
    codeMsg.dataset.tone = "warn";
    return;
  }
  pendingCode = code;
  codeMsg.textContent = "";
  confirmDevice.textContent = data.device_label || "un dispositivo";
  confirmTime.textContent = new Date((data.requested_at || Date.now() / 1000) * 1000).toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  });
  codeForm.hidden = true;
  confirmBox.hidden = false;
  confirmBtn.focus();
}

codeInput.addEventListener("input", () => {
  codeInput.value = normalizeCode(codeInput.value);
});

codeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode(codeInput.value);
  if (code.length !== 9) {
    codeMsg.textContent = "Il codice ha 8 caratteri, ad esempio K7PQ-4XZ2.";
    codeMsg.dataset.tone = "warn";
    return;
  }
  lookup(code);
});

confirmBtn.addEventListener("click", async () => {
  if (!pendingCode) return;
  confirmBtn.disabled = true;
  const { res, data } = await api("/api/pair/confirm", { code: pendingCode });
  confirmBtn.disabled = false;
  resetConfirm();
  codeInput.value = "";
  if (res.ok) {
    codeMsg.textContent = `${data?.device_label || "PC"} collegato. Sul computer si apre il tuo spazio.`;
    codeMsg.dataset.tone = "ok";
    loadDevices();
  } else {
    codeMsg.textContent = data?.detail || "Collegamento non riuscito. Genera un nuovo codice sul PC.";
    codeMsg.dataset.tone = "warn";
  }
});

cancelBtn.addEventListener("click", () => {
  resetConfirm();
  codeMsg.textContent = "Collegamento annullato.";
  codeMsg.dataset.tone = "";
  codeInput.focus();
});

// Scansione QR nell'app, se è installato @capacitor-mlkit/barcode-scanning (opzionale).
// Fuori dall'app basta inquadrare il QR con la fotocamera: apre questa pagina col codice.
const scanner = window.Capacitor?.Plugins?.BarcodeScanner;
if (scanner && window.Capacitor?.isNativePlatform?.()) {
  scanBtn.hidden = false;
  scanBtn.addEventListener("click", async () => {
    try {
      const result = await scanner.scan();
      const raw = result?.barcodes?.[0]?.rawValue;
      if (!raw) return;
      const code = codeFromScan(raw);
      codeInput.value = code;
      if (code.length === 9) lookup(code);
    } catch (err) {
      console.warn("[collega] scansione annullata o non riuscita:", err);
    }
  });
}

function relativeTime(epochSeconds) {
  if (!epochSeconds) return "";
  const diff = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (diff < 60) return "attivo ora";
  if (diff < 3600) return `attivo ${Math.round(diff / 60)} min fa`;
  return `attivo alle ${new Date(epochSeconds * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
}

function renderDevices(devices) {
  deviceList.textContent = "";
  if (!devices.length) {
    const li = document.createElement("li");
    li.className = "device-empty";
    li.textContent = "Nessun dispositivo collegato.";
    deviceList.append(li);
    return;
  }
  for (const device of devices) {
    const li = document.createElement("li");
    li.className = "device-item";
    const info = document.createElement("div");
    info.className = "device-info";
    const name = document.createElement("strong");
    name.textContent = device.label;
    const meta = document.createElement("span");
    const via = device.linked_via === "pairing" ? "collegato dal telefono · " : "";
    meta.textContent = `${via}${relativeTime(device.last_seen)}`;
    info.append(name, meta);
    li.append(info);
    if (device.current) {
      const tag = document.createElement("span");
      tag.className = "device-tag";
      tag.textContent = "Questo dispositivo";
      li.append(tag);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "devices-btn devices-btn-danger";
      btn.textContent = "Scollega";
      btn.setAttribute("aria-label", `Scollega ${device.label}`);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { res } = await api("/api/devices/revoke", { device_id: device.device_id });
        if (res.ok) loadDevices();
        else btn.disabled = false;
      });
      li.append(btn);
    }
    deviceList.append(li);
  }
}

async function loadDevices() {
  const { res, data } = await api("/api/devices");
  if (res.ok) renderDevices(data?.devices || []);
}

(async function init() {
  const session = await window.SessionAuth.requireAuth({ redirectTo: "/" });
  if (!session) return;
  const fromUrl = new URLSearchParams(window.location.search).get("code");
  if (fromUrl) {
    codeInput.value = normalizeCode(fromUrl);
    history.replaceState({}, "", window.location.pathname);
    if (codeInput.value.length === 9) lookup(codeInput.value);
  }
  loadDevices();
})();
