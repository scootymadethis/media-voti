// Personalizza: tema, colore principale, barra in basso, schede della home, densità, sfondo.
// Le scelte valgono su tutti i dispositivi (salvate sul server da setPrefs).
import { html, icon, setHTML, $, $$, segmented, bindSegmented, toast } from "aulera/ui";
import { state, setPrefs, ACCENTS, HOME_CARDS, DEFAULT_TABS } from "aulera/state";
import { pageHeader, ROUTES } from "aulera/main";

const TAB_CANDIDATES = ["/oggi", "/voti", "/agenda", "/orario", "/assenze", "/lezioni", "/bacheca", "/note", "/didattica", "/documenti", "/libri", "/classifica", "/amici", "/notifiche", "/profilo"];

function routeOf(path) { return ROUTES.find((r) => r.path === path); }

export default {
  async render(root) {
    const draw = () => {
      const p = state.prefs;
      const tabs = (p.tabs?.length === 4 ? p.tabs : DEFAULT_TABS).slice();
      const order = [...(p.home_order || []), ...HOME_CARDS.map((c) => c.id)].filter((id, i, a) => a.indexOf(id) === i && HOME_CARDS.some((c) => c.id === id));
      const hidden = new Set(p.home_hidden || []);
      setHTML(root, html`
        ${pageHeader({ eyebrow: "Account", title: "Personalizza", subtitle: "Colori e layout di Skoolio. Valgono su telefono e computer." })}

        <section class="card card-pad cz-preview" aria-hidden="true">
          <div class="cz-preview-top"><img src="/assets/skoolio-512.png" alt="" /><div><p class="title-3">Skoolio</p><p class="caption">Anteprima</p></div>
            <span class="btn btn-primary cz-preview-btn">Pulsante</span></div>
          <div class="cz-grades"><span class="grade g-good">8½</span><span class="grade g-good">7</span><span class="grade g-ok">6</span><span class="grade g-bad">5</span><span class="grade g-bad g-fire">3</span></div>
          <div class="cz-tabs">${tabs.map((t, i) => { const r = routeOf(t); return r ? html`<span class="${i === 0 ? "on" : ""}">${icon(r.icon)}<small>${r.title}</small></span>` : ""; })}<span>${icon("more")}<small>Altro</small></span></div>
        </section>

        <section class="section">
          <div class="section-head"><p class="overline">Tema</p></div>
          <div class="card card-pad stack">
            ${segmented("theme", [{ value: "auto", label: "Automatico" }, { value: "light", label: "Chiaro" }, { value: "dark", label: "Scuro" }], p.theme || "auto")}
            <div class="cz-swatches" role="radiogroup" aria-label="Colore principale">
              ${ACCENTS.map((a) => html`<button type="button" class="cz-swatch pressable" role="radio" aria-checked="${String((p.accent || "red") === a.id)}" data-accent="${a.id}" style="--sw:${a.color}" aria-label="${a.label}">
                <span class="cz-dot"></span><span class="caption">${a.label}</span></button>`)}
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><p class="overline">Barra in basso</p><span class="caption">4 sezioni + Altro</span></div>
          <ul class="card list" data-tabs>
            ${tabs.map((t, i) => { const r = routeOf(t); return r ? html`<li class="row">
              <span class="row-icon">${icon(r.icon)}</span><div class="row-main"><p class="row-title">${r.title}</p><p class="row-sub">Posizione ${i + 1}</p></div>
              <div class="row-trail cz-move">
                <button type="button" class="btn btn-icon" data-tab-up="${i}" aria-label="Sposta a sinistra" ${i === 0 ? "disabled" : ""}>${icon("arrowUp")}</button>
                <button type="button" class="btn btn-icon" data-tab-down="${i}" aria-label="Sposta a destra" ${i === tabs.length - 1 ? "disabled" : ""}>${icon("arrowDown")}</button>
                <button type="button" class="btn btn-icon" data-tab-swap="${i}" aria-label="Cambia sezione">${icon("refresh")}</button>
              </div></li>` : ""; })}
          </ul>
          <div class="cz-picker" data-picker hidden>
            <p class="caption" style="margin:12px 4px 8px">Scegli la sezione da mettere al posto <span data-picker-pos></span>:</p>
            <div class="cz-chips">${TAB_CANDIDATES.filter((t) => routeOf(t) && !tabs.includes(t)).map((t) => { const r = routeOf(t); return html`<button type="button" class="chip cz-chip pressable" data-pick="${t}">${icon(r.icon)}${r.title}</button>`; })}</div>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><p class="overline">Schede della home</p><span class="caption">ordine e visibilità</span></div>
          <ul class="card list">
            ${order.map((id, i) => { const c = HOME_CARDS.find((x) => x.id === id); return html`<li class="row">
              <button type="button" class="switch" role="switch" aria-checked="${String(!hidden.has(id))}" data-card-toggle="${id}" aria-label="Mostra ${c.label}"></button>
              <div class="row-main"><p class="row-title">${c.label}</p></div>
              <div class="row-trail cz-move">
                <button type="button" class="btn btn-icon" data-card-up="${i}" aria-label="Sposta su" ${i === 0 ? "disabled" : ""}>${icon("arrowUp")}</button>
                <button type="button" class="btn btn-icon" data-card-down="${i}" aria-label="Sposta giù" ${i === order.length - 1 ? "disabled" : ""}>${icon("arrowDown")}</button>
              </div></li>`; })}
          </ul>
        </section>

        <section class="section">
          <div class="section-head"><p class="overline">Altro</p></div>
          <ul class="card list">
            <li class="row"><div class="row-main"><p class="row-title">Densità</p><p class="row-sub">Compatta mostra più contenuti per schermata</p></div>
              <div class="row-trail">${segmented("density", [{ value: "comfortable", label: "Standard" }, { value: "compact", label: "Compatta" }], p.density || "comfortable")}</div></li>
            <li class="row"><div class="row-main"><p class="row-title">Sfondo colorato</p><p class="row-sub">Il bagliore dietro i pannelli in vetro</p></div>
              <button type="button" class="switch" role="switch" aria-checked="${String(p.background !== false)}" data-background aria-label="Sfondo colorato"></button></li>
          </ul>
          <button type="button" class="btn btn-block" data-reset style="margin-top:16px">${icon("refresh")}Ripristina le impostazioni predefinite</button>
        </section>`);

      bindSegmented(root, "theme", (v) => setPrefs({ theme: v }));
      bindSegmented(root, "density", (v) => setPrefs({ density: v }));
    };

    const moveIn = (list, i, d) => { const a = list.slice(); const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };
    let swapIndex = null;

    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const p = state.prefs;
      const tabs = (p.tabs?.length === 4 ? p.tabs : DEFAULT_TABS).slice();
      const order = [...(p.home_order || []), ...HOME_CARDS.map((c) => c.id)].filter((id, i, a) => a.indexOf(id) === i && HOME_CARDS.some((c) => c.id === id));
      if (b.dataset.accent) { setPrefs({ accent: b.dataset.accent }); draw(); return; }
      if (b.dataset.tabUp) { setPrefs({ tabs: moveIn(tabs, +b.dataset.tabUp, -1) }); draw(); return; }
      if (b.dataset.tabDown) { setPrefs({ tabs: moveIn(tabs, +b.dataset.tabDown, 1) }); draw(); return; }
      if (b.dataset.tabSwap) {
        swapIndex = +b.dataset.tabSwap;
        const picker = $("[data-picker]", root);
        picker.hidden = false;
        $("[data-picker-pos]", root).textContent = `${swapIndex + 1} (${routeOf(tabs[swapIndex])?.title || ""})`;
        picker.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      if (b.dataset.pick && swapIndex !== null) {
        tabs[swapIndex] = b.dataset.pick;
        swapIndex = null;
        setPrefs({ tabs });
        draw();
        toast("Barra in basso aggiornata");
        return;
      }
      if (b.dataset.cardToggle) {
        const hidden = new Set(p.home_hidden || []);
        hidden.has(b.dataset.cardToggle) ? hidden.delete(b.dataset.cardToggle) : hidden.add(b.dataset.cardToggle);
        setPrefs({ home_hidden: [...hidden], home_order: order });
        b.setAttribute("aria-checked", String(!hidden.has(b.dataset.cardToggle)));
        return;
      }
      if (b.dataset.cardUp) { setPrefs({ home_order: moveIn(order, +b.dataset.cardUp, -1) }); draw(); return; }
      if (b.dataset.cardDown) { setPrefs({ home_order: moveIn(order, +b.dataset.cardDown, 1) }); draw(); return; }
      if ("background" in b.dataset) { const on = p.background === false; setPrefs({ background: on }); b.setAttribute("aria-checked", String(on)); return; }
      if ("reset" in b.dataset) {
        setPrefs({ theme: "auto", accent: "red", density: "comfortable", background: true, tabs: DEFAULT_TABS, home_order: HOME_CARDS.map((c) => c.id), home_hidden: [] });
        draw();
        toast("Impostazioni predefinite ripristinate");
      }
    });
    draw();
  },
};
