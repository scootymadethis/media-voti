// Classifica: media generale e ore di assenza, di classe o globale, con podio, la tua
// posizione sempre a portata e aggiornamenti in tempo reale (FLIP sui cambi di posizione).
import { get, post, load, invalidate } from "aulera/api";
import { state, isCurrentYear, yearLabel, store } from "aulera/state";
import { html, icon, setHTML, $, $$, segmented, bindSegmented, emptyState, errorState, initials, titleCase, gradeClass, fmtNum, toast } from "aulera/ui";
import { pageHeader, yearButton, bindYearPicker } from "aulera/main";

const PAGE = 25;
const AVG = { subject_name: "Media generale", period_key: "generale" };
const AVG_Q = new URLSearchParams(AVG).toString();
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- helper condivisi con le altre viste account ---------------- */
// Colori dei badge decisi dall'admin: accettati solo #hex, rgb() e rgba().
const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*[, ]\s*\d{1,3}%?\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\))$/i;
export const safeColor = (v) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : null);
export function badgeChip(b) {
  const style = [["color", safeColor(b?.text_color)], ["background", safeColor(b?.background_color)], ["border-color", safeColor(b?.border_color)]]
    .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(";");
  return html`<span class="account-badge" style="${style}">${b?.label || ""}</span>`;
}
export const badgeChips = (list) => (list?.length ? html`<span class="account-badges">${list.map(badgeChip)}</span>` : "");

const displayName = (it) => {
  let n = String(it?.full_name || "").trim();
  // La propria voce può non avere ancora il nome (solo username): usa quello della sessione.
  if ((it?.is_me || it?.__me) && (!n || n === it?.username) && state.session?.full_name) n = state.session.full_name;
  return n && n !== it?.username ? titleCase(n) : n || it?.username || "Studente";
};
const fmtAvg = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtHours = (v) => `${fmtNum(Number(v) || 0, 1)} h`;
const ordinal = (n) => `${n}°`;

async function loadVisibility() {
  const pick = (r) => (r?.item ? r.item.visible_in_leaderboard !== false : r?.default_visible_in_leaderboard !== false);
  const [abs, avg] = await Promise.all([get("/leaderboard/me"), get(`/average-leaderboard/me?${AVG_Q}`)]);
  return { assenze: pick(abs), media: pick(avg) };
}
function saveVisibility(kind, visible) {
  invalidate("lb:");
  if (kind === "assenze") return post("/leaderboard/update", { hours: 0, visible_in_leaderboard: visible });
  return post("/average-leaderboard/update", { ...AVG, period_label: "Media generale", average: 0, visible_in_leaderboard: visible });
}

/** WebSocket con riconnessione (backoff), si ferma su rifiuto esplicito. */
function realtime(path, onMessage) {
  let ws = null, tries = 0, timer = null, closed = false;
  const open = () => {
    if (closed || !window.APP_CONFIG?.wsUrl) return;
    try { ws = new WebSocket(window.APP_CONFIG.wsUrl(path)); } catch { return; }
    ws.onopen = () => { tries = 0; };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* messaggio non JSON */ } };
    ws.onclose = (e) => {
      ws = null;
      if (closed || e.code === 4401 || e.code === 4403 || ++tries > 5) return;
      timer = setTimeout(open, Math.min(30_000, 1500 * 2 ** tries));
    };
  };
  const onVisible = () => { if (document.visibilityState === "visible" && !ws && !closed) { tries = 0; clearTimeout(timer); open(); } };
  document.addEventListener("visibilitychange", onVisible);
  open();
  return () => { closed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); try { ws?.close(); } catch { /* già chiuso */ } };
}

