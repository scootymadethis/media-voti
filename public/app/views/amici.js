import { html, setHTML } from "aulera/ui";
import { pageHeader } from "aulera/main";
export default { async render(root) { setHTML(root, html`${pageHeader({ title: "amici" })}<div class="card card-pad">In costruzione</div>`); } };
