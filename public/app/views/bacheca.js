// Bacheca: circolari e comunicazioni della scuola, con filtri, ricerca, categorie e lettura nel pannello.
// Aprire una comunicazione la segna come letta anche su ClasseViva (è il comportamento atteso).
import { get, post, load, invalidate, openFile } from "aulera/api";
import { emit } from "aulera/state";
import { html, raw, icon, setHTML, $, $$, esc, openSheet, toast, segmented, bindSegmented, fmtDate, fmtTime, relativeDay, parseDate, startOfWeek, addDays, emptyState, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

const CLASSEVIVA_URL = "https://web.spaggiari.eu/";

/* ---------------- testo ---------------- */
const ACRONYMS = new Set(["PCTO", "INVALSI", "ATA", "RSU", "DSA", "BES", "PEI", "PDP", "UE", "ITS", "IFTS", "ICDL", "ECDL", "CLIL", "GLO", "GLI", "SPID", "CIE", "PON", "PNRR", "FSE", "MIM", "MIUR", "USR", "UST", "PTOF", "RAV", "CTS", "IRC", "ASL", "TPSIT", "COVID", "CV", "DS", "DSGA", "AS", "A.S.", "IIS", "ITIS"]);
/** Titoli tutti in maiuscolo → sentence case leggibile, tenendo le sigle. */
function tidy(s) {
  const str = String(s || "").trim().replace(/\s+/g, " ");
  const letters = str.replace(/[^\p{L}]/gu, "");
  if (letters.length < 6 || letters !== letters.toUpperCase()) return str;
  let first = true;
  return str.split(" ").map((w) => {
    const bare = w.replace(/[^\p{L}.]/gu, "");
    let out;
    if (ACRONYMS.has(bare) || /^[IVXLC]+$/.test(bare) && bare.length > 1) out = w;
    else out = w.toLowerCase();
    if (first && /\p{L}/u.test(out)) { out = out.replace(/\p{L}/u, (c) => c.toUpperCase()); first = false; }
    return out;
  }).join(" ");
}
const catOf = (n) => tidy(n.cntCategory || "") || "Comunicazione";

/** Testo della comunicazione: accetta testo semplice o HTML, restituisce paragrafi sicuri con link. */
function richText(text) {
  let s = String(text || "");
  if (/<\/?(p|br|div|span|b|strong|i|em|ul|li|a|font)\b/i.test(s)) {
    s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
    s = new DOMParser().parseFromString(s, "text/html").body.textContent || "";
  }
  s = s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!s) return "";
  const linkify = (t) => esc(t).replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a class="link" href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return raw(s.split(/\n{2,}/).map((p) => `<p>${linkify(p).replace(/\n/g, "<br>")}</p>`).join(""));
}

/* ---------------- metadati ---------------- */
const CAT_TONES = { circolare: "blue", circolari: "blue", comunicazione: "accent", comunicazioni: "accent", avviso: "ok", avvisi: "ok", evento: "violet", eventi: "violet" };
const TONES = ["accent", "blue", "violet", "ok"];
function toneOf(cat) {
  const k = cat.toLowerCase();
  if (CAT_TONES[k]) return CAT_TONES[k];
  let h = 0;
  for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}
