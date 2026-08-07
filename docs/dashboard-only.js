(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  function priorityAnchor() {
    return $("trader-notice") || $("trader-alert") || document.querySelector("#trader-console .operator-header");
  }

  function movePrioritySections() {
    const anchor = priorityAnchor();
    const positions = $("positions-body")?.closest(".section-block");
    const realized = $("realized-performance-section");
    const runtime = $("runtime-health-section");
    const orderHistory = $("trade-performance-section");
    if (!anchor || !positions) return false;

    const ordered = [positions, realized, runtime, orderHistory].filter(Boolean);
    anchor.after(...ordered);
    return Boolean(realized && runtime && orderHistory);
  }

  function activateDashboardOnly() {
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

    if (movePrioritySections()) return;
    const consoleView = $("trader-console");
    if (!consoleView) return;
    const observer = new MutationObserver(() => {
      if (movePrioritySections()) observer.disconnect();
    });
    observer.observe(consoleView, { childList: true, subtree: true });
    window.setTimeout(() => { movePrioritySections(); observer.disconnect(); }, 7000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", activateDashboardOnly, { once: true });
  else activateDashboardOnly();
  window.addEventListener("pageshow", () => window.setTimeout(activateDashboardOnly, 0));
})();
