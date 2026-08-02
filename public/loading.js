(function () {
  let progressTimer = null;
  let progressValue = 0;

  function overlayEl() {
    return document.getElementById("loading-overlay");
  }

  function progressBarEl() {
    return document.getElementById("loadingProgressBar");
  }

  function progressTrackEl() {
    return document.querySelector("#loading-overlay .loading-progress");
  }

  function setProgress(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    const bar = progressBarEl();
    const track = progressTrackEl();
    if (bar) bar.style.width = `${clamped}%`;
    if (track) track.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }

  function stopProgressTimer() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function startIndeterminateProgress() {
    stopProgressTimer();
    progressValue = 6;
    setProgress(progressValue);
    progressTimer = window.setInterval(() => {
      const target = progressValue < 75 ? 90 : 97;
      progressValue += (target - progressValue) * 0.14;
      setProgress(progressValue);
    }, 100);
  }

  function lockPage() {
    document.body.classList.add("is-loading");
  }

  function unlockPage() {
    document.body.classList.remove("is-loading");
  }

  window.LoadingScreen = {
    show(message) {
      const overlay = overlayEl();
      if (!overlay) return;

      const text = document.getElementById("loadingText");
      if (text && message) text.textContent = message;

      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");
      overlay.setAttribute("aria-busy", "true");
      lockPage();
      startIndeterminateProgress();
    },

    hide(options) {
      const overlay = overlayEl();
      if (!overlay) return;

      const immediate =
        options === true ||
        (options && typeof options === "object" && options.immediate === true);

      stopProgressTimer();
      setProgress(100);

      const finish = () => {
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("aria-busy", "false");
        unlockPage();
        setProgress(0);
      };

      if (immediate) {
        finish();
        return;
      }

      window.setTimeout(finish, 220);
    },

    setMessage(message) {
      const text = document.getElementById("loadingText");
      if (text && message) text.textContent = message;
    },

    isVisible() {
      const overlay = overlayEl();
      return overlay ? !overlay.classList.contains("hidden") : false;
    },
  };
})();
