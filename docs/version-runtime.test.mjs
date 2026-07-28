import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
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
