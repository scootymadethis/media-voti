// Didattica: materiale condiviso dai docenti. Docente → cartella → contenuti, ricerca globale,
// "condivisi di recente" in alto. La cartella aperta è nell'URL (?cartella=…) così "indietro" funziona.
import { get, load, openFile } from "aulera/api";
import { html, icon, setHTML, $, $$, toast, fmtDate, relativeDay, parseDate, personName, initials, emptyState, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

const KINDS = {
  file: { label: "File", icon: "doc", tone: "blue", trail: "download" },
  link: { label: "Link", icon: "link", tone: "violet", trail: "link" },
  text: { label: "Testo", icon: "note", tone: "ok", trail: "chevronRight" },
};
const kindOf = (c) => KINDS[String(c.objectType || "").toLowerCase()] || { label: "Contenuto", icon: "doc", tone: "accent", trail: "chevronRight" };
const extOf = (name) => { const m = String(name || "").match(/\.([a-z0-9]{2,5})$/i); return m ? m[1].toUpperCase() : ""; };
const typeLabel = (c) => (String(c.objectType).toLowerCase() === "file" && extOf(c.contentName)) || kindOf(c).label;

/** Nomi tutti in maiuscolo → sentence case. */
function tidy(s) {
  const str = String(s || "").trim().replace(/\s+/g, " ");
  const letters = str.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4 || letters !== letters.toUpperCase()) return str;
  const low = str.toLowerCase();
  return low.replace(/\p{L}/u, (c) => c.toUpperCase());
}
const time = (v) => parseDate(v)?.getTime() || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function normalize(teachers) {
  return (teachers || []).filter(Boolean).map((t, ti) => {
    const id = String(t.teacherId ?? `t${ti}`);
    const name = personName(t.teacherName || [t.teacherLastName, t.teacherFirstName].filter(Boolean).join(" ")) || "Docente";
    const folders = (t.folders || []).filter(Boolean).map((f, fi) => {
      const contents = (f.contents || []).filter(Boolean).map((c) => ({ ...c, teacherName: name, folderName: tidy(f.folderName) || "Cartella" }))
        .sort((a, b) => time(b.shareDT) - time(a.shareDT));
      const last = f.lastShareDT || contents[0]?.shareDT;
      return { key: `${id}~${f.folderId ?? fi}`, name: tidy(f.folderName) || "Cartella", last, contents };
    }).sort((a, b) => time(b.last) - time(a.last));
    const total = folders.reduce((s, f) => s + f.contents.length, 0);
    return { id, name, folders, total, last: folders[0]?.last };
  }).sort((a, b) => time(b.last) - time(a.last));
}

let pushedFromRoot = false;

