// Upbit Boo independent dashboard configuration.
// This file intentionally contains only the browser-safe Supabase publishable key.
// Never store service-role keys, exchange API secrets, gateway secrets, or operator tokens here.
const UI_VERSION = "7.6.0-UPBIT-BOO";
const DASHBOARD_REVISION = "7.6.3-UPBIT-BOO-r1";
const PERFORMANCE_ASSET_REVISION = "7.6.3-UPBIT-BOO-r1";

window.TRADING_SCANNER_CONFIG = {
  uiVersion: UI_VERSION,
  dashboardRevision: DASHBOARD_REVISION,
  supabaseUrl: "https://yjhwsfmvtonnhdsfkary.supabase.co",
  supabasePublishableKey: "sb_publishable__XgdeCkA2v-aBNVZrDTdMQ_QUfPw_42",
  functionName: "market-scanner",
  autotraderFunctionName: "market-autotrader",
  performanceFunctionName: "market-performance",
  binanceSourceFunctionName: "binance-source",
  binanceOrderSourceFunctionName: "binance-order-source",
  entryStatusFunctionName: "trading-entry-status",
  requestTimeoutMs: 140000,
  defaultCapitalKrw: 500000,
  defaultRiskPct: 1,
  defaultFeePerSidePct: 0.05,
  defaultMinNetRR: 1.5,
  defaultMaxStopPct: 5,
};

function applyDashboardVersion() {
  const subtitle = document.getElementById("brand-subtitle");
  if (subtitle) subtitle.textContent = `UPBIT KRW SPOT · UPBIT BOO · v${UI_VERSION}`;
  document.documentElement.dataset.dashboardRevision = DASHBOARD_REVISION;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyDashboardVersion, { once: true });
else applyDashboardVersion();
window.addEventListener("pageshow", applyDashboardVersion);

(() => {
  const assetVersion = encodeURIComponent(PERFORMANCE_ASSET_REVISION);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `./performance.css?v=${assetVersion}`;
  document.head.appendChild(stylesheet);

  const performanceScript = document.createElement("script");
  performanceScript.src = `./performance.js?v=${assetVersion}`;
  performanceScript.defer = true;
  document.head.appendChild(performanceScript);

  const realizedScript = document.createElement("script");
  realizedScript.src = `./realized-performance.js?v=${assetVersion}`;
  realizedScript.defer = true;
  document.head.appendChild(realizedScript);

  const entryStatusScript = document.createElement("script");
  entryStatusScript.src = `./entry-status.js?v=4-HIDE-SUB-DOLLAR`;
  entryStatusScript.defer = true;
  document.head.appendChild(entryStatusScript);

  const dashboardFixScript = document.createElement("script");
  dashboardFixScript.src = `./dashboard-v716-fix.js?v=${assetVersion}`;
  dashboardFixScript.defer = true;
  document.head.appendChild(dashboardFixScript);

  const dashboardOnlyScript = document.createElement("script");
  dashboardOnlyScript.src = `./dashboard-only.js?v=5-REALIZED-COLLAPSE-ALL-WIDTHS`;
  dashboardOnlyScript.defer = true;
  document.head.appendChild(dashboardOnlyScript);
})();
