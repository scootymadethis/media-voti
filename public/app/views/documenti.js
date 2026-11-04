// Documenti: documenti della scuola (scaricabili da Skoolio) e pagelle (sul sito ClasseViva).
import { get, load, openFile } from "aulera/api";
import { html, icon, setHTML, $, toast, emptyState, errorState, skeletonList } from "aulera/ui";
import { pageHeader } from "aulera/main";

const isReport = (s) => /pagell|scheda|valutaz|esito|certific/i.test(s || "");

/** Link esterno: nell'app apre il browser di sistema, sul web una nuova scheda. */
function openExternal(e) {
  const a = e.target.closest("a[data-external]");
  if (!a) return;
  const nativeOpen = window.Capacitor?.Plugins?.SpaggiariLogin?.openExternal;
  if (window.Capacitor?.isNativePlatform?.() && nativeOpen) {
    e.preventDefault();
    nativeOpen({ url: a.href }).catch(() => toast("Impossibile aprire il link.", { error: true }));
  }
}

export default {
  async render(root) {
    setHTML(root, html`${pageHeader({ eyebrow: "Comunicazioni", title: "Documenti", subtitle: "Documenti della scuola e pagelle." })}
      <div data-body>${skeletonList(2)}<div style="height:28px"></div>${skeletonList(1)}</div>`);
    const body = $("[data-body]", root);

    const draw = (data) => {
      const docs = (data?.documents || []).filter((d) => d && d.hash);
      const reports = (data?.school_reports || []).filter((r) => r && (r.viewLink || r.confirmLink));
      if (!docs.length && !reports.length) {
        setHTML(body, html`<div class="card">${emptyState({ iconName: "doc", title: "Nessun documento", text: "Quando la scuola pubblica documenti o pagelle, li trovi qui." })}</div>`);
        return;
      }
      setHTML(body, html`
        ${reports.length ? html`<section class="com-group">
          <h2 class="overline com-group-label">Pagelle</h2>
          <div class="card list">${reports.map((r) => html`<a class="row" href="${r.viewLink || r.confirmLink}" target="_blank" rel="noopener" data-external>
            <span class="com-ic c-violet">${icon("grades")}</span>
            <span class="row-main"><span class="row-title">${r.desc || "Pagella"}</span><span class="row-sub">Si apre sul sito ClasseViva</span></span>
            <span class="row-trail documenti-ext">${icon("link")}</span></a>`)}</div>
          <p class="com-note">${icon("info")}<span>Le pagelle sono consultabili solo sul sito ufficiale ClasseViva: se il browser non ha già una sessione attiva, ti verrà chiesto di accedere con SPID o CIE.</span></p>
        </section>` : ""}
        <section class="com-group">
          <h2 class="overline com-group-label">Documenti</h2>
          ${docs.length ? html`<div class="card list">${docs.map((d) => html`<button type="button" class="row" data-hash="${d.hash}">
            <span class="com-ic ${isReport(d.desc) ? "c-violet" : "c-blue"}">${icon("doc")}</span>
            <span class="row-main"><span class="row-title">${d.desc || "Documento"}</span><span class="row-sub" data-sub>Tocca per aprire</span></span>
            <span class="row-trail">${icon("download")}</span></button>`)}</div>`
            : html`<div class="card">${emptyState({ iconName: "doc", title: "Nessun documento", text: "La scuola non ha pubblicato altri documenti." })}</div>`}
        </section>`);
    };

    body.addEventListener("click", async (e) => {
      openExternal(e);
      const b = e.target.closest("[data-hash]");
      if (!b || b.dataset.busy) return;
      b.dataset.busy = "1";
      b.classList.add("is-busy");
      const sub = $("[data-sub]", b);
      if (sub) sub.textContent = "Apertura…";
      try {
        await openFile({ kind: "documento", hash: b.dataset.hash });
        if (sub) sub.textContent = "Tocca per aprire";
      } catch (err) {
        if (sub) sub.textContent = "Non disponibile, riprova";
        toast(err.message || "Impossibile aprire il documento.", { error: true });
      } finally {
        delete b.dataset.busy;
        b.classList.remove("is-busy");
      }
    });

    const fetchData = async () => {
      try {
        await load("documenti", () => get("/documenti"), draw, { maxAge: 120_000 });
      } catch (err) {
        setHTML(body, errorState(err));
        $("[data-retry]", body)?.addEventListener("click", () => { setHTML(body, skeletonList(3)); fetchData(); });
      }
    };
    await fetchData();
  },
};
