(() => {
  function escapeCsvCell(value) {
    const text = String(value ?? "");
    if (/[",\n\r]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(filename, rows) {
    const lines = rows.map((row) => row.map(escapeCsvCell).join(","));
    const csv = `\uFEFF${lines.join("\n")}`;
    downloadBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
  }

  function extractGrades(data) {
    if (!data || typeof data !== "object") return [];
    const root = data.voti ?? data;
    if (Array.isArray(root)) return root;
    if (Array.isArray(root?.grades)) return root.grades;
    if (root && typeof root === "object") {
      for (const value of Object.values(root)) {
        if (Array.isArray(value)) return value;
      }
    }
    return [];
  }

  function extractAbsenceEvents(data) {
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.assenze?.events)) return data.assenze.events;
    if (Array.isArray(data.events)) return data.events;
    if (Array.isArray(data.assenze)) return data.assenze;
    return [];
  }

  function schoolYearSlug() {
    const year = window.SchoolYear?.getSelectedSchoolYear?.() || "corrente";
    return String(year).replaceAll("/", "-");
  }

  function periodLabel(periodPos) {
    if (periodPos == 1) return "Primo periodo";
    if (periodPos == 3) return "Secondo periodo";
    return String(periodPos ?? "");
  }

  function exportVotiCsv(votiPayload) {
    const grades = extractGrades(votiPayload);
    const rows = [
      ["Data", "Materia", "Voto", "Decimale", "Periodo", "Docente", "Note"],
      ...grades.map((voto) => [
        voto.evtDate || "",
        voto.subjectDesc || "",
        voto.displayValue || "",
        voto.decimalValue ?? "",
        periodLabel(voto.periodPos),
        voto.authorName || voto.teacherName || "",
        voto.notesForFamily || "",
      ]),
    ];
    downloadCsv(`voti-${schoolYearSlug()}.csv`, rows);
    return grades.length;
  }

  function exportAssenzeCsv(assenzePayload) {
    const events = extractAbsenceEvents(assenzePayload);
    const rows = [
      ["Data", "Codice", "Ore", "Giustificata", "Nota"],
      ...events.map((event) => [
        event.evtDate || event.date || "",
        event.evtCode || "",
        event.evtValue ?? "",
        event.isJustified === true || event.justifReasonCode || event.justifReasonDesc
          ? "si"
          : event.isJustified === false
            ? "no"
            : "",
        event.justifReasonDesc || event.notes || event.nota || "",
      ]),
    ];
    downloadCsv(`assenze-${schoolYearSlug()}.csv`, rows);
    return events.length;
  }

  function openPrintWindow({ title, subtitle, tableHtml }) {
    const win = window.open("", "_blank");
    if (!win) {
      throw new Error("Popup bloccato: consenti le finestre per esportare in PDF");
    }
    win.document.write(`<!doctype html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; color: #111; margin: 32px; }
    h1 { font-size: 1.4rem; margin: 0 0 4px; }
    p { color: #555; margin: 0 0 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    @media print { body { margin: 12mm; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${subtitle}</p>
  ${tableHtml}
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));<\/script>
</body>
</html>`);
    win.document.close();
  }

  function exportVotiPdf(votiPayload) {
    const grades = extractGrades(votiPayload);
    const year = window.SchoolYear?.getSelectedSchoolYear?.() || "";
    const rows = grades.map((voto) => `
      <tr>
        <td>${escapeHtml(voto.evtDate || "")}</td>
        <td>${escapeHtml(voto.subjectDesc || "")}</td>
        <td>${escapeHtml(voto.displayValue || "")}</td>
        <td>${escapeHtml(periodLabel(voto.periodPos))}</td>
        <td>${escapeHtml(voto.authorName || voto.teacherName || "")}</td>
      </tr>
    `).join("");
    openPrintWindow({
      title: "Voti Spaggiari 2",
      subtitle: `Anno scolastico ${escapeHtml(year || "corrente")} · ${grades.length} voti`,
      tableHtml: `<table><thead><tr><th>Data</th><th>Materia</th><th>Voto</th><th>Periodo</th><th>Docente</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>Nessun voto</td></tr>"}</tbody></table>`,
    });
    return grades.length;
  }

  function exportAssenzePdf(assenzePayload) {
    const events = extractAbsenceEvents(assenzePayload);
    const year = window.SchoolYear?.getSelectedSchoolYear?.() || "";
    const rows = events.map((event) => `
      <tr>
        <td>${escapeHtml(event.evtDate || event.date || "")}</td>
        <td>${escapeHtml(event.evtCode || "")}</td>
        <td>${escapeHtml(event.evtValue ?? "")}</td>
        <td>${escapeHtml(event.justifReasonDesc || event.notes || "")}</td>
      </tr>
    `).join("");
    openPrintWindow({
      title: "Assenze Spaggiari 2",
      subtitle: `Anno scolastico ${escapeHtml(year || "corrente")} · ${events.length} eventi`,
      tableHtml: `<table><thead><tr><th>Data</th><th>Codice</th><th>Ore</th><th>Nota</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>Nessuna assenza</td></tr>"}</tbody></table>`,
    });
    return events.length;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function mountExportButtons(container, { onCsv, onPdf } = {}) {
    if (!container || container.dataset.exportMounted === "1") return;
    container.dataset.exportMounted = "1";
    container.classList.add("export-actions");
    container.innerHTML = `
      <button type="button" class="btn-secondary export-btn" data-export="csv">Esporta CSV</button>
      <button type="button" class="btn-secondary export-btn" data-export="pdf">Esporta PDF</button>
    `;
    container.querySelector('[data-export="csv"]')?.addEventListener("click", () => onCsv?.());
    container.querySelector('[data-export="pdf"]')?.addEventListener("click", () => onPdf?.());
  }

  window.DataExport = {
    exportVotiCsv,
    exportAssenzeCsv,
    exportVotiPdf,
    exportAssenzePdf,
    mountExportButtons,
    extractGrades,
    extractAbsenceEvents,
  };
})();