function actionsOf(n) {
  return [
    n.needSign && { key: "sign", label: "firma", chip: "Da firmare" },
    n.needJoin && { key: "join", label: "adesione", chip: "Richiede adesione" },
    n.needReply && { key: "reply", label: "risposta", chip: "Richiede risposta" },
    n.needFile && { key: "file", label: "invio di un file", chip: "Richiede un file" },
  ].filter(Boolean);
}
const listText = (parts) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function periodOf(date, now) {
  if (!date) return { key: "zz", label: "Senza data" };
  const sow = startOfWeek(now);
  if (date >= sow) return { key: "0", label: "Questa settimana" };
  if (date >= addDays(sow, -7)) return { key: "1", label: "Settimana scorsa" };
  const label = date.toLocaleDateString("it-IT", { month: "long", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return { key: `m${date.getFullYear()}${String(date.getMonth()).padStart(2, "0")}`, label: capitalize(label) };
}

/* ---------------- vista ---------------- */
export default {
  async render(root, ctx) {
    let items = [];
    let filter = "all";
    let query = "";
    let cat = "";
    let sheet = null;
    let deepLink = ctx.params.get("id");
    const justRead = new Set(); // lette ora: restano visibili in "Da leggere" finché non cambi filtro

    setHTML(root, html`${pageHeader({ eyebrow: "Comunicazioni", title: "Bacheca", subtitle: "Circolari e comunicazioni della scuola." })}
      <div data-body>
        <div class="com-toolbar"><div class="skeleton" style="height:40px;border-radius:999px;max-width:260px"></div><div class="skeleton" style="height:44px;border-radius:999px"></div></div>
        ${skeletonList(6)}
      </div>`);
    const body = $("[data-body]", root);
    const subtitle = $(".page-header .subtitle", root);

    const unreadCount = () => items.filter((n) => !n.readStatus).length;

    const updateCounts = () => {
      const u = unreadCount();
      if (subtitle) subtitle.textContent = items.length ? (u ? `${u} da leggere su ${items.length} comunicazioni.` : `Sei in pari: ${items.length} comunicazioni, tutte lette.`) : "Circolari e comunicazioni della scuola.";
      const label = $('[data-seg="filter"] button[data-value="unread"]', body);
      if (label) label.textContent = u ? `Da leggere · ${u}` : "Da leggere";
    };

    const drawCats = () => {
      const box = $("[data-cats]", body);
      if (!box) return;
      const counts = new Map();
      items.forEach((n) => { const c = catOf(n); counts.set(c, (counts.get(c) || 0) + 1); });
      const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (cat && !counts.has(cat)) cat = "";
      box.hidden = cats.length < 2;
      setHTML(box, html`<button type="button" class="com-chip" data-cat="" aria-pressed="${String(!cat)}">Tutte le categorie</button>
        ${cats.map(([c, n]) => html`<button type="button" class="com-chip" data-cat="${c}" aria-pressed="${String(cat === c)}"><span class="com-chip-dot c-${toneOf(c)}"></span>${c}<span class="com-chip-count tnum">${n}</span></button>`)}`);
    };

    const row = (n) => {
      const c = catOf(n);
      const acts = actionsOf(n);
      const d = parseDate(n.pubDT);
      const attach = (n.attachments || []).length || n.cntHasAttach;
      return html`<button type="button" class="row bacheca-row${n.readStatus ? "" : " is-unread"}" data-pub="${n.pubId}">
        <span class="com-ic c-${toneOf(c)}">${icon("megaphone")}</span>
        <span class="row-main">
          <span class="row-title clamp-2">${tidy(n.cntTitle) || "Comunicazione senza titolo"}</span>
          <span class="row-sub">${c}${d ? html` · ${relativeDay(d)}` : ""}</span>
          ${acts.length ? html`<span class="chip chip-ok bacheca-need">${icon("info")}${acts[0].chip}${acts.length > 1 ? ` +${acts.length - 1}` : ""}</span>` : ""}
        </span>
        <span class="row-trail">${attach ? html`<span class="bacheca-clip" title="Con allegati">${icon("paperclip")}</span>` : ""}
          ${n.readStatus ? "" : html`<span class="dot" aria-label="Da leggere"></span>`}${icon("chevronRight", "chev")}</span>
      </button>`;
    };

    const drawList = () => {
      const list = $("[data-list]", body);
      if (!list) return;
      updateCounts();
      const q = query.trim().toLowerCase();
      const shown = items.filter((n) => (filter === "all" || !n.readStatus || justRead.has(n.pubId))
        && (!cat || catOf(n) === cat)
        && (!q || `${n.cntTitle} ${n.cntCategory} ${(n.attachments || []).map((a) => a.fileName).join(" ")}`.toLowerCase().includes(q)));
      if (!shown.length) {
        const clean = !q && !cat;
        if (filter === "unread" && clean) {
          setHTML(list, html`<div class="card">${emptyState({ iconName: "check", title: "Sei in pari", text: "Hai letto tutte le comunicazioni. Quelle nuove compariranno qui." })}</div>`);
        } else {
          setHTML(list, html`<div class="card"><div class="empty">${icon("search")}<p class="title-3">Nessun risultato</p>
            <p class="body-2">Prova con altre parole${cat ? " o un'altra categoria" : ""}.</p>
            <button type="button" class="btn" data-reset>Azzera filtri</button></div></div>`);
        }
        return;
      }
      const now = new Date();
      const groups = [];
      shown.forEach((n) => {
        const p = periodOf(parseDate(n.pubDT), now);
        let g = groups[groups.length - 1];
        if (!g || g.key !== p.key) groups.push((g = { ...p, items: [] }));
        g.items.push(n);
      });
      setHTML(list, html`${groups.map((g) => html`<section class="com-group">
        <h2 class="overline com-group-label">${g.label}<span class="faint tnum"> · ${g.items.length}</span></h2>
        <div class="card list">${g.items.map(row)}</div></section>`)}`);
    };

    const drawAll = () => {
      if (!items.length) {
        setHTML(body, html`<div class="card">${emptyState({ iconName: "megaphone", title: "Bacheca vuota", text: "Le circolari e le comunicazioni della scuola compariranno qui." })}</div>`);
        updateCounts();
        return;
      }
      if (!$("[data-list]", body)) {
        setHTML(body, html`<div class="com-toolbar">
            ${segmented("filter", [{ value: "all", label: "Tutte" }, { value: "unread", label: "Da leggere" }], filter)}
            <label class="search com-search">${icon("search")}<input class="field" type="search" placeholder="Cerca nelle comunicazioni" aria-label="Cerca nelle comunicazioni" value="${query}" enterkeyhint="search" autocomplete="off" /></label>
          </div>
          <div class="com-chips" data-cats role="group" aria-label="Categorie"></div>
          <div data-list></div>`);
        bindSegmented(body, "filter", (v) => { filter = v; justRead.clear(); drawList(); });
        $(".com-search input", body).addEventListener("input", (e) => { query = e.target.value; drawList(); });
      }
      drawCats();
      drawList();
    };

    body.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-cat]");
      if (chip) {
        cat = chip.dataset.cat;
        $$("[data-cat]", body).forEach((b) => b.setAttribute("aria-pressed", String(b === chip)));
        drawList();
        return;
      }
      if (e.target.closest("[data-reset]")) {
        query = ""; cat = "";
        const input = $(".com-search input", body);
        if (input) input.value = "";
        drawCats();
        drawList();
        return;
      }
      const r = e.target.closest("[data-pub]");
      if (r) {
        const n = items.find((x) => String(x.pubId) === r.dataset.pub);
        if (n) openItem(n);
      }
    });

    /* ---------- pannello di lettura ---------- */
    const openItem = (n) => {
      sheet?.close();
      const c = catOf(n);
      const d = parseDate(n.pubDT);
      const acts = actionsOf(n);
      const attachments = n.attachments || [];
      const validTo = parseDate(n.cntValidTo);
      const wasUnread = !n.readStatus;
      const content = document.createElement("div");
      content.className = "bacheca-sheet";
      setHTML(content, html`
        <div class="bacheca-meta">
          <span class="chip bacheca-cat c-${toneOf(c)}">${c}</span>
          ${d ? html`<span class="caption">${fmtDate(d, { weekday: true, year: d.getFullYear() !== new Date().getFullYear() })}${fmtTime(n.pubDT) ? ` alle ${fmtTime(n.pubDT)}` : ""}</span>` : ""}
        </div>
        ${acts.length ? html`<div class="com-callout" data-callout>
          <span class="com-ic c-ok">${icon("info")}</span>
          <div class="stack-sm">
            <p class="title-3">Richiede ${listText(acts.map((a) => a.label))}</p>
            <p class="body-2" data-callout-text>Aulera non può ancora farlo al posto tuo: completa dal sito ufficiale ClasseViva, nella sezione Bacheca.</p>
            <a class="btn bacheca-cv-btn" href="${CLASSEVIVA_URL}" target="_blank" rel="noopener">${icon("link")}Apri ClasseViva</a>
          </div>
        </div>` : ""}
        <article class="bacheca-text" data-text aria-busy="true">
          <div class="skeleton-line" style="width:92%"></div><div class="skeleton-line" style="width:84%"></div><div class="skeleton-line" style="width:60%"></div>
        </article>
        ${attachments.length ? html`<section class="bacheca-attach">
          <h3 class="overline com-group-label">${attachments.length === 1 ? "Allegato" : `${attachments.length} allegati`}</h3>
          <div class="card list">${attachments.map((a, i) => html`<button type="button" class="row" data-attach="${a.attachNum ?? i + 1}">
            <span class="com-ic c-blue">${icon("doc")}</span>
            <span class="row-main"><span class="row-title clamp-2">${a.fileName || `Allegato ${i + 1}`}</span><span class="row-sub" data-attach-sub>Tocca per aprire</span></span>
            <span class="row-trail">${icon("download")}</span></button>`)}</div>
        </section>` : ""}
        <p class="caption faint bacheca-foot" data-foot>${validTo ? `Valida fino al ${fmtDate(validTo, { year: true })}.` : ""}</p>`);

      sheet = openSheet({
        title: tidy(n.cntTitle) || "Comunicazione",
        content,
        wide: true,
        onClose: () => {
          sheet = null;
          if (new URLSearchParams(location.search).has("id")) history.replaceState(history.state, "", location.pathname);
        },
      });

      content.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-attach]");
        if (!b || b.dataset.busy) return;
        b.dataset.busy = "1";
        b.classList.add("is-busy");
        const sub = $("[data-attach-sub]", b);
        if (sub) sub.textContent = "Apertura…";
        try {
          await openFile({ kind: "bacheca", evt_code: n.evtCode || "CF", pub_id: String(n.pubId), attach_num: String(b.dataset.attach) });
          if (sub) sub.textContent = "Tocca per aprire";
        } catch (err) {
          if (sub) sub.textContent = "Non disponibile, riprova";
          toast(err.message || "Impossibile aprire l'allegato.", { error: true });
        } finally {
          delete b.dataset.busy;
          b.classList.remove("is-busy");
        }
      });

      const fetchText = async () => {
        const slot = $("[data-text]", content);
        try {
          const res = await post(`/bacheca/${encodeURIComponent(n.evtCode || "CF")}/${encodeURIComponent(n.pubId)}/leggi`);
          const inner = res?.item?.item || {};
          const reply = res?.item?.reply || {};
          const text = richText(inner.text);
          slot.removeAttribute("aria-busy");
          setHTML(slot, text || html`<p class="muted">${attachments.length ? "Il contenuto è nell'allegato qui sotto." : "Questa comunicazione non ha testo."}</p>`);
          const done = acts.length && acts.every((a) => ({ sign: reply.replSign, join: reply.replJoin, reply: reply.replText, file: reply.replFile })[a.key]);
          if (done) {
            const t = $("[data-callout-text]", content);
            if (t) t.textContent = "Su ClasseViva risulta già completata. Per modificarla usa il sito ufficiale.";
            $("[data-callout]", content)?.classList.add("is-done");
          }
          if (wasUnread) {
            n.readStatus = true;
            justRead.add(n.pubId);
            invalidate("bacheca");
            emit("unread");
            drawList();
            const foot = $("[data-foot]", content);
            if (foot) foot.textContent = `${foot.textContent ? `${foot.textContent} ` : ""}Segnata come letta anche su ClasseViva.`;
          }
        } catch (err) {
          slot.removeAttribute("aria-busy");
          setHTML(slot, html`<div class="com-inline-error"><p class="body-2">${err.message || "Impossibile caricare il testo."}</p>
            <button type="button" class="btn" data-retry-text>${icon("refresh")}Riprova</button></div>`);
          $("[data-retry-text]", slot)?.addEventListener("click", () => {
            setHTML(slot, html`<div class="skeleton-line" style="width:92%"></div><div class="skeleton-line" style="width:70%"></div>`);
            fetchText();
          });
        }
      };
      fetchText();
    };

    /* ---------- dati ---------- */
    const fetchData = async () => {
      try {
        await load("bacheca", () => get("/bacheca"), (data) => {
          items = (data?.items || []).filter(Boolean);
          drawAll();
          if (deepLink) {
            const n = items.find((x) => String(x.pubId) === deepLink);
            deepLink = null;
            if (n) openItem(n);
            else toast("Questa comunicazione non è più in bacheca.", { error: true });
          }
        }, { maxAge: 60_000 });
      } catch (err) {
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => {
          setHTML(body, skeletonList(6));
          fetchData();
        });
      }
    };
    await fetchData();
    return () => sheet?.close();
  },
};
