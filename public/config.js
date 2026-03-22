(function () {
  const REMOTE_HTTP_BASE = "https://spaggiari2.federicoscutariu.it";
  const REMOTE_WS_BASE = "wss://spaggiari2.federicoscutariu.it";

  function isCapacitorApp() {
    return (
      window.location.protocol === "capacitor:" ||
      window.location.protocol === "ionic:" ||
      window.location.hostname === "localhost"
    );
  }

  const embeddedApp = isCapacitorApp();
  const httpBase = embeddedApp ? REMOTE_HTTP_BASE : "";
  const wsBase = embeddedApp
    ? REMOTE_WS_BASE
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

  window.APP_CONFIG = {
    isEmbeddedApp: embeddedApp,
    HTTP_BASE: httpBase,
    WS_BASE: wsBase,
    apiUrl(path) {
      return `${httpBase}${path}`;
    },
    wsUrl(path) {
      return `${wsBase}${path}`;
    },
  };
})();
