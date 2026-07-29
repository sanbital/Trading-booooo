// 배포 전에 아래 두 값만 본인 Supabase 프로젝트 값으로 교체하세요.
// Publishable(또는 기존 Anon) Key는 브라우저용 공개 키입니다.
// Service Role / Secret Key / SCAN_ACCESS_TOKEN은 절대 이 파일에 넣지 마세요.
const UI_VERSION = "6.14.1-MOMENTUM-LIVE-TRADE-CONTRACT";
const DASHBOARD_REVISION = "6.14.1-r1-MOMENTUM-LIVE-TRADE-CONTRACT";

window.TRADING_SCANNER_CONFIG = {
  uiVersion: UI_VERSION,
  dashboardRevision: DASHBOARD_REVISION,
  supabaseUrl: "https://etaajwpernzrcdrifdnw.supabase.co",
  supabasePublishableKey: "sb_publishable_FLldZQ4AurlgETbjZp6uVQ_qrSXReHX",
  functionName: "market-scanner",
  autotraderFunctionName: "market-autotrader",
  performanceFunctionName: "market-performance",
  requestTimeoutMs: 140000,
  defaultCapitalKrw: 500000,
  defaultRiskPct: 1,
  defaultFeePerSidePct: 0.05,
  defaultMinNetRR: 1.5,
  defaultMaxStopPct: 5
};

function applyDashboardVersion() {
  const subtitle = document.getElementById("brand-subtitle");
  if (subtitle) {
    subtitle.textContent = `UPBIT KRW + BINANCE USDT SPOT · v${UI_VERSION}`;
  }
  document.documentElement.dataset.dashboardRevision = DASHBOARD_REVISION;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyDashboardVersion, { once: true });
} else {
  applyDashboardVersion();
}
window.addEventListener("pageshow", applyDashboardVersion);

// 성과판은 기존 app.js를 건드리지 않고 보조 모듈로 주입합니다.
// revision을 URL에 포함해 iOS Safari의 오래된 JS/CSS 캐시를 강제로 무효화합니다.
(() => {
  const assetVersion = encodeURIComponent(DASHBOARD_REVISION);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `./performance.css?v=${assetVersion}`;
  document.head.appendChild(stylesheet);

  const script = document.createElement("script");
  script.src = `./performance.js?v=${assetVersion}`;
  script.defer = true;
  document.head.appendChild(script);
})();
