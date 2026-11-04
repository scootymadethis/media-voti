// Accesso: nell'app "Entra con SPID o CIE"; sul web "Accedi tramite telefono" (QR + codice).
// Sul PC la pagina è anche una presentazione di Ardesia, con animazioni legate allo scroll.
import { get, post } from "aulera/api";
import { html, raw, icon, setHTML, $, $$, openSheet, toast } from "aulera/ui";

const POLL_MS = 2000;

function inApp() { return !!window.ArdesiaSpid?.isAvailable?.(); }

const PRIVACY = html`<div class="md">
  <p>Ardesia è un'app indipendente, <strong>non affiliata</strong> a Gruppo Spaggiari Parma né a ClasseViva.</p>
  <p style="margin-top:10px">L'accesso avviene sulla pagina <strong>ufficiale</strong> di ClasseViva, con SPID o CIE: Ardesia non vede e non conserva mai le tue credenziali.
  Riceve solo la sessione temporanea che ClasseViva crea dopo l'accesso, la usa per leggere i tuoi dati del registro e la dimentica quando esci o quando scade.</p>
  <p style="margin-top:10px">I dati letti dal registro servono solo a mostrarti voti, agenda, bacheca e le altre sezioni. Se partecipi alle classifiche, Ardesia salva nome, classe, media e ore di assenza; puoi nasconderti quando vuoi dal tuo profilo.</p>
  <p style="margin-top:10px">Nessun dato viene venduto o ceduto a terzi.</p>
</div>`;

function brandMark() {
  return html`<div class="login-brand"><img src="/assets/ardesia-mark.svg" alt="" /><span>Ardesia</span></div>`;
}

/* ---------------- abbinamento PC/browser ---------------- */
function pairCard({ compact = false } = {}) {
  return html`<section class="pair-card glass" aria-labelledby="pair-title">
    <div class="pair-top">
      <span class="row-icon">${icon("phone")}</span>
      <div><h2 id="pair-title" class="title-3">Accedi tramite telefono</h2>
        <p class="caption">Entra con SPID o CIE dall'app Ardesia, poi collega questo dispositivo.</p></div>
    </div>
    <div class="pair-body">
      <div class="pair-qr" data-qr role="img" aria-label="Codice QR per collegare questo dispositivo"><div class="skeleton" style="width:100%;height:100%"></div></div>
      <div class="pair-code-wrap">
        <span class="overline">Codice</span>
        <output class="pair-code tnum" data-code>····-····</output>
        <span class="caption tnum" data-expiry>&nbsp;</span>
      </div>
    </div>
    <ol class="pair-steps${compact ? " is-compact" : ""}">
      <li><span>1</span><p>Apri l'app Ardesia ed entra con <strong>SPID o CIE</strong>.</p></li>
      <li><span>2</span><p>Vai in <strong>Dispositivi</strong> e tocca <strong>Collega</strong>.</p></li>
      <li><span>3</span><p>Inquadra il QR o scrivi il codice.</p></li>
    </ol>
    <p class="pair-status caption" data-status role="status" aria-live="polite"></p>
    <button type="button" class="btn btn-block" data-renew hidden>${icon("refresh")}Genera un nuovo codice</button>
    <details class="dev-session" data-dev hidden><summary class="caption">Sviluppo: accedi con un cookie di sessione</summary>
      <form data-dev-form class="stack-sm" style="margin-top:10px"><input class="field" type="password" autocomplete="off" placeholder="Valore di PHPSESSID" required />
        <button class="btn btn-primary" type="submit">Accedi</button></form></details>
  </section>`;
}