/* ---------------- FLIP ---------------- */
function measure(container) {
  const map = new Map();
  $$("[data-flip]", container).forEach((el) => map.set(el.dataset.flip, el.getBoundingClientRect()));
  return map;
}
function playFlip(container, before) {
  if (!before || reducedMotion()) return;
  $$("[data-flip]", container).forEach((el) => {
    const old = before.get(el.dataset.flip);
    if (!old) {
      el.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      return;
    }
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left, dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
  });
}

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    const cls = state.session?.class_code || "";
    const school = state.session?.school_code || "";
    let board = ["media", "assenze"].includes(ctx.params.get("board")) ? ctx.params.get("board") : store.get("lbBoard", "media");
    let scope = cls ? store.get("lbScope", "class") : "global";
    let query = "";
    let items = [], total = 0, totalPages = 1, page = 0, me = null, classAvailable = true;
    let deltas = new Map();
    let vis = null; // { media, assenze }
    let reqId = 0;
    let dirty = false, refreshTimer = null, searchTimer = null;
    let rowObserver = null;
    let loaded = false;
    const cleanups = [];

    setHTML(root, html`
      ${pageHeader({ eyebrow: "Community", title: "Classifica", subtitle: "Confrontati con la tua classe o con tutti gli studenti di Skoolio.", actions: yearButton() })}
      <div class="classifica-toolbar">
        ${segmented("lb-board", [{ value: "media", label: "Media" }, { value: "assenze", label: "Assenze" }], board)}
        ${cls ? segmented("lb-scope", [{ value: "class", label: `Classe ${cls}` }, { value: "global", label: "Globale" }], scope) : ""}
      </div>
      <div class="classifica-layout">
        <div class="classifica-main">
          <div class="classifica-podium-slot" data-podium></div>
          <div class="classifica-list-head" data-list-head hidden>
            <label class="search classifica-search">${icon("search")}<input class="field" type="search" data-search placeholder="Cerca per nome o classe" autocomplete="off" enterkeyhint="search" aria-label="Cerca nella classifica" /></label>
          </div>
          <div class="classifica-list-slot" data-list></div>
          <button type="button" class="classifica-sticky" data-sticky hidden aria-label="Vai alla tua posizione"></button>
        </div>
        <aside class="classifica-aside">
          <div class="classifica-me" data-me></div>
          <div class="classifica-privacy" data-privacy></div>
        </aside>
      </div>`);

    const meBox = $("[data-me]", root), podiumBox = $("[data-podium]", root), listBox = $("[data-list]", root);
    const listHead = $("[data-list-head]", root), sticky = $("[data-sticky]", root), privacyBox = $("[data-privacy]", root);
    const main = $(".classifica-layout", root);

    const value = (it) => (board === "media" ? it?.average : it?.hours);
    const valueText = (it) => (board === "media" ? fmtAvg(it?.average) : fmtHours(it?.hours));
    const valuePill = (it) => board === "media"
      ? html`<span class="grade grade-sm grade-avg ${gradeClass(Number(it?.average))} classifica-value">${fmtAvg(it?.average)}</span>`
      : html`<span class="classifica-hours tnum">${fmtHours(it?.hours)}</span>`;
    const scopeLabel = () => (scope === "class" ? `Classe ${cls}` : "Globale");

    const buildUrl = (p, size = PAGE) => {
      const params = new URLSearchParams({ type: scope, page: String(p), page_size: String(size) });
      if (scope === "class") { if (cls) params.set("class_code", cls); if (school) params.set("school_code", school); }
      if (state.year) params.set("school_year", state.year);
      if (query) params.set("q", query);
      return board === "media" ? `/average-leaderboard?${AVG_Q}&${params}` : `/leaderboard?${params}`;
    };
    const cacheKey = () => `lb:${board}:${scope}:${state.year}`;

    /* ---------- skeleton ---------- */
    const skeleton = () => {
      setHTML(meBox, html`<div class="card card-pad"><div class="skeleton-line" style="width:40%"></div><div class="skeleton" style="height:44px;margin-top:14px;width:60%"></div></div>`);
      setHTML(podiumBox, html`<div class="card classifica-podium is-loading"><div class="classifica-podium-row">${[2, 1, 3].map((r) => html`<div class="classifica-step is-rank-${r}">
        <div class="skeleton classifica-avatar-skel"></div><div class="skeleton-line" style="width:70%;margin:10px auto 0"></div><div class="classifica-pedestal"></div></div>`)}</div></div>`);
      setHTML(listBox, html`<div class="card list">${Array.from({ length: 5 }, () => html`<div class="row"><div class="skeleton-line" style="width:22px"></div><div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>
        <div class="row-main stack-sm"><div class="skeleton-line" style="width:50%"></div><div class="skeleton-line" style="width:30%;height:11px"></div></div><div class="skeleton" style="width:52px;height:30px;border-radius:10px"></div></div>`)}</div>`);
      listHead.hidden = true;
      sticky.hidden = true;
    };

    /* ---------- la tua posizione ---------- */
    const drawMe = () => {
      if (me) {
        const above = me.rank > 1 ? items.find((it) => it.rank === me.rank - 1) : null;
        const mine = value(me.entry);
        let hint = "";
        if (me.rank === 1) hint = board === "media" ? "Sei in testa. Complimenti!" : "Sei al primo posto per ore di assenza.";
        else if (above && board === "media") {
          const gap = Math.max(0, Number(above.average) - Number(mine));
          hint = gap < 0.005 ? html`Sei a pari merito con <strong>${displayName(above)}</strong>.` : html`Ti mancano <strong class="tnum">${fmtAvg(gap)}</strong> per superare ${displayName(above)}.`;
        } else if (board === "assenze") hint = "Ore di assenza registrate nell'anno.";
        setHTML(meBox, html`<section class="card card-pad classifica-me-card">
          <p class="overline">La tua posizione · ${scopeLabel()}</p>
          <div class="classifica-me-top">
            <p class="classifica-me-rank tnum">${ordinal(me.rank)}<span> su ${me.total}</span></p>
            <div class="classifica-me-value"><span class="${board === "media" ? `grade grade-avg ${gradeClass(Number(mine))}` : "classifica-hours lg tnum"}">${valueText(me.entry)}</span>
              <span class="caption">${board === "media" ? "media generale" : "di assenza"}</span></div>
          </div>
          ${hint ? html`<p class="body-2 classifica-me-hint">${hint}</p>` : ""}
          <div class="bar classifica-me-bar" aria-hidden="true"><span style="width:${Math.max(4, Math.round(((me.total - me.rank + 1) / me.total) * 100))}%"></span></div>
        </section>`);
        return;
      }
      const current = isCurrentYear();
      const hidden = current && vis && vis[board] === false;
      const unavailable = scope === "class" && !classAvailable;
      if (unavailable) { setHTML(meBox, ""); return; } // lo spiega già lo stato vuoto dell'elenco
      setHTML(meBox, html`<section class="card card-pad classifica-me-card is-empty">
        <div class="hstack"><span class="row-icon">${icon(hidden ? "eyeOff" : "person")}</span>
          <div class="row-main"><p class="title-3">${hidden ? "Sei nascosto" : unavailable ? "Classe non disponibile" : current ? "Non sei ancora in classifica" : "Non eri in classifica"}</p>
          <p class="caption">${hidden ? "Gli altri non vedono la tua posizione. Puoi tornare visibile quando vuoi."
            : unavailable ? `Non abbiamo i dati della tua classe per l'${yearLabel()}.`
            : current ? "La tua posizione compare dopo il primo aggiornamento dei tuoi dati." : `Per l'${yearLabel()} non risulta una tua posizione.`}</p></div></div>
        ${current && !unavailable ? html`<button type="button" class="btn ${hidden ? "btn-primary" : ""} btn-block" data-join style="margin-top:14px">${icon(hidden ? "eye" : "refresh")}${hidden ? "Mostrami in classifica" : "Aggiorna la mia posizione"}</button>` : ""}
      </section>`);
      $("[data-join]", meBox)?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await saveVisibility(board, true);
          if (vis) vis[board] = true;
          drawPrivacy();
          await fetchFirst({ flip: true });
          toast(hidden ? "Ora compari in classifica" : "Posizione aggiornata");
        } catch (err) {
          btn.disabled = false;
          toast(err.message, { error: true });
        }
      });
    };

    /* ---------- podio + elenco ---------- */
    const rowHtml = (it) => {
      const d = deltas.get(it.username);
      return html`<li class="row classifica-row${it.is_me ? " is-me" : ""}" data-flip="${it.username}" data-rank="${it.rank}"${it.is_me ? html` data-me-row` : ""}>
        <span class="classifica-rank tnum">${it.rank}</span>
        <span class="account-avatar sm${it.is_me ? " is-me" : ""}" aria-hidden="true">${initials(displayName(it))}</span>
        <div class="row-main">
          <p class="row-title classifica-name">${displayName(it)}${it.is_me ? html`<span class="chip chip-accent classifica-you">Tu</span>` : ""}</p>
          ${scope === "global" || it.badges?.length ? html`<p class="row-sub classifica-sub">${scope === "global" && it.class_code ? html`<span>${it.class_code}</span>` : ""}${badgeChips(it.badges)}</p>` : ""}
        </div>
        <span class="classifica-trail">${d ? html`<span class="classifica-delta ${d > 0 ? "up" : "down"}" aria-label="${d > 0 ? `Salito di ${d}` : `Sceso di ${-d}`}">${icon(d > 0 ? "arrowUp" : "arrowDown")}${Math.abs(d)}</span>` : ""}${valuePill(it)}</span>
      </li>`;
    };

    const podiumHtml = (top) => {
      const slots = [top[1], top[0], top[2]].filter(Boolean);
      return html`<section class="card classifica-podium" aria-label="Podio">
        <div class="classifica-podium-head"><p class="overline">${board === "media" ? "Media generale" : "Ore di assenza"} · ${scopeLabel()}</p><p class="caption tnum">${total} ${total === 1 ? "studente" : "studenti"}</p></div>
        <ol class="classifica-podium-row">${slots.map((it) => html`<li class="classifica-step is-rank-${it.rank}${it.is_me ? " is-me" : ""}" data-flip="${it.username}"${it.is_me ? html` data-me-row` : ""}>
          <div class="classifica-avatar"><span>${initials(displayName(it))}</span><span class="classifica-medal tnum" aria-label="${it.rank}° posto">${it.rank}</span></div>
          <p class="classifica-step-name clamp-2">${displayName(it)}</p>
          ${it.is_me ? html`<span class="chip chip-accent classifica-you">Tu</span>` : badgeChips(it.badges?.slice(0, 1))}
          <p class="classifica-step-value tnum">${valueText(it)}</p>
          <div class="classifica-pedestal" aria-hidden="true"></div>
        </li>`)}</ol>
      </section>`;
    };

    const drawList = ({ flip = false } = {}) => {
      const before = flip ? measure(main) : null;
      rowObserver?.disconnect();
      const searching = !!query;
      listHead.hidden = !(total > 3 || searching);
      if (!items.length) {
        setHTML(podiumBox, "");
        if (searching) {
          setHTML(listBox, html`<div class="card">${emptyState({ iconName: "search", title: "Nessun risultato", text: `Nessuno corrisponde a “${query}”.` })}</div>`);
        } else if (scope === "class" && !classAvailable) {
          setHTML(listBox, html`<div class="card">${emptyState({ iconName: "history", title: "Classe non disponibile", text: `Per l'${yearLabel()} non sappiamo in che classe eri. Prova la classifica globale.` })}
            <div class="classifica-empty-cta"><button type="button" class="btn" data-go-global>${icon("trophy")}Vedi la classifica globale</button></div></div>`);
          $("[data-go-global]", listBox)?.addEventListener("click", () => switchScope("global"));
        } else {
          setHTML(listBox, html`<div class="card">${emptyState({ iconName: "trophy", title: "Classifica vuota", text: scope === "class" ? "Nessuno della tua classe è ancora in classifica. Invita i compagni a provare Skoolio." : "Nessuno studente è ancora in classifica per quest'anno." })}</div>`);
        }
        updateSticky();
        return;
      }
      const podium = !searching ? items.slice(0, 3) : [];
      const rest = !searching ? items.slice(3) : items;
      setHTML(podiumBox, podium.length ? podiumHtml(podium) : "");
      const remaining = Math.max(0, total - items.length);
      setHTML(listBox, html`${rest.length ? html`<ol class="card list classifica-list">${rest.map(rowHtml)}</ol>` : ""}
        ${page < totalPages ? html`<button type="button" class="btn btn-block classifica-more" data-more>Mostra altri ${Math.min(PAGE, remaining)}<span class="faint tnum"> · ${remaining} rimanenti</span></button>` : ""}
        ${searching ? html`<p class="caption classifica-foot">${total} ${total === 1 ? "risultato" : "risultati"} per “${query}”.</p>` : ""}`);
      $("[data-more]", listBox)?.addEventListener("click", loadMore);
      playFlip(main, before);
      observeMyRow();
    };

    /* ---------- riga "Tu" fissa ---------- */
    let myRowVisible = false, meCardPassed = false;
    // La riga fissa compare solo dopo aver superato la card "La tua posizione".
    const meCardObserver = new IntersectionObserver(([e]) => { meCardPassed = !e.isIntersecting && e.boundingClientRect.top < 0; updateSticky(); });
    meCardObserver.observe(meBox);
    cleanups.push(() => meCardObserver.disconnect());
    const observeMyRow = () => {
      const row = $("[data-me-row]", main);
      myRowVisible = false;
      if (row) {
        rowObserver = new IntersectionObserver(([e]) => { myRowVisible = e.isIntersecting; updateSticky(); }, { rootMargin: "0px 0px -90px 0px" });
        rowObserver.observe(row);
      }
      updateSticky();
    };
    const updateSticky = () => {
      const show = !!me && !!items.length && !myRowVisible && meCardPassed;
      if (me) {
        setHTML(sticky, html`<span class="classifica-rank tnum">${me.rank}</span>
          <span class="account-avatar sm is-me" aria-hidden="true">${initials(displayName(me.entry))}</span>
          <span class="row-main"><span class="row-title">Tu</span><span class="row-sub"> · ${ordinal(me.rank)} su ${me.total}</span></span>
          ${valuePill(me.entry)}`);
      }
      sticky.hidden = !me || !items.length;
      sticky.classList.toggle("is-shown", show);
      sticky.tabIndex = show ? 0 : -1;
    };
    sticky.addEventListener("click", async () => {
      if (!me) return;
      if (!$("[data-me-row]", main) && !query) {
        sticky.disabled = true;
        try {
          while (page < totalPages && !items.some((it) => it.is_me)) await loadMore(null, { quiet: true });
        } finally { sticky.disabled = false; }
      }
      $("[data-me-row]", main)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    });

    /* ---------- dati ---------- */
    const apply = (data) => {
      items = data.items || [];
      total = data.total_items ?? items.length;
      totalPages = data.total_pages || 1;
      page = Math.ceil(items.length / PAGE) || 1;
      me = data.me && data.me.rank ? { ...data.me, entry: { ...data.me.entry, __me: true } } : null;
      classAvailable = data.class_scope_available !== false;
    };

    async function fetchFirst({ flip = false, keep = false } = {}) {
      const id = ++reqId;
      const size = keep ? Math.min(100, Math.max(PAGE, Math.ceil(items.length / PAGE) * PAGE)) : PAGE;
      const prev = new Map(items.map((it) => [it.username, it.rank]));
      if (!flip) deltas = new Map();
      const handle = (data, isFlip) => {
        if (id !== reqId) return;
        apply(data);
        loaded = true;
        if (keep) {
          deltas = new Map();
          items.forEach((it) => { const old = prev.get(it.username); if (old && old !== it.rank) deltas.set(it.username, old - it.rank); });
        }
        drawMe();
        drawList({ flip: isFlip });
      };
      try {
        if (query || keep) {
          handle(await get(buildUrl(1, size)), flip);
        } else {
          let first = true;
          await load(cacheKey(), () => get(buildUrl(1)), (data) => { handle(data, flip || !first); first = false; }, { maxAge: 20_000 });
        }
      } catch (err) {
        if (id !== reqId) return;
        if (keep) return; // aggiornamento in background: resta quello che c'è
        setHTML(meBox, "");
        setHTML(podiumBox, "");
        setHTML(listBox, errorState(err));
        $("[data-retry]", listBox)?.addEventListener("click", () => { skeleton(); fetchFirst(); });
      }
    }

    async function loadMore(e, { quiet = false } = {}) {
      const btn = $("[data-more]", listBox);
      if (btn) { btn.disabled = true; btn.textContent = "Carico…"; }
      const id = reqId;
      try {
        const data = await get(buildUrl(page + 1));
        if (id !== reqId) return;
        const seen = new Set(items.map((it) => it.username));
        items = items.concat((data.items || []).filter((it) => !seen.has(it.username)));
        page += 1;
        totalPages = data.total_pages || totalPages;
        total = data.total_items ?? total;
        drawList();
      } catch (err) {
        if (!quiet) toast(err.message, { error: true });
        if (btn) { btn.disabled = false; btn.textContent = "Riprova"; }
        if (quiet) throw err;
      }
    }

    const reload = () => { deltas = new Map(); skeleton(); fetchFirst(); };
    // Cambia ambito come se l'utente toccasse il segmented (aggiorna anche l'indicatore).
    const switchScope = (v) => $(`[data-seg="lb-scope"] button[data-value="${v}"]`, root)?.click();

    bindSegmented(root, "lb-board", (v) => { board = v; store.set("lbBoard", v); drawPrivacy(); reload(); });
    bindSegmented(root, "lb-scope", (v) => { scope = v; store.set("lbScope", v); reload(); });
    const search = $("[data-search]", root);
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const next = search.value.trim();
        if (next === query) return;
        query = next;
        deltas = new Map();
        fetchFirst();
      }, 280);
    });
    bindYearPicker(root, () => {
      const label = $("[data-year-picker] span", root);
      if (label) label.textContent = yearLabel();
      drawPrivacy();
      reload();
    });

    /* ---------- privacy ---------- */
    function drawPrivacy() {
      const current = isCurrentYear();
      const row = (kind, title, sub) => html`<div class="row">
        <div class="row-main"><p class="row-title">${title}</p><p class="row-sub">${sub}</p></div>
        <button type="button" class="switch" role="switch" data-vis="${kind}" aria-label="${title}" aria-checked="${String(vis ? vis[kind] !== false : true)}" ${!current || !vis ? "disabled" : ""}></button>
      </div>`;
      setHTML(privacyBox, html`<p class="overline classifica-privacy-title">Privacy</p>
        <div class="card list classifica-privacy-card${current ? "" : " is-disabled"}">
          ${row("media", "Mostrami nella classifica Media", "Gli altri vedono nome, classe e media generale.")}
          ${row("assenze", "Mostrami nella classifica Assenze", "Gli altri vedono nome, classe e ore di assenza.")}
        </div>
        <p class="caption classifica-privacy-note">${current ? "Puoi cambiare idea in ogni momento. I tuoi voti restano sempre privati."
          : html`${icon("info")}<span>Stai guardando l'${yearLabel()}: la visibilità si sceglie solo per l'anno in corso.</span>`}</p>`);
    }
    privacyBox.addEventListener("click", async (e) => {
      const sw = e.target.closest("[data-vis]");
      if (!sw || sw.disabled || !vis) return;
      const kind = sw.dataset.vis;
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(next));
      sw.disabled = true;
      try {
        await saveVisibility(kind, next);
        vis[kind] = next;
        toast(next ? `Ora compari nella classifica ${kind === "media" ? "Media" : "Assenze"}` : `Non compari più nella classifica ${kind === "media" ? "Media" : "Assenze"}`);
        if (kind === board) fetchFirst({ flip: true, keep: true });
      } catch (err) {
        sw.setAttribute("aria-checked", String(!next));
        toast(err.message, { error: true });
      } finally {
        sw.disabled = false;
      }
    });

    /* ---------- tempo reale ---------- */
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") { dirty = true; return; }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => fetchFirst({ flip: true, keep: true }), 450);
    };
    cleanups.push(realtime("/api/ws/leaderboard", (msg) => {
      if (msg?.type === "badge" || (msg?.type === "leaderboard_changed" && msg.action === "badge") || (msg?.type === "average_leaderboard_changed" && msg.action === "badge")) return scheduleRefresh();
      if (msg?.type === "leaderboard_changed" && board === "assenze") return scheduleRefresh();
      if (msg?.type === "average_leaderboard_changed" && board === "media") return scheduleRefresh();
    }));
    const onVisible = () => { if (document.visibilityState === "visible" && dirty) { dirty = false; scheduleRefresh(); } };
    document.addEventListener("visibilitychange", onVisible);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
    cleanups.push(() => { clearTimeout(refreshTimer); clearTimeout(searchTimer); rowObserver?.disconnect(); reqId++; });

    /* ---------- avvio ---------- */
    skeleton();
    drawPrivacy();
    loadVisibility().then((v) => { vis = v; drawPrivacy(); if (loaded && !me) drawMe(); }).catch(() => { vis = null; drawPrivacy(); });
    await fetchFirst();
    return () => cleanups.forEach((fn) => { try { fn(); } catch { /* niente */ } });
  },
};

