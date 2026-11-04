// Notifiche: novità dal registro raggruppate per giorno, preferenze per tipo e notifiche di sistema.
import { get, put } from "aulera/api";
import { on, store } from "aulera/state";
import { html, icon, setHTML, $, $$, toast, fmtDate, fmtDayName, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";
import { markRead, syncNow, systemPermission, systemEnabled, setSystemEnabled, requestSystemNotifications, isNativeApp } from "aulera/notify";

const KINDS = {
  voti: { label: "Voti", desc: "Nuovi voti e valutazioni", icon: "grades", tone: "blue" },
  bacheca: { label: "Bacheca", desc: "Circolari e comunicazioni", icon: "megaphone", tone: "accent" },
  note: { label: "Note", desc: "Annotazioni e note disciplinari", icon: "note", tone: "ok" },
  agenda: { label: "Agenda", desc: "Compiti e verifiche in arrivo", icon: "calendar", tone: "violet" },
  assenze: { label: "Assenze", desc: "Assenze, ritardi e uscite", icon: "absences", tone: "bad" },
  didattica: { label: "Didattica", desc: "Materiale dei docenti", icon: "folder", tone: "good" },
};
const kindOf = (k) => KINDS[k] || { label: "Avviso", icon: "bell", tone: "accent" };

const pad = (n) => String(n).padStart(2, "0");
const toDate = (sec) => new Date((sec || 0) * 1000);
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayTitle(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  if (diff === 0) return "Oggi";
  if (diff === -1) return "Ieri";
  if (diff > -7) return `${fmtDayName(d)} ${fmtDate(d)}`;
  return fmtDate(d, { year: d.getFullYear() !== today.getFullYear() });
}

let memo = null; // ultimo elenco: riaprendo la vista si vede subito

export default {
  async render(root, ctx) {
    let items = memo?.items || [];
    let unread = memo?.unread || 0;
    let hasMore = memo?.has_more || false;
    let lastSync = memo?.last_sync || null;
    let prefs = store.get("notif:prefs", null);
    let shownLatest = items[0]?.id || 0;
    let syncing = false;

    setHTML(root, html`
      ${pageHeader({
        eyebrow: "Account",
        title: "Notifiche",
        subtitle: "Le novità del registro, appena arrivano.",
        actions: html`<button type="button" class="btn" data-sync>${icon("refresh")}<span>Aggiorna ora</span></button>`,
      })}
      <div class="notifiche-layout">
        <div class="notifiche-main" data-list>${memo ? "" : skeletonList(5)}</div>
        <aside class="notifiche-side" data-prefs></aside>
      </div>`);
    const listBox = $("[data-list]", root);
    const prefsBox = $("[data-prefs]", root);
    const subtitle = $(".page-header .subtitle", root);
    const syncBtn = $("[data-sync]", root);

    /* ---------------- elenco ---------------- */
    const updateSubtitle = () => {
      if (!subtitle) return;
      subtitle.textContent = unread ? `${unread} da leggere.` : items.length ? "Sei in pari: tutto letto." : "Le novità del registro, appena arrivano.";
    };

    const row = (n) => {
      const k = kindOf(n.kind);
      const d = toDate(n.created_at);
      return html`<button type="button" class="row notifiche-row${n.read ? "" : " is-unread"}" data-id="${n.id}">
        <span class="notifiche-ic t-${k.tone}">${icon(k.icon)}</span>
        <span class="row-main">
          <span class="notifiche-row-head"><span class="row-title">${n.title}</span><time class="notifiche-time tnum" datetime="${d.toISOString()}">${hhmm(d)}</time></span>
          ${n.body ? html`<span class="row-sub clamp-2">${n.body}</span>` : ""}
        </span>
        ${n.read ? "" : html`<span class="dot" aria-label="Da leggere"></span>`}
      </button>`;
    };

    const drawList = () => {
      updateSubtitle();
      if (!items.length) {
        setHTML(listBox, html`<div class="card notifiche-empty">
          <span class="notifiche-empty-art" aria-hidden="true">${icon("bell")}</span>
          <p class="title-3">Nessuna notifica</p>
          <p class="body-2">Nuovi voti, circolari, note e compiti compariranno qui. Controlliamo il registro ogni 10 minuti mentre la sessione è attiva.</p>
          <button type="button" class="btn btn-primary" data-sync-empty>${icon("refresh")}Controlla ora</button>
        </div>`);
        return;
      }
      const groups = [];
      for (const n of items) {
        const d = toDate(n.created_at);
        const key = dayKey(d);
        let g = groups.at(-1);
        if (!g || g.key !== key) groups.push((g = { key, title: dayTitle(d), items: [] }));
        g.items.push(n);
      }
      setHTML(listBox, html`
        <div class="notifiche-toolbar">
          <p class="caption muted" data-last-sync>${lastSync ? `Controllato alle ${hhmm(toDate(lastSync))}` : ""}</p>
          ${unread ? html`<button type="button" class="btn btn-ghost notifiche-readall" data-read-all>${icon("check")}Segna tutte come lette</button>` : ""}
        </div>
        ${groups.map((g) => html`<section class="notifiche-day">
          <h2 class="overline notifiche-day-title">${g.title}</h2>
          <div class="card list">${g.items.map(row)}</div>
        </section>`)}
        ${hasMore ? html`<button type="button" class="btn btn-block notifiche-more" data-more>Mostra notifiche precedenti</button>` : ""}`);
    };

    const load = async ({ append = false } = {}) => {
      const before = append && items.length ? `&before_id=${items.at(-1).id}` : "";
      const data = await get(`/notifiche?limit=50${before}`);
      items = append ? items.concat(data.items || []) : data.items || [];
      unread = data.unread || 0;
      hasMore = !!data.has_more;
      lastSync = data.last_sync || lastSync;
      shownLatest = Math.max(shownLatest, data.latest_id || 0);
      if (!append) memo = { items, unread, has_more: hasMore, last_sync: lastSync };
      drawList();
    };

    const doSync = async (btn) => {
      if (syncing) return;
      syncing = true;
      const buttons = [syncBtn, btn].filter(Boolean);
      buttons.forEach((b) => { b.disabled = true; b.classList.add("is-busy"); });
      const label = $("span", syncBtn);
      if (label) label.textContent = "Controllo…";
      try {
        const res = await syncNow();
        lastSync = res.last_sync || Date.now() / 1000;
        await load();
        toast(res.new ? (res.new === 1 ? "1 novità dal registro" : `${res.new} novità dal registro`) : "Nessuna novità: sei aggiornato");
      } catch (err) {
        if (err.status !== 401) toast(err.message, { error: err.status !== 429 });
      } finally {
        syncing = false;
        buttons.forEach((b) => { b.disabled = false; b.classList.remove("is-busy"); });
        if (label) label.textContent = "Aggiorna ora";
      }
    };

    syncBtn.addEventListener("click", () => doSync());
    listBox.addEventListener("click", async (e) => {
      if (e.target.closest("[data-sync-empty]")) return doSync(e.target.closest("[data-sync-empty]"));
      if (e.target.closest("[data-read-all]")) {
        const prev = items.map((n) => n.read);
        items.forEach((n) => { n.read = true; });
        unread = 0;
        drawList();
        try { await markRead("all"); } catch (err) {
          items.forEach((n, i) => { n.read = prev[i]; });
          unread = items.filter((n) => !n.read).length;
          drawList();
          toast(err.message, { error: true });
        }
        return;
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        more.disabled = true;
        try { await load({ append: true }); } catch (err) { more.disabled = false; toast(err.message, { error: true }); }
        return;
      }
      const btn = e.target.closest(".notifiche-row");
      if (!btn) return;
      const n = items.find((x) => String(x.id) === btn.dataset.id);
      if (!n) return;
      if (!n.read) {
        n.read = true;
        unread = Math.max(0, unread - 1);
        markRead([n.id]).catch(() => {});
      }
      if (n.url) ctx.navigate(n.url);
      else drawList();
    });

    /* ---------------- preferenze ---------------- */
    const drawPrefs = () => {
      const perm = systemPermission();
      const sys = (() => {
        if (perm === "native") return html`<div class="row notifiche-sys"><span class="notifiche-ic t-accent">${icon("phone")}</span>
          <span class="row-main"><span class="row-title">Notifiche sul telefono</span><span class="row-sub">Nell'app arrivano anche ad app chiusa. Puoi gestirle dalle impostazioni di Android.</span></span></div>`;
        if (perm === "unsupported") return html`<div class="row notifiche-sys"><span class="notifiche-ic t-accent">${icon("bell")}</span>
          <span class="row-main"><span class="row-title">Notifiche del browser</span><span class="row-sub">Questo browser non le supporta: le novità restano qui e nel badge.</span></span></div>`;
        if (perm === "denied") return html`<div class="row notifiche-sys"><span class="notifiche-ic t-accent">${icon("bell")}</span>
          <span class="row-main"><span class="row-title">Notifiche del browser bloccate</span><span class="row-sub">Riattivale dalle impostazioni del sito (icona accanto all'indirizzo).</span></span></div>`;
        if (perm === "granted") return html`<div class="row notifiche-sys"><span class="notifiche-ic t-accent">${icon("bell")}</span>
          <span class="row-main"><span class="row-title">Notifiche del browser</span><span class="row-sub">Quando Skoolio è aperta in un'altra scheda.</span></span>
          <button type="button" class="switch" role="switch" aria-checked="${String(systemEnabled())}" aria-label="Notifiche del browser" data-system></button></div>`;
        return html`<div class="row notifiche-sys"><span class="notifiche-ic t-accent">${icon("bell")}</span>
          <span class="row-main"><span class="row-title">Notifiche del browser</span><span class="row-sub">Ricevi un avviso anche quando Skoolio è in un'altra scheda.</span></span>
          <button type="button" class="btn btn-primary notifiche-enable" data-enable>Attiva</button></div>`;
      })();
      setHTML(prefsBox, html`
        <section class="notifiche-prefs">
          <h2 class="overline notifiche-day-title">Avvisami per</h2>
          <div class="card list">
            ${Object.entries(KINDS).map(([k, m]) => html`<div class="row notifiche-pref">
              <span class="notifiche-ic t-${m.tone}">${icon(m.icon)}</span>
              <span class="row-main"><span class="row-title">${m.label}</span><span class="row-sub">${m.desc}</span></span>
              <button type="button" class="switch" role="switch" aria-checked="${String(prefs ? prefs[k] !== false : true)}" aria-label="${m.label}" data-pref="${k}" ${prefs ? "" : "disabled"}></button>
            </div>`)}
          </div>
          <div class="card list notifiche-sys-card">${sys}</div>
          <p class="caption muted notifiche-foot">Controlliamo ClasseViva ogni 10 minuti finché resti collegato. Per i tipi spenti non ricevi avvisi, e riaccendendoli non arrivano quelli persi nel frattempo.</p>
        </section>`);
    };

    prefsBox.addEventListener("click", async (e) => {
      const sw = e.target.closest("[data-pref]");
      if (sw) {
        const k = sw.dataset.pref;
        const next = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", String(next));
        try {
          const res = await put("/notifiche/preferenze", { [k]: next });
          prefs = res.prefs;
          store.set("notif:prefs", prefs);
        } catch (err) {
          sw.setAttribute("aria-checked", String(!next));
          toast(err.message, { error: true });
        }
        return;
      }
      if (e.target.closest("[data-enable]")) {
        const result = await requestSystemNotifications();
        if (result === "granted") toast("Notifiche del browser attive");
        else if (result === "denied") toast("Permesso negato dal browser", { error: true });
        drawPrefs();
        return;
      }
      const sys = e.target.closest("[data-system]");
      if (sys) {
        const next = sys.getAttribute("aria-checked") !== "true";
        setSystemEnabled(next);
        sys.setAttribute("aria-checked", String(next));
      }
    });

    drawPrefs();
    if (memo) drawList();

    try {
      await load();
    } catch (err) {
      if (!memo) {
        setHTML(listBox, errorState(err));
        $("[data-retry]", listBox)?.addEventListener("click", () => ctx.refresh());
      }
    }
    get("/notifiche/preferenze").then((res) => {
      prefs = res.prefs;
      store.set("notif:prefs", prefs);
      drawPrefs();
    }).catch(() => {
      if (!prefs) $$("[data-pref]", prefsBox).forEach((s) => { s.disabled = false; });
    });

    // Novità arrivate mentre la vista è aperta (polling di notify.js).
    const off = on("notifiche", (c) => {
      if (!c) return;
      if (c.latest_id > shownLatest) load().catch(() => {});
      else if (!c.local && c.unread !== unread) load().catch(() => {});
    });
    return () => off();
  },
};
