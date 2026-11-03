// Note: annotazioni, note disciplinari, richiami e sanzioni in un'unica lista cronologica.
// Aprire una nota non letta la segna come letta anche su ClasseViva.
import { get, post, load, invalidate } from "aulera/api";
import { html, raw, icon, setHTML, $, $$, esc, openSheet, fmtDate, relativeDay, parseDate, personName, initials, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

const TYPES = {
  NTTE: { label: "Annotazione", plural: "Annotazioni", icon: "note", tone: "blue" },
  NTCL: { label: "Nota disciplinare", plural: "Disciplinari", icon: "info", tone: "bad" },
  NTWN: { label: "Richiamo", plural: "Richiami", icon: "bell", tone: "ok" },
  NTST: { label: "Sanzione", plural: "Sanzioni", icon: "absences", tone: "bad" },
};
const ORDER = ["NTTE", "NTCL", "NTWN", "NTST"];
const typeOf = (t) => TYPES[t] || { label: "Nota", plural: "Altre", icon: "note", tone: "violet" };
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plain = (t) => String(t ?? "").replace(/\r\n?/g, "\n").trim();

function ago(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return "Oggi";
  if (days === 1) return "Ieri";
  if (days < 30) return `${days} giorni fa`;
  const months = Math.round(days / 30.4);
  return months <= 1 ? "Un mese fa" : `${months} mesi fa`;
}

function paragraphs(text) {
  return raw(plain(text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join(""));
}

function flatten(notes) {
  const out = [];
  Object.entries(notes || {}).forEach(([type, list]) => {
    if (!Array.isArray(list)) return;
    list.forEach((n) => n && out.push({ ...n, type }));
  });
  return out.sort((a, b) => String(b.evtDate || "").localeCompare(String(a.evtDate || "")) || (b.evtId || 0) - (a.evtId || 0));
}

export default {
  async render(root) {
    let notes = [];
    let type = "";
    let sheet = null;

    setHTML(root, html`${pageHeader({ eyebrow: "Comunicazioni", title: "Note", subtitle: "Annotazioni, note disciplinari e richiami dal registro." })}
      <div data-body><div class="com-chips"><div class="skeleton" style="width:120px;height:40px;border-radius:999px"></div><div class="skeleton" style="width:140px;height:40px;border-radius:999px"></div></div>${skeletonList(4)}</div>`);
    const body = $("[data-body]", root);
    const subtitle = $(".page-header .subtitle", root);

    const row = (n) => {
      const t = typeOf(n.type);
      const text = plain(n.evtText);
      const d = parseDate(n.evtDate);
      const sub = [t.label, n.warningType ? capitalize(String(n.warningType).toLowerCase()) : "", personName(n.authorName), d ? relativeDay(d) : ""].filter(Boolean).join(" · ");
      return html`<button type="button" class="row note-row${n.readStatus ? "" : " is-unread"}" data-note="${n.type}:${n.evtId}">
        <span class="com-ic c-${t.tone}">${icon(t.icon)}</span>
        <span class="row-main">
          ${text ? html`<span class="row-title clamp-2">${text}</span>`
            : html`<span class="row-title note-hidden">${n.readStatus ? "Nessun testo" : "Tocca per leggere"}</span>`}
          <span class="row-sub">${sub}</span>
        </span>
        <span class="row-trail">${n.readStatus ? "" : html`<span class="dot" aria-label="Da leggere"></span>`}${icon("chevronRight", "chev")}</span>
      </button>`;
    };

    const drawList = () => {
      const list = $("[data-list]", body);
      if (!list) return;
      const unread = notes.filter((n) => !n.readStatus).length;
      if (subtitle) subtitle.textContent = `${notes.length} ${notes.length === 1 ? "nota" : "note"} sul registro${unread ? ` · ${unread} da leggere` : ""}.`;
      const shown = type ? notes.filter((n) => n.type === type) : notes;
      const groups = [];
      shown.forEach((n) => {
        const d = parseDate(n.evtDate);
        const key = d ? `${d.getFullYear()}-${d.getMonth()}` : "none";
        let g = groups[groups.length - 1];
        if (!g || g.key !== key) {
          const label = d ? capitalize(d.toLocaleDateString("it-IT", { month: "long", year: "numeric" })) : "Senza data";
          groups.push((g = { key, label, items: [] }));
        }
        g.items.push(n);
      });
      setHTML(list, html`${groups.map((g) => html`<section class="com-group">
        <h2 class="overline com-group-label">${g.label}</h2>
        <div class="card list">${g.items.map(row)}</div></section>`)}`);
    };

    const draw = () => {
      if (!notes.length) {
        if (subtitle) subtitle.textContent = "Annotazioni, note disciplinari e richiami dal registro.";
        setHTML(body, html`<div class="card note-clean">
          <span class="note-clean-ic">${icon("check")}</span>
          <p class="title-2">Nessuna nota</p>
          <p class="body-2">Sul registro non c'è nessuna annotazione, nota disciplinare o richiamo. Continua così.</p>
        </div>`);
        return;
      }
      const counts = new Map();
      notes.forEach((n) => counts.set(n.type, (counts.get(n.type) || 0) + 1));
      const types = [...ORDER.filter((t) => counts.has(t)), ...[...counts.keys()].filter((t) => !ORDER.includes(t))];
      if (type && !counts.has(type)) type = "";
      setHTML(body, html`
        ${types.length > 1 ? html`<div class="com-chips" role="group" aria-label="Tipo di nota">
          <button type="button" class="com-chip" data-type="" aria-pressed="${String(!type)}">Tutte<span class="com-chip-count tnum">${notes.length}</span></button>
          ${types.map((t) => html`<button type="button" class="com-chip" data-type="${t}" aria-pressed="${String(type === t)}"><span class="com-chip-dot c-${typeOf(t).tone}"></span>${typeOf(t).plural}<span class="com-chip-count tnum">${counts.get(t)}</span></button>`)}
        </div>` : ""}
        <div data-list></div>`);
      drawList();
    };

    body.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-type]");
      if (chip) {
        type = chip.dataset.type;
        $$("[data-type]", body).forEach((b) => b.setAttribute("aria-pressed", String(b === chip)));
        drawList();
        return;
      }
      const r = e.target.closest("[data-note]");
      if (r) {
        const n = notes.find((x) => `${x.type}:${x.evtId}` === r.dataset.note);
        if (n) openNote(n);
      }
    });

    const openNote = (n) => {
      sheet?.close();
      const t = typeOf(n.type);
      const d = parseDate(n.evtDate);
      const author = personName(n.authorName);
      const wasUnread = !n.readStatus;
      const content = document.createElement("div");
      content.className = "note-sheet";
      const textBlock = (txt) => plain(txt) ? paragraphs(txt) : html`<p class="muted">Il testo di questa nota non è disponibile.</p>`;
      setHTML(content, html`
        <div class="note-sheet-head">
          <span class="com-ic com-ic-lg c-${t.tone}">${icon(t.icon)}</span>
          <div class="stack-sm" style="gap:4px">
            <p class="title-3">${d ? fmtDate(d, { weekday: true, year: d.getFullYear() !== new Date().getFullYear() }) : "Data non indicata"}</p>
            <p class="caption">${[d ? ago(d) : "", n.warningType ? capitalize(String(n.warningType).toLowerCase()) : ""].filter(Boolean).join(" · ") || t.label}</p>
          </div>
        </div>
        <article class="note-text" data-text>${wasUnread && !plain(n.evtText)
          ? html`<div class="skeleton-line" style="width:90%"></div><div class="skeleton-line" style="width:65%"></div>`
          : textBlock(n.evtText)}</article>
        ${author ? html`<div class="note-author"><span class="note-avatar">${initials(author)}</span><div><p class="caption">Scritta da</p><p class="row-title">${author}</p></div></div>` : ""}
        <p class="caption faint note-foot" data-foot></p>`);
      sheet = openSheet({ title: t.label, content, onClose: () => { sheet = null; } });
      if (!wasUnread) return;

      const read = async () => {
        const slot = $("[data-text]", content);
        try {
          const res = await post(`/note/${encodeURIComponent(n.type)}/${encodeURIComponent(n.evtId)}/leggi`);
          const text = res?.note?.event?.evtText;
          if (plain(text)) n.evtText = text;
          setHTML(slot, textBlock(n.evtText));
          n.readStatus = true;
          invalidate("note");
          drawList();
          const foot = $("[data-foot]", content);
          if (foot) foot.textContent = "Segnata come letta anche su ClasseViva.";
        } catch (err) {
          setHTML(slot, html`${plain(n.evtText) ? textBlock(n.evtText) : ""}<div class="com-inline-error"><p class="body-2">${err.message || "Impossibile aprire la nota."}</p>
            <button type="button" class="btn" data-retry-read>${icon("refresh")}Riprova</button></div>`);
          $("[data-retry-read]", slot)?.addEventListener("click", read);
        }
      };
      read();
    };

    const fetchData = async () => {
      try {
        await load("note", () => get("/note"), (data) => {
          notes = flatten(data?.notes);
          draw();
        }, { maxAge: 60_000 });
      } catch (err) {
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => { setHTML(body, skeletonList(4)); fetchData(); });
      }
    };
    await fetchData();
    return () => sheet?.close();
  },
};
