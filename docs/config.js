// 배포 전에 아래 두 값만 본인 Supabase 프로젝트 값으로 교체하세요.
// Publishable(또는 기존 Anon) Key는 브라우저용 공개 키입니다.
// Service Role / Secret Key / SCAN_ACCESS_TOKEN은 절대 이 파일에 넣지 마세요.
const UI_VERSION = "7.5.1-RESIDUAL-TP50-SL10";
const DASHBOARD_REVISION = "7.5.4-r1-ENTRY-DIAGNOSTICS";

window.TRADING_SCANNER_CONFIG = {
  uiVersion: UI_VERSION,
  dashboardRevision: DASHBOARD_REVISION,
  supabaseUrl: "https://etaajwpernzrcdrifdnw.supabase.co",
  supabasePublishableKey: "sb_publishable_FLldZQ4AurlgETbjZp6uVQ_qrSXReHX",
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
  if (subtitle) subtitle.textContent = `UPBIT KRW + BINANCE USDT SPOT · v${UI_VERSION}`;
  document.documentElement.dataset.dashboardRevision = DASHBOARD_REVISION;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyDashboardVersion, { once: true });
else applyDashboardVersion();
window.addEventListener("pageshow", applyDashboardVersion);

(() => {
  const assetVersion = encodeURIComponent(DASHBOARD_REVISION);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `./performance.css?v=${assetVersion}`;
  document.head.appendChild(stylesheet);

  const performanceScript = document.createElement("script");
  performanceScript.src = `./performance.js?v=${assetVersion}`;
  performanceScript.defer = true;
  document.head.appendChild(performanceScript);

  const realizedScript = document.createElement("script");
  realizedScript.src = `./realized-performance.js?v=2-BINANCE-REALIZED-ACCOUNTING`;
  realizedScript.defer = true;
  document.head.appendChild(realizedScript);

  const entryStatusScript = document.createElement("script");
  entryStatusScript.src = `./entry-status.js?v=${assetVersion}`;
  entryStatusScript.defer = true;
  document.head.appendChild(entryStatusScript);

  const dashboardFixScript = document.createElement("script");
  dashboardFixScript.src = `./dashboard-v716-fix.js?v=${assetVersion}`;
  dashboardFixScript.defer = true;
  document.head.appendChild(dashboardFixScript);

  const dashboardOnlyScript = document.createElement("script");
  dashboardOnlyScript.src = `./dashboard-only.js?v=2-REALIZED-TOP`;
  dashboardOnlyScript.defer = true;
  document.head.appendChild(dashboardOnlyScript);
})();