function startPairing(root, onLoggedIn) {
  const qrBox = $("[data-qr]", root);
  const codeEl = $("[data-code]", root);
  const expiryEl = $("[data-expiry]", root);
  const statusEl = $("[data-status]", root);
  const renew = $("[data-renew]", root);
  let pairId = null, expiresAt = 0, poll = null, tick = null, busy = false, stopped = false;

  const stop = () => { clearInterval(poll); clearInterval(tick); poll = tick = null; };
  const expired = () => {
    stop();
    pairId = null;
    root.querySelector(".pair-card")?.classList.add("is-expired");
    expiryEl.textContent = "Codice scaduto";
    statusEl.textContent = "";
    renew.hidden = false;
  };
  const updateExpiry = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (!left) return expired();
    expiryEl.textContent = `Scade tra ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  };
  const drawQr = (text) => {
    if (typeof window.qrcode !== "function") { qrBox.hidden = true; return; }
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // SVG generato localmente
  };
  const check = async () => {
    if (!pairId || busy) return;
    busy = true;
    try {
      const data = await post("/pair/status", { pair_id: pairId }, { quiet401: true });
      if (data.status === "approved") {
        stop();
        statusEl.textContent = "Collegato. Un attimo…";
        root.querySelector(".pair-card")?.classList.add("is-approved");
        onLoggedIn();
      } else if (data.status === "expired") expired();
    } catch { /* rete: riprova al prossimo giro */ } finally { busy = false; }
  };
  const start = async () => {
    stop();
    root.querySelector(".pair-card")?.classList.remove("is-expired", "is-approved");
    renew.hidden = true;
    statusEl.textContent = "";
    try {
      const data = await post("/pair/start", {}, { quiet401: true });
      if (stopped) return;
      pairId = data.pair_id;
      expiresAt = Date.now() + (data.expires_in || 300) * 1000;
      codeEl.textContent = data.code;
      drawQr(`${location.origin}/collega?code=${encodeURIComponent(data.code)}`);
      statusEl.textContent = "In attesa di conferma dal telefono…";
      updateExpiry();
      tick = setInterval(updateExpiry, 1000);
      poll = setInterval(check, POLL_MS);
    } catch (err) {
      statusEl.textContent = err.message;
      renew.hidden = false;
    }
  };
  renew.addEventListener("click", start);
  // Se la scheda torna visibile, controlla subito (il telefono potrebbe aver già confermato).
  const onVis = () => { if (!document.hidden) check(); };
  document.addEventListener("visibilitychange", onVis);
  start();

  get("/auth/options", { quiet401: true }).then((o) => {
    if (!o?.manual_web_session) return;
    const dev = $("[data-dev]", root);
    dev.hidden = false;
    $("[data-dev-form]", dev).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await post("/login/web-session", { phpsessid: $("input", dev).value.trim() }, { quiet401: true });
        onLoggedIn();
      } catch (err) { toast(err.message, { error: true }); }
    });
  }).catch(() => {});

  return () => { stopped = true; stop(); document.removeEventListener("visibilitychange", onVis); };
}

/* ---------------- app: SPID/CIE nativo ---------------- */
function renderApp(root, onLoggedIn) {
  setHTML(root, html`<div class="login-app">
    <div class="login-app-hero">
      <div class="app-icon glass">${raw('<img src="/assets/ardesia-mark.svg" alt="" />')}</div>
      <h1 class="large-title">La scuola,<br /><span class="gradient-text">finalmente chiara.</span></h1>
      <p class="body-2">Voti, agenda, bacheca e orario del tuo registro, in un'unica app.</p>
    </div>
    <div class="login-app-actions">
      <button type="button" class="btn btn-primary btn-lg btn-block spid-btn" data-spid>${icon("id")}Entra con SPID o CIE</button>
      <p class="caption" data-msg role="status" aria-live="polite"></p>
      <p class="caption faint">Accedi sulla pagina ufficiale di ClasseViva. Continuando accetti l'<button type="button" class="link" data-privacy>informativa</button>.</p>
    </div>
  </div>`);
  const msg = $("[data-msg]", root);
  $("[data-spid]", root).addEventListener("click", () => {
    window.ArdesiaSpid.start({
      onStatus: (text) => { msg.textContent = text; },
      onSuccess: onLoggedIn,
    });
  });
  $("[data-privacy]", root).addEventListener("click", () => openSheet({ title: "Informativa", content: PRIVACY }));
}

/* ---------------- web: presentazione + accesso tramite telefono ---------------- */
const SCREENS = [
  { key: "voti", title: "Ogni voto, nel suo contesto.", text: "Medie per materia e per periodo, l'andamento nel tempo e quanto ti serve per arrivare al voto che vuoi in pagella." },
  { key: "agenda", title: "La settimana, a colpo d'occhio.", text: "Compiti, verifiche e lezioni in un'unica agenda. Spunta i compiti fatti e ritrova gli argomenti di ogni lezione." },
  { key: "bacheca", title: "Niente più circolari perse.", text: "Bacheca, note e materiali dei docenti, con gli allegati a un tocco. Quelle da leggere sono sempre in cima." },
  { key: "orario", title: "L'orario che sta in tasca.", text: "Tutta la settimana su un solo schermo, anche dal telefono. Con l'ora in corso sempre evidenziata." },
];

function phoneScreen(key) {
  const g = (v, c) => `<span class="grade grade-sm ${c}">${v}</span>`;
  const screens = {
    voti: `<div class="mock-title">Voti</div><div class="mock-hero"><div class="mock-ring"><span>7,62</span></div><div><b>Media generale</b><small>Primo periodo · 24 voti</small></div></div>
      ${[["Matematica", "8", "g-great", "7,9"], ["Informatica", "9", "g-great", "8,4"], ["Italiano", "6½", "g-good", "6,8"], ["Inglese", "7+", "g-good", "7,2"], ["Storia", "5½", "g-bad", "5,8"], ["Fisica", "3", "g-bad g-fire", "4,9"]]
        .map(([s, v, c, m]) => `<div class="mock-row">${g(v, c)}<div><b>${s}</b><small>Media ${m}</small></div></div>`).join("")}`,
    agenda: `<div class="mock-title">Agenda</div><div class="mock-days">${["L", "M", "M", "G", "V"].map((d, i) => `<span class="${i === 2 ? "on" : ""}">${d}<b>${10 + i}</b></span>`).join("")}</div>
      ${[["08:00", "Verifica di matematica", "Studio di funzione", "bad"], ["10:50", "Inglese", "Essay da consegnare", "accent"], ["12:00", "Informatica", "Schema ER biblioteca", "accent"], ["—", "Uscita didattica", "Museo di storia naturale", "ok"]]
        .map(([t, a, b, c]) => `<div class="mock-row"><span class="mock-time">${t}</span><div class="mock-bar ${c}"></div><div><b>${a}</b><small>${b}</small></div></div>`).join("")}`,
    bacheca: `<div class="mock-title">Bacheca</div>${[["Assemblea di istituto", "Circolare n. 112", true], ["Uscita classi quinte", "Comunicazione", true], ["Colloqui generali", "Circolare", false], ["Open day universitari", "Orientamento", false]]
        .map(([a, b, u]) => `<div class="mock-row">${u ? '<span class="dot"></span>' : '<span class="dot off"></span>'}<div><b>${a}</b><small>${b} · PDF</small></div></div>`).join("")}`,
    orario: `<div class="mock-title">Orario</div><div class="mock-grid">${["", "L", "M", "M", "G", "V"].map((d) => `<i>${d}</i>`).join("")}
      ${[1, 2, 3, 4, 5].map((h) => `<i>${h}</i>` + ["MAT", "INF", "ITA", "SIS", "ING"].map((s, i) => `<span class="c${(h + i) % 5}${h === 2 && i === 2 ? " now" : ""}">${["MAT", "INF", "ITA", "SIS", "ING"][(h * 2 + i) % 5]}</span>`).join("")).join("")}</div>`,
  };
  return screens[key];
}

function renderWeb(root, onLoggedIn) {
  const mobile = matchMedia("(max-width: 719px)").matches;
  setHTML(root, html`<div class="landing">
    <header class="landing-nav glass">
      ${brandMark()}
      <a class="btn btn-primary" href="#accedi">Accedi</a>
    </header>

    <section class="hero" id="accedi">
      <div class="hero-copy">
        <p class="overline hero-kicker">Il tuo registro ClasseViva</p>
        <h1 class="hero-title">La scuola,<br /><span class="gradient-text">finalmente chiara.</span></h1>
        <p class="hero-sub">Voti, agenda, bacheca, didattica e orario in un'unica app. Veloce, ordinata e pensata per il telefono. Si accede con SPID o CIE.</p>
        <div class="hero-badges"><span class="chip">${icon("lock")}SPID e CIE</span><span class="chip">${icon("phone")}Android e iPhone</span><span class="chip">${icon("devices")}Anche su PC</span></div>
      </div>
      <div class="hero-login">${pairCard({ compact: mobile })}
        <p class="caption faint" style="text-align:center;margin-top:14px">Continuando accetti l'<button type="button" class="link" data-privacy>informativa</button>.</p></div>
    </section>

    <section class="story" aria-label="Cosa puoi fare con Ardesia">
      <div class="story-phone-wrap"><div class="story-phone glass" aria-hidden="true">
        <div class="phone-notch"></div>
        ${SCREENS.map((s, i) => html`<div class="phone-screen${i === 0 ? " is-active" : ""}" data-screen="${s.key}">${raw(phoneScreen(s.key))}</div>`)}
      </div></div>
      <div class="story-steps">
        ${SCREENS.map((s, i) => html`<article class="story-step" data-step="${s.key}"><p class="overline">${String(i + 1).padStart(2, "0")}</p>
          <h2 class="story-title">${s.title}</h2><p class="body-2">${s.text}</p></article>`)}
      </div>
    </section>

    <section class="features">
      <h2 class="section-title reveal">Tutto il registro.<br /><span class="faint">Niente di superfluo.</span></h2>
      <div class="feature-grid">
        ${[["grades", "Voti e medie", "Per materia, per periodo e con il calcolo del voto che ti serve."],
           ["calendar", "Agenda e compiti", "Verifiche, compiti da spuntare e argomenti delle lezioni."],
           ["megaphone", "Bacheca", "Circolari e allegati, con quelle da leggere sempre in evidenza."],
           ["folder", "Didattica", "I file e i link condivisi dai docenti, cartella per cartella."],
           ["note", "Note e assenze", "Ritardi, uscite, giustificazioni e note in un solo posto."],
           ["trophy", "Classifiche", "Confrontati con la classe, se vuoi. Puoi sempre nasconderti."]]
          .map(([ic, t, d]) => html`<article class="feature card reveal"><span class="row-icon">${icon(ic)}</span><h3 class="title-3">${t}</h3><p class="body-2">${d}</p></article>`)}
      </div>
    </section>

    <section class="how">
      <h2 class="section-title reveal">Perché si entra<br />dal telefono?</h2>
      <div class="how-grid">
        <article class="card card-pad reveal"><p class="overline">La legge</p><p class="title-3" style="margin-top:6px">Dal 2026 il registro si apre solo con SPID o CIE.</p><p class="body-2" style="margin-top:8px">Username e password di ClasseViva non funzionano più per la maggior parte delle scuole.</p></article>
        <article class="card card-pad reveal"><p class="overline">La sicurezza</p><p class="title-3" style="margin-top:6px">Le credenziali restano tue.</p><p class="body-2" style="margin-top:8px">Entri sulla pagina ufficiale di ClasseViva dall'app. Ardesia riceve solo la sessione, mai SPID o CIE.</p></article>
        <article class="card card-pad reveal"><p class="overline">Il PC</p><p class="title-3" style="margin-top:6px">Collega il computer in due secondi.</p><p class="body-2" style="margin-top:8px">Inquadra il QR con l'app e il PC si apre sul tuo spazio. Lo scolleghi quando vuoi.</p></article>
      </div>
    </section>

    <footer class="landing-foot"><span>Ardesia non è affiliato a ClasseViva né a Gruppo Spaggiari Parma.</span>
      <button type="button" class="link" data-privacy>Informativa</button></footer>
  </div>`);

  $$("[data-privacy]", root).forEach((b) => b.addEventListener("click", () => openSheet({ title: "Informativa", content: PRIVACY })));
  const stopPair = startPairing(root, onLoggedIn);

  // Racconto a scorrimento: la schermata del telefono segue il paragrafo in vista.
  const screens = $$(".phone-screen", root);
  const stepObs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const key = e.target.dataset.step;
      screens.forEach((s) => s.classList.toggle("is-active", s.dataset.screen === key));
      $$(".story-step", root).forEach((s) => s.classList.toggle("is-active", s === e.target));
    });
  }, { rootMargin: "-45% 0px -45% 0px" });
  $$(".story-step", root).forEach((s) => stepObs.observe(s));

  // Rivelazioni allo scroll: CSS scroll-driven dove c'è, altrimenti IntersectionObserver (una volta).
  let revealObs = null;
  if (!CSS.supports("animation-timeline: view()")) {
    revealObs = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); revealObs.unobserve(e.target); }
    }), { rootMargin: "0px 0px -10% 0px" });
    $$(".reveal", root).forEach((el) => revealObs.observe(el));
  } else document.documentElement.classList.add("has-scroll-timeline");

  const nav = $(".landing-nav", root);
  const onScroll = () => nav.classList.toggle("is-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  return () => { stopPair(); stepObs.disconnect(); revealObs?.disconnect(); removeEventListener("scroll", onScroll); };
}

export default {
  async render(root, { onLoggedIn }) {
    document.body.classList.add("is-login");
    const done = () => { document.body.classList.remove("is-login"); onLoggedIn(); };
    if (inApp()) { renderApp(root, done); return () => document.body.classList.remove("is-login"); }
    const cleanup = renderWeb(root, done);
    return () => { cleanup(); document.body.classList.remove("is-login"); };
  },
};
