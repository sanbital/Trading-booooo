(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const MOBILE_QUERY = "(max-width: 760px)";
  const REALIZED_LIMIT = 10;
  let realizedExpanded = false;
  let realizedObserver = null;

  function priorityAnchor() {
    return $("trader-notice") || $("trader-alert") || document.querySelector("#trader-console .operator-header");
  }

  function movePrioritySections() {
    const anchor = priorityAnchor();
    const positions = $("positions-body")?.closest(".section-block");
    const livePosition = $("current-position-estimate-section");
    const realized = $("realized-performance-section");
    const diagnostic = $("entry-diagnostic-card");
    const runtime = $("runtime-health-section");
    const orderHistory = $("trade-performance-section");
    if (!anchor || !positions) return false;

    const ordered = [positions, livePosition, realized, diagnostic, runtime, orderHistory].filter(Boolean);
    anchor.after(...ordered);
    return Boolean(realized && runtime && orderHistory);
  }

  function ensureRealizedFooter(body) {
    const tableWrap = body.closest(".realized-table-wrap") || body.closest(".table-wrap");
    if (!tableWrap) return null;

    let footer = $("realized-hard-limit-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.id = "realized-hard-limit-footer";
      footer.className = "performance-list-footer";
      footer.innerHTML = `
        <span id="realized-hard-limit-count" class="performance-row-summary"></span>
        <div class="performance-pagination">
          <button id="realized-hard-limit-toggle" class="button-primary performance-action-button" type="button"></button>
        </div>`;
      tableWrap.after(footer);
      $("realized-hard-limit-toggle")?.addEventListener("click", () => {
        realizedExpanded = !realizedExpanded;
        enforceRealizedLimit();
        if (!realizedExpanded) {
          $("realized-performance-section")?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      });
    }
    return footer;
  }

  function enforceRealizedLimit() {
    const body = $("realized-performance-body");
    if (!body) return;

    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    const rows = [...body.querySelectorAll("tr")].filter(row => !row.querySelector("td[colspan]"));
    const oldFooter = $("realized-collapse-footer");
    if (oldFooter) oldFooter.style.display = mobile ? "none" : "";

    const footer = ensureRealizedFooter(body);
    const toggle = $("realized-hard-limit-toggle");
    const count = $("realized-hard-limit-count");

    rows.forEach((row, index) => {
      const hide = mobile && !realizedExpanded && index >= REALIZED_LIMIT;
      if (hide) {
        row.hidden = true;
        row.style.setProperty("display", "none", "important");
      } else {
        row.hidden = false;
        row.style.removeProperty("display");
      }
    });

    if (!mobile) {
      if (footer) footer.style.display = "none";
      return;
    }

    const visible = realizedExpanded ? rows.length : Math.min(rows.length, REALIZED_LIMIT);
    if (count) count.textContent = rows.length > REALIZED_LIMIT
      ? `최근 ${visible}건 표시 · 총 ${rows.length}건`
      : `${rows.length}건 표시`;

    if (footer) footer.style.display = rows.length > REALIZED_LIMIT ? "flex" : "none";
    if (toggle) {
      toggle.textContent = realizedExpanded ? "접기 · 최근 10건" : `더보기 · ${Math.max(0, rows.length - REALIZED_LIMIT)}건`;
      toggle.setAttribute("aria-expanded", realizedExpanded ? "true" : "false");
    }
  }

  function startRealizedLimiter() {
    const body = $("realized-performance-body");
    if (!body) {
      requestAnimationFrame(startRealizedLimiter);
      return;
    }
    if (!realizedObserver) {
      realizedObserver = new MutationObserver(() => enforceRealizedLimit());
      realizedObserver.observe(body, { childList: true, subtree: true });
      window.matchMedia(MOBILE_QUERY).addEventListener?.("change", () => {
        realizedExpanded = false;
        enforceRealizedLimit();
      });
    }
    enforceRealizedLimit();
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

    startRealizedLimiter();

    if (movePrioritySections()) return;
    const consoleView = $("trader-console");
    if (!consoleView) return;
    const observer = new MutationObserver(() => {
      movePrioritySections();
      enforceRealizedLimit();
      if (movePrioritySections()) observer.disconnect();
    });
    observer.observe(consoleView, { childList: true, subtree: true });
    window.setTimeout(() => { movePrioritySections(); enforceRealizedLimit(); observer.disconnect(); }, 7000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", activateDashboardOnly, { once: true });
  else activateDashboardOnly();
  window.addEventListener("pageshow", () => window.setTimeout(activateDashboardOnly, 0));
})();
