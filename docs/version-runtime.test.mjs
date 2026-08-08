import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const entryStatusSource = await readFile(new URL("./entry-status.js", import.meta.url), "utf8");
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
    "window.__entryStatusTest = { manualPositionCardRow, mergePositionRows }; })();",
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
  assert.equal(rows[0].market_value_quote, 1100);
  assert.equal(rows[0].estimated_pnl_quote, 98.9);
});

test("manual position cards have explicit manual and no-auto-management labels", () => {
  assert.match(entryStatusSource, /row\.is_manual \? "MANUAL"/);
  assert.match(entryStatusSource, /row\.is_manual \? "수동매수"/);
  assert.match(entryStatusSource, /자동매도·성과·학습 대상에서 제외됩니다/);
  assert.match(entryStatusSource, /response\.clone\(\)\.json\(\)\.then\(captureManualPositions\)/);
});
