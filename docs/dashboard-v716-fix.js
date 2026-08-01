(() => {
  "use strict";

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

  const observer = new MutationObserver(normalizeOpenPositionDates);
  const start = () => {
    const body = document.getElementById("positions-body");
    if (!body) {
      requestAnimationFrame(start);
      return;
    }
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    normalizeOpenPositionDates();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
