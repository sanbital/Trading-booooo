(() => {
  "use strict";

  const REALIZED_COLLAPSED_LIMIT = 10;
  let realizedExpanded = false;

  function normalizeOpenPositionDates() {
    const body = document.getElementById("positions-body");
    if (!body) return;
    for (const row of body.querySelectorAll("tr")) {
      const cells = row.querySelectorAll("td");
      if (!cells.length) continue;
      const holdingEnd = cells[cells.length - 1];
      const text = String(holdingEnd.textContent || "").trim().toLowerCase();
      if (text === "invalid date" || text === "infinity" || text === "∞") {
        holdingEnd.textContent = "조건부 보유";
        holdingEnd.title = "순수익 양수 청산 또는 -3% 하드스톱 조건까지 보유";
      }
    }
  }

  function ensureRealizedToggle(body) {
    const tableWrap = body.closest(".realized-table-wrap") || body.closest(".table-wrap");
    if (!tableWrap) return null;

    let footer = document.getElementById("realized-collapse-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.id = "realized-collapse-footer";
      footer.className = "performance-list-footer";
      footer.innerHTML = `
        <span id="realized-visible-count" class="performance-row-summary"></span>
        <div class="performance-pagination">
          <button id="realized-collapse-toggle" class="button-primary performance-action-button" type="button"></button>
        </div>`;
      tableWrap.after(footer);

      document.getElementById("realized-collapse-toggle")?.addEventListener("click", () => {
        realizedExpanded = !realizedExpanded;
        applyRealizedCollapse();
        if (!realizedExpanded) {
          document.getElementById("realized-performance-section")?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      });
    }
    return footer;
  }

  function applyRealizedCollapse() {
    const body = document.getElementById("realized-performance-body");
    if (!body) return;

    const rows = Array.from(body.querySelectorAll("tr"));
    const dataRows = rows.filter(row => !row.querySelector("td[colspan]"));
    const total = dataRows.length;
    const footer = ensureRealizedToggle(body);
    const toggle = document.getElementById("realized-collapse-toggle");
    const count = document.getElementById("realized-visible-count");

    dataRows.forEach((row, index) => {
      row.hidden = !realizedExpanded && index >= REALIZED_COLLAPSED_LIMIT;
    });

    const visible = realizedExpanded ? total : Math.min(total, REALIZED_COLLAPSED_LIMIT);
    if (count) count.textContent = total > REALIZED_COLLAPSED_LIMIT
      ? `최근 ${visible}건 표시 · 총 ${total}건`
      : `${total}건 표시`;

    if (footer) footer.hidden = total <= REALIZED_COLLAPSED_LIMIT;
    if (toggle) {
      toggle.textContent = realizedExpanded ? "접기 · 최근 10건" : `더 보기 · ${total - REALIZED_COLLAPSED_LIMIT}건`;
      toggle.setAttribute("aria-expanded", realizedExpanded ? "true" : "false");
    }
  }

  const positionObserver = new MutationObserver(normalizeOpenPositionDates);
  const realizedObserver = new MutationObserver(applyRealizedCollapse);

  const startPositions = () => {
    const body = document.getElementById("positions-body");
    if (!body) {
      requestAnimationFrame(startPositions);
      return;
    }
    positionObserver.observe(body, { childList: true, subtree: true, characterData: true });
    normalizeOpenPositionDates();
  };

  const startRealized = () => {
    const body = document.getElementById("realized-performance-body");
    if (!body) {
      requestAnimationFrame(startRealized);
      return;
    }
    realizedObserver.observe(body, { childList: true, subtree: true });
    applyRealizedCollapse();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startPositions();
      startRealized();
    }, { once: true });
  } else {
    startPositions();
    startRealized();
  }
})();
