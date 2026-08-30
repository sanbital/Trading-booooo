import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const entryStatusSource = await readFile(new URL("./entry-status.js", import.meta.url), "utf8");
const realizedPerformanceSource = await readFile(
  new URL("./realized-performance.js", import.meta.url),
  "utf8",
);
const performanceCss = await readFile(new URL("./performance.css", import.meta.url), "utf8");
const helperEnd = source.indexOf("})();");

if (helperEnd < 0) {
  throw new Error("shared dashboard version helper is missing");
}

const helperSource = source.slice(0, helperEnd + 5);

function loadVersionHelper() {
  const subtitle = { textContent: "" };
  const document = {
    getElementById(id) {
      return id === "brand-subtitle" ? subtitle : null;
    },
  };
  const window = {
    TRADING_SCANNER_CONFIG: {
      uiVersion: "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION",
    },
  };
  vm.runInNewContext(helperSource, { document, window });
  return { subtitle, window };
}

test("trading status can update the shared header without a ReferenceError", () => {
  const { subtitle, window } = loadVersionHelper();

  window.updateTradingBrandVersion("5.2.3");
  assert.match(subtitle.textContent, /v5\.2\.3$/);

  window.updateTradingBrandVersion(
    "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION",
    true,
  );
  assert.match(
    subtitle.textContent,
    /v6\.11\.0-CONTINUOUS-ADAPTIVE-EXECUTION$/,
  );
});

test("a later cached scanner response cannot downgrade the operator version", () => {
  const { subtitle, window } = loadVersionHelper();

  window.updateTradingBrandVersion("6.11.0", true);
  window.updateTradingBrandVersion("5.2.3");

  assert.match(subtitle.textContent, /v6\.11\.0$/);
});

test("the dashboard HTML provides every static element required by app.js", () => {
  const requiredIds = new Set(
    [...source.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
  );
  const missing = [...requiredIds].filter(
    (id) => !html.includes(`id="${id}"`),
  );

  assert.deepEqual(
    missing,
    [],
    `index.html is missing app.js elements: ${missing.join(", ")}`,
  );
});

function loadEntryStatusModel() {
  const instrumented = entryStatusSource.replace(
    /\}\)\(\);\s*$/,
    "window.__entryStatusTest = { manualPositionCardRow, mergePositionRows, shouldDisplayPosition, positionDirection }; })();",
  );
  const window = {
    TRADING_SCANNER_CONFIG: {},
    fetch: async () => ({ ok: true }),
  };
  const document = {
    readyState: "loading",
    addEventListener() {},
    getElementById() {
      return null;
    },
  };
  vm.runInNewContext(instrumented, {
    window,
    document,
    Headers,
    Date,
    Number,
    String,
    Set,
    Array,
    clearInterval() {},
    setInterval() {},
    queueMicrotask,
  });
  return window.__entryStatusTest;
}

test("manual autotrader holdings are converted and merged into position cards", () => {
  const model = loadEntryStatusModel();
  const manual = model.manualPositionCardRow({
    id: "manual:binance:ETHUSDT",
    exchange: "binance",
    quote_currency: "USDT",
    market: "ETHUSDT",
    remaining_quantity: 0.5,
    average_entry_price: 2000,
    created_at: "2026-08-08T08:00:00Z",
    metadata: {
      manual_import: {
        mark_price: 2200,
        value_quote: 1100,
        balance_snapshot_at: "2026-08-08T09:00:00Z",
      },
    },
  });
  const automatic = {
    id: "bot-1",
    market: "SPCXBUSDT",
    opened_at: "2026-08-08T07:00:00Z",
  };
  const rows = model.mergePositionRows([automatic], [manual]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, manual.id);
  assert.equal(rows[0].is_manual, true);
  assert.equal(rows[0].state, "MANUAL");
  assert.equal(rows[0].position_side, "LONG");
  assert.equal(rows[0].market_value_quote, 1100);
  assert.equal(rows[0].estimated_pnl_quote, 98.9);
});

test("position direction uses the canonical side and never infers from BUY or SELL", () => {
  const model = loadEntryStatusModel();

  assert.equal(model.positionDirection({ position_side: "SHORT", side: "BUY" }), "SHORT");
  assert.equal(model.positionDirection({ position_side: "LONG", side: "SELL" }), "LONG");
  assert.equal(model.positionDirection({ positionSide: "short" }), "SHORT");
  assert.equal(model.positionDirection({ side: "SELL" }), "LONG");
  assert.match(entryStatusSource, /position-side-badge \$\{directionTone\}/);
});

test("all position and realized-trade surfaces render LONG and SHORT badges", () => {
  assert.match(source, /function positionDirectionBadge\(row\)/);
  assert.match(source, /exchange === "binance_futures"\) continue/);
  assert.match(realizedPerformanceSource, /row\?\.position_side/);
  assert.match(realizedPerformanceSource, /position-side-badge \$\{directionTone\}/);
  assert.match(performanceCss, /\.position-side-long\{/);
  assert.match(performanceCss, /\.position-side-short\{/);
  assert.match(html, /선물 운용 \(롱·숏\)/);
});

test("manual position cards have explicit manual and no-auto-management labels", () => {
  assert.match(entryStatusSource, /row\.is_manual \? "MANUAL"/);
  assert.match(entryStatusSource, /row\.is_manual \? "수동매수"/);
  assert.match(entryStatusSource, /자동매도·성과·학습 대상에서 제외됩니다/);
  assert.match(entryStatusSource, /response\.clone\(\)\.json\(\)\.then\(captureManualPositions\)/);
});

test("the autotrader status card separates the scan stage from the order stage", () => {
  // The order-path ledger (`trading_decisions`) is empty by construction on a scan where
  // every book was refused before an order was ever attempted. Showing only that ledger
  // made a working engine read as "0건 · 탈락 0건" with no reasons at all.
  for (const id of ["entry-scan-stage-count", "entry-scan-stage-30m", "entry-scan-reasons", "entry-scan-reasons-30m"]) {
    assert.match(entryStatusSource, new RegExp(`id="${id}"`), `${id} is missing from the status card`);
  }
  assert.match(entryStatusSource, /data\.scan_stage \|\| null/);
  assert.match(entryStatusSource, /data\.scan_stage_30m \|\| null/);
  assert.match(entryStatusSource, /renderScanStage\("entry-scan-reasons", scanStage, "이번 스캔"\)/);
  assert.match(entryStatusSource, /renderScanStage\("entry-scan-reasons-30m", scanStage30m, "최근 30분"\)/);
  // An empty order stage must point at the scan stage rather than printing a bare zero.
  assert.match(entryStatusSource, /스캔 단계에서 \$\{scanRejected30m\}건이 먼저 탈락했습니다/);
  assert.match(entryStatusSource, /상승률·거래대금 1차 필터 단계에서 전량 제외/);
});

test("position cards hide sub-dollar values without deleting real holdings", () => {
  const model = loadEntryStatusModel();

  assert.equal(model.shouldDisplayPosition({ exchange: "binance", market_value_quote: 0.999 }), false);
  assert.equal(model.shouldDisplayPosition({ exchange: "binance", market_value_quote: 1 }), true);
  assert.equal(model.shouldDisplayPosition({ exchange: "upbit", market_value_quote: 1399 }), false);
  assert.equal(model.shouldDisplayPosition({ exchange: "upbit", market_value_quote: 1400 }), true);
  assert.equal(model.shouldDisplayPosition({ exchange: "upbit", is_manual: true, market_value_quote: null }), false);
  assert.equal(model.shouldDisplayPosition({ exchange: "upbit", is_manual: false, market_value_quote: null }), true);
});
