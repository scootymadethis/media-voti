// Prova end-to-end del collegamento PC ↔ telefono con l'interfaccia reale (Playwright).
// Avvia prima il server finto:  PORT=8011 .venv/bin/python scripts/dev_fake_server.py
// Poi:  BASE=http://127.0.0.1:8011 node scripts/e2e_pairing.js
// (se "playwright" non si trova: NODE_PATH=<cartella node_modules globale> node scripts/e2e_pairing.js)
const { chromium, devices } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8011";

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const pc = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  const phone = await (await browser.newContext({ ...devices["Pixel 7"] })).newPage();
  for (const [n, p] of [["pc", pc], ["phone", phone]]) p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));

  // Telefono: sessione "SPID" (campo di sviluppo del server finto)
  await phone.goto(BASE + "/");
  await phone.evaluate(async () => {
    const r = await fetch("/api/login/web-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phpsessid: "devsession000000001" }) });
    if (!r.ok) throw new Error("login telefono fallito");
  });

  // PC: la pagina di accesso mostra QR e codice
  await pc.goto(BASE + "/");
  await pc.waitForFunction(() => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector("[data-code]")?.textContent || ""), null, { timeout: 10000 });
  const code = (await pc.textContent("[data-code]")).trim();
  const qr = await pc.locator("[data-qr] svg").count();

  // Telefono: apre il link del QR e conferma
  await phone.goto(`${BASE}/collega?code=${code}`);
  await phone.waitForSelector("[data-confirm]", { timeout: 10000 });
  await phone.click("[data-confirm]");

  // PC: entra nell'app
  await pc.waitForURL("**/oggi", { timeout: 10000 });
  await pc.waitForSelector(".large-title", { timeout: 10000 });
  const title = (await pc.textContent(".large-title")).trim();

  console.log(JSON.stringify({ code, qr, pcUrl: pc.url(), title, errors }, null, 2));
  await browser.close();
  if (errors.length || !qr) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