export default {
  async render(root, ctx) {
    const folderKey = ctx.params.get("cartella");
    let teachers = [];
    let query = "";

    setHTML(root, html`<div data-head>${folderKey ? html`<button type="button" class="com-back" data-back>${icon("chevronLeft")}<span>Didattica</span></button>` : ""}
      ${pageHeader(folderKey
        ? { eyebrow: "Docente", title: "Cartella", subtitle: "Caricamento…" }
        : { eyebrow: "Comunicazioni", title: "Didattica", subtitle: "Il materiale condiviso dai docenti." })}</div>
      <div data-body>${folderKey ? "" : html`<div class="skeleton" style="height:44px;border-radius:999px;margin-bottom:24px"></div>`}${skeletonList(5)}</div>`);
    const head = $("[data-head]", root);
    const body = $("[data-body]", root);

    const contentRow = (c, { path = false } = {}) => {
      const k = kindOf(c);
      const d = parseDate(c.shareDT);
      const sub = [typeLabel(c), path ? `${c.teacherName} · ${c.folderName}` : "", d ? relativeDay(d) : ""].filter(Boolean).join(" · ");
      return html`<button type="button" class="row didattica-item" data-content="${c.contentId}">
        <span class="com-ic c-${k.tone}">${icon(k.icon)}</span>
        <span class="row-main"><span class="row-title clamp-2">${c.contentName || "Senza nome"}</span><span class="row-sub" data-sub>${sub}</span></span>
        <span class="row-trail">${icon(k.trail, k.trail === "chevronRight" ? "chev" : "didattica-trail")}</span>
      </button>`;
    };
    const allContents = () => teachers.flatMap((t) => t.folders.flatMap((f) => f.contents));
    const findContent = (id) => allContents().find((c) => String(c.contentId) === String(id));

    /* ---------- cartella ---------- */
    const drawFolder = () => {
      const teacher = teachers.find((t) => t.folders.some((f) => f.key === folderKey));
      const folder = teacher?.folders.find((f) => f.key === folderKey);
      if (!folder) {
        ctx.navigate("/didattica", { replace: true });
        return;
      }
      document.title = `${folder.name} · Ardesia`;
      const last = parseDate(folder.last);
      const updated = last ? (relativeDay(last) === fmtDate(last) ? `il ${fmtDate(last)}` : relativeDay(last).toLowerCase()) : "";
      $(".page-header .eyebrow", head).textContent = teacher.name;
      $(".large-title", head).textContent = folder.name;
      $(".page-header .subtitle", head).textContent = `${plural(folder.contents.length, "elemento", "elementi")}${updated ? ` · aggiornata ${updated}` : ""}`;
      requestAnimationFrame(() => { const bar = document.querySelector(".topbar-title"); if (bar) bar.textContent = folder.name; });
      setHTML(body, folder.contents.length
        ? html`<div class="card list">${folder.contents.map((c) => contentRow(c))}</div>`
        : html`<div class="card">${emptyState({ iconName: "folder", title: "Cartella vuota", text: "Il docente non ha ancora condiviso niente qui." })}</div>`);
    };

    /* ---------- elenco ---------- */
    const drawResults = () => {
      const box = $("[data-results]", body);
      if (!box) return;
      const q = query.trim().toLowerCase();
      if (!q) { drawHome(box); return; }
      const contents = allContents().filter((c) => `${c.contentName} ${c.folderName} ${c.teacherName}`.toLowerCase().includes(q));
      const folders = teachers.flatMap((t) => t.folders.map((f) => ({ ...f, teacher: t.name }))).filter((f) => `${f.name} ${f.teacher}`.toLowerCase().includes(q));
      if (!contents.length && !folders.length) {
        setHTML(box, html`<div class="card"><div class="empty">${icon("search")}<p class="title-3">Nessun risultato</p><p class="body-2">Nessun file, link o cartella contiene “${query.trim()}”.</p></div></div>`);
        return;
      }
      setHTML(box, html`
        ${folders.length ? html`<section class="com-group"><h2 class="overline com-group-label">Cartelle</h2>
          <div class="card list">${folders.map((f) => html`<a class="row" href="/didattica?cartella=${encodeURIComponent(f.key)}" data-folder>
            <span class="com-ic c-accent">${icon("folder")}</span>
            <span class="row-main"><span class="row-title">${f.name}</span><span class="row-sub">${f.teacher} · ${plural(f.contents.length, "elemento", "elementi")}</span></span>
            ${icon("chevronRight", "chev")}</a>`)}</div></section>` : ""}
        ${contents.length ? html`<section class="com-group"><h2 class="overline com-group-label">Materiale<span class="faint tnum"> · ${contents.length}</span></h2>
          <div class="card list">${contents.map((c) => contentRow(c, { path: true }))}</div></section>` : ""}`);
    };

    const drawHome = (box) => {
      const recent = allContents().filter((c) => time(c.shareDT) > Date.now() - 30 * 86400_000)
        .sort((a, b) => time(b.shareDT) - time(a.shareDT)).slice(0, 8);
      setHTML(box, html`
        ${recent.length ? html`<section class="com-group">
          <h2 class="overline com-group-label">Condivisi di recente</h2>
          <div class="didattica-recent" role="list">${recent.map((c) => {
            const k = kindOf(c);
            return html`<button type="button" role="listitem" class="card didattica-recent-card pressable" data-content="${c.contentId}">
              <span class="spread"><span class="com-ic c-${k.tone}">${icon(k.icon)}</span><span class="chip">${typeLabel(c)}</span></span>
              <span class="title-3 clamp-2">${c.contentName || "Senza nome"}</span>
              <span class="caption didattica-recent-meta" data-sub>${c.teacherName} · ${relativeDay(c.shareDT)}</span>
            </button>`;
          })}</div></section>` : ""}
        <section class="com-group">
          <h2 class="overline com-group-label">Docenti<span class="faint tnum"> · ${teachers.length}</span></h2>
          <div class="didattica-teachers">${teachers.map((t) => html`<section class="card didattica-teacher">
            <header class="didattica-teacher-head">
              <span class="didattica-avatar">${initials(t.name)}</span>
              <div class="row-main"><p class="title-3">${t.name}</p><p class="caption">${plural(t.folders.length, "cartella", "cartelle")} · ${plural(t.total, "elemento", "elementi")}</p></div>
            </header>
            ${t.folders.length ? html`<div class="list">${t.folders.map((f) => html`<a class="row" href="/didattica?cartella=${encodeURIComponent(f.key)}" data-folder>
              <span class="com-ic c-accent">${icon("folder")}</span>
              <span class="row-main"><span class="row-title">${f.name}</span><span class="row-sub">${plural(f.contents.length, "elemento", "elementi")}${f.last ? ` · ${relativeDay(f.last)}` : ""}</span></span>
              ${icon("chevronRight", "chev")}</a>`)}</div>` : html`<p class="caption didattica-none">Nessuna cartella condivisa.</p>`}
          </section>`)}</div>
        </section>`);
    };

    const drawRoot = () => {
      if (!teachers.length) {
        setHTML(body, html`<div class="card">${emptyState({ iconName: "folder", title: "Nessun materiale", text: "Quando i docenti condividono file, link o testi, li trovi qui divisi per docente e cartella." })}</div>`);
        return;
      }
      const total = allContents().length;
      const sub = $(".page-header .subtitle", head);
      if (sub) sub.textContent = `${plural(total, "elemento condiviso", "elementi condivisi")} da ${plural(teachers.length, "docente", "docenti")}.`;
      if (!$("[data-results]", body)) {
        setHTML(body, html`<label class="search com-search didattica-search">${icon("search")}<input class="field" type="search" placeholder="Cerca file, link e cartelle" aria-label="Cerca nel materiale" value="${query}" enterkeyhint="search" autocomplete="off" /></label>
          <div data-results></div>`);
        $(".com-search input", body).addEventListener("input", (e) => { query = e.target.value; drawResults(); });
      }
      drawResults();
    };

    /* ---------- interazioni ---------- */
    root.addEventListener("click", async (e) => {
      if (e.target.closest("[data-back]")) {
        if (pushedFromRoot) { pushedFromRoot = false; history.back(); } else ctx.navigate("/didattica");
        return;
      }
      if (e.target.closest("[data-folder]")) { pushedFromRoot = true; return; } // il router gestisce il link
      const b = e.target.closest("[data-content]");
      if (!b || b.dataset.busy) return;
      const c = findContent(b.dataset.content);
      if (!c) return;
      b.dataset.busy = "1";
      b.classList.add("is-busy");
      const sub = $("[data-sub]", b);
      const prev = sub?.textContent;
      if (sub) sub.textContent = "Apertura…";
      try {
        await openFile({ kind: "didattica", content_id: String(c.contentId) });
      } catch (err) {
        toast(err.message || "Impossibile aprire il contenuto.", { error: true });
      } finally {
        if (sub) sub.textContent = prev;
        delete b.dataset.busy;
        b.classList.remove("is-busy");
      }
    });

    const fetchData = async () => {
      try {
        await load("didattica", () => get("/didattica"), (data) => {
          teachers = normalize(data?.teachers);
          if (folderKey) drawFolder(); else drawRoot();
        }, { maxAge: 120_000 });
      } catch (err) {
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => { setHTML(body, skeletonList(5)); fetchData(); });
      }
    };
    await fetchData();
  },
};
