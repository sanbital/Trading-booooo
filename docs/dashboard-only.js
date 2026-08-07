(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function priorityAnchor() {
    return $("trader-notice") || $("trader-alert") || document.querySelector("#trader-console .operator-header");
  }

  function movePrioritySections() {
    const anchor = priorityAnchor();
    const positions = $("positions-body")?.closest(".section-block");
    const performance = $("trade-performance-section");
    if (!anchor || !positions) return false;

    if (performance) {
      anchor.after(positions, performance);
      return true;
    }

    anchor.after(positions);
    return false;
  }

  function activateDashboardOnly() {
    // app.js attaches this handler before DOMContentLoaded. Triggering the existing button
    // keeps traderVisible/polling state consistent instead of merely overriding CSS.
    const traderButton = document.querySelector('[data-view="trader"]');
    if (traderButton) traderButton.click();

    const tabs = document.querySelector(".app-view-tabs");
    if (tabs) tabs.style.display = "none";

    const scanner = $("scanner-view");
    if (scanner) {
      scanner.classList.add("hidden");
      scanner.setAttribute("aria-hidden", "true");
    }

    const trader = $("trader-view");
    if (trader) {
      trader.classList.remove("hidden");
      trader.removeAttribute("aria-hidden");
    }

    const footer = document.querySelector("footer span:first-child");
    if (footer) footer.textContent = "TRADING-BOOOOO · AUTONOMOUS SPOT OPERATOR";

    const arranged = movePrioritySections();
    if (arranged) return;

    const consoleView = $("trader-console");
    if (!consoleView) return;
    const observer = new MutationObserver(() => {
      if (movePrioritySections()) observer.disconnect();
    });
    observer.observe(consoleView, { childList: true, subtree: true });
    window.setTimeout(() => {
      movePrioritySections();
      observer.disconnect();
    }, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateDashboardOnly, { once: true });
  } else {
    activateDashboardOnly();
  }

  // Safari BFCache restore can resurrect the previous visibility state.
  window.addEventListener("pageshow", () => {
    window.setTimeout(activateDashboardOnly, 0);
  });
})();
