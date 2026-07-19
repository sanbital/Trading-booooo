// 배포 전에 아래 두 값만 본인 Supabase 프로젝트 값으로 교체하세요.
// Publishable(또는 기존 Anon) Key는 브라우저용 공개 키입니다.
// Service Role / Secret Key / SCAN_ACCESS_TOKEN은 절대 이 파일에 넣지 마세요.
window.TRADING_SCANNER_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabasePublishableKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  functionName: "market-scanner",
  requestTimeoutMs: 140000,
  defaultCapitalKrw: 500000,
  defaultRiskPct: 1,
  defaultFeePerSidePct: 0.05,
  defaultMinNetRR: 1.5,
  defaultMaxStopPct: 5
};
