(() => {
  const config = window.TRADING_SCANNER_CONFIG || {};
  const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${
    config.marketRegimeFunctionName || "market-regime-observer"
  }`;
  let timer = null;
  let loading = false;

  const $ = (id) => document.getElementById(id);
  const finite = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const fmt = (value, digits = 1) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";
  const pct = (value, digits = 1) => Number.isFinite(Number(value))
    ? `${Number(value) >= 0 ? "+" : ""}${fmt(value, digits)}%`
    : "—";
  const rate = (value) => Number.isFinite(Number(value)) ? `${fmt(Number(value) * 100, 1)}%` : "—";
  const dateTime = (value) => value ? new Date(value).toLocaleString("ko-KR") : "—";
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function labelOf(regime) {
    return ({
      STRONG_BULL: "강한 강세",
      BULL: "강세",
      NEUTRAL: "중립",
      RISK_OFF: "위험 회피",
    })[String(regime)] || "판정 대기";
  }

  function horizonLabel(minutes) {
    return ({ 30: "30분", 120: "2시간", 360: "6시간" })[Number(minutes)] || `${minutes}분`;
  }

  function ensurePanel() {
    if ($("market-regime-panel")) return $("market-regime-panel");
    const consoleView = $("trader-console");
    if (!consoleView) return null;
    const panel = document.createElement("section");
    panel.id = "market-regime-panel";
    panel.className = "panel market-regime-panel";
    panel.innerHTML = `
      <div class="market-regime-head">
        <div>
          <p class="eyebrow">MARKET REGIME · AUTO SELF-CHECK</p>
          <h2>시장 분석 · 자동 검증</h2>
          <p class="market-regime-subtitle">현재 장세를 5분마다 판정하고, 30분·2시간·6시간 뒤 실제 흐름과 자동 대조해 일치 여부를 채점합니다.</p>
        </div>
        <span class="market-regime-safety">AUTO SELF-CHECK ON · 매매 미반영</span>
      </div>
      <div id="market-regime-loading" class="market-regime-empty">대시보드를 열면 시장판단 데이터를 불러옵니다.</div>
      <div id="market-regime-content" class="hidden">
        <div class="market-regime-overview">
          <article class="market-regime-verdict">
            <span>현재 시장 판정</span>
            <div class="market-regime-title-row">
              <strong id="market-regime-name">—</strong>
              <b id="market-regime-score">—</b>
            </div>
            <small id="market-regime-confidence">—</small>
          </article>
          <article class="market-regime-feature"><span>BTC 1시간</span><strong id="market-regime-btc">—</strong><small>메이저 모멘텀</small></article>
          <article class="market-regime-feature"><span>ETH 1시간</span><strong id="market-regime-eth">—</strong><small>메이저 모멘텀</small></article>
          <article class="market-regime-feature"><span>상승 종목 비율</span><strong id="market-regime-breadth24">—</strong><small>유동성 상위 120개 · 24H</small></article>
          <article class="market-regime-feature"><span>최근 30분 확산</span><strong id="market-regime-breadth30">—</strong><small id="market-regime-breadth30-note">단기 폭</small></article>
        </div>
        <div class="market-regime-validation">
          <div class="market-regime-validation-head">
            <div><span>AUTO SELF-CHECK</span><strong id="market-regime-phase">일치 여부 자동 검증 중</strong></div>
            <small id="market-regime-updated">—</small>
          </div>
          <div id="market-regime-accuracy" class="market-regime-accuracy"></div>
        </div>
        <div class="market-regime-footer">
          <span id="market-regime-model">—</span>
          <strong>5분 주기 자동 판정·검증 · 진입/청산/사이즈/거래빈도 영향 OFF</strong>
        </div>
      </div>`;
    const operatorHeader = consoleView.querySelector(".operator-header");
    if (operatorHeader) operatorHeader.insertAdjacentElement("afterend", panel);
    else consoleView.prepend(panel);
    return panel;
  }

  async function requestStatus() {
    const token = String($("trader-token")?.value || "").trim();
    if (token.length < 32 || !config.supabaseUrl) return null;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autotrade-token": token,
        ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
      },
      body: JSON.stringify({ action: "status" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function renderAccuracy(data) {
    const target = $("market-regime-accuracy");
    if (!target) return;
    target.innerHTML = [30, 120, 360].map((horizon) => {
      const row = data?.accuracy?.[String(horizon)] || {};
      const samples = finite(row.samples, 0);
      const exact = rate(row.exact_rate);
      const directional = rate(row.directional_rate);
      return `
        <article>
          <span>${horizonLabel(horizon)} 후 자동 대조</span>
          <strong>${samples ? `일치 ${exact}` : "표본 수집 중"}</strong>
          <small>${samples ? `방향 일치 ${directional} · 자동 검증 ${samples.toLocaleString("ko-KR")}건` : "해당 시간이 지난 판정부터 자동 채점됩니다."}</small>
        </article>`;
    }).join("");
  }

  function render(data) {
    ensurePanel();
    const latest = data?.latest;
    if (!latest) {
      $("market-regime-loading").textContent = "첫 시장판단 표본을 수집하는 중입니다.";
      $("market-regime-loading").classList.remove("hidden");
      $("market-regime-content").classList.add("hidden");
      return;
    }
    $("market-regime-loading").classList.add("hidden");
    $("market-regime-content").classList.remove("hidden");
    const regime = String(latest.predicted_regime || "");
    const verdict = $("market-regime-name");
    verdict.textContent = labelOf(regime);
    verdict.className = `regime-${regime.toLowerCase().replaceAll("_", "-")}`;
    $("market-regime-score").textContent = `${fmt(latest.bull_score, 1)} / 100`;
    $("market-regime-confidence").textContent = `판정 신뢰도 ${fmt(finite(latest.confidence) * 100, 1)}% · ${finite(latest.sample_size, 0)}개 유동성 종목 관측`;

    const benchmark = latest.features?.benchmark || {};
    const breadth24 = latest.features?.breadth_24h || {};
    const breadth30 = latest.features?.breadth_30m || null;
    $("market-regime-btc").textContent = pct(benchmark.btc_1h_pct, 2);
    $("market-regime-eth").textContent = pct(benchmark.eth_1h_pct, 2);
    $("market-regime-breadth24").textContent = Number.isFinite(Number(breadth24.positive_fraction))
      ? rate(breadth24.positive_fraction)
      : "—";
    $("market-regime-breadth30").textContent = breadth30
      ? rate(breadth30.positive_fraction)
      : "준비 중";
    $("market-regime-breadth30-note").textContent = breadth30
      ? `중앙값 ${pct(breadth30.median_return_pct, 2)}`
      : "30분 누적 후 활성화";

    const sampleText = [30, 120, 360]
      .map((horizon) => `${horizonLabel(horizon)} ${finite(data?.accuracy?.[String(horizon)]?.samples, 0)}건`)
      .join(" · ");
    $("market-regime-phase").textContent = data.learning_phase === "FORWARD_VALIDATION"
      ? `자동 검증 활성 · ${sampleText}`
      : `자동 검증 수집 중 · ${sampleText}`;
    $("market-regime-updated").textContent = `최근 판정 ${dateTime(latest.observed_at)}`;
    $("market-regime-model").textContent = `${escapeHtml(data.model_revision || "MARKET REGIME")} · 가중치 고정`;
    renderAccuracy(data);
  }

  async function refresh(silent = false) {
    if (loading) return;
    const panel = ensurePanel();
    if (!panel) return;
    const consoleView = $("trader-console");
    const token = String($("trader-token")?.value || "").trim();
    if (!consoleView || consoleView.classList.contains("hidden") || token.length < 32) return;
    loading = true;
    if (!silent && $("market-regime-loading")) $("market-regime-loading").textContent = "시장판단 데이터를 불러오는 중입니다.";
    try {
      const data = await requestStatus();
      if (data) render(data);
    } catch (error) {
      const loadingView = $("market-regime-loading");
      if (loadingView) {
        loadingView.classList.remove("hidden");
        loadingView.textContent = `시장판단 조회 실패: ${error.message || error}`;
      }
    } finally {
      loading = false;
    }
  }

  function startPolling() {
    clearInterval(timer);
    timer = setInterval(() => refresh(true), 15000);
  }

  function init() {
    ensurePanel();
    $("unlock-trader")?.addEventListener("click", () => setTimeout(() => refresh(false), 300));
    $("refresh-trader")?.addEventListener("click", () => refresh(false));
    document.querySelectorAll('[data-view="trader"]').forEach((button) =>
      button.addEventListener("click", () => setTimeout(() => refresh(true), 300))
    );
    const consoleView = $("trader-console");
    if (consoleView) {
      new MutationObserver(() => {
        if (!consoleView.classList.contains("hidden")) refresh(true);
      }).observe(consoleView, { attributes: true, attributeFilter: ["class"] });
    }
    startPolling();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();