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
  const rate = (value) => Number.isFinite(Number(value)) ? `${fmt(Number(value) * 100, 1)}%` : "—";
  const pctPoint = (value, digits = 1) => Number.isFinite(Number(value))
    ? `${Number(value) >= 0 ? "+" : ""}${fmt(value, digits)}%p`
    : "—";
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

  function phaseLabel(phase) {
    return ({
      IMPULSE: "상승 확산",
      PEAKING: "고점 형성",
      COOLING: "상승 둔화",
      ROLLING_OVER: "단기 하락 전환",
      RECOVERY: "회복",
      STABLE: "안정",
      UNKNOWN: "판정 대기",
    })[String(phase)] || "판정 대기";
  }

  function phaseClass(phase) {
    const key = String(phase || "").toUpperCase();
    if (["IMPULSE", "RECOVERY"].includes(key)) return "regime-bull";
    if (["PEAKING", "COOLING", "STABLE"].includes(key)) return "regime-neutral";
    if (key === "ROLLING_OVER") return "regime-risk-off";
    return "";
  }

  function horizonLabel(minutes) {
    return ({ 30: "30분", 120: "2시간", 360: "6시간" })[Number(minutes)] || `${minutes}분`;
  }

  function directionLabel(direction) {
    return ({
      DOWN: "하락 우세",
      RECOVERY_OR_NON_DOWN: "회복·비하락 우세",
      BULLISH_OR_NON_DOWN: "강세·비하락 우세",
      NO_EDGE: "유의 신호 없음",
    })[String(direction)] || String(direction || "판정 없음");
  }

  function statusLabel(status) {
    return ({
      ACTIVE: "활성",
      EXPIRED: "종료",
      NO_EDGE: "신호 없음",
    })[String(status)] || String(status || "—");
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
          <p class="eyebrow">MARKET REGIME · R60-D12 FORECAST</p>
          <h2>시장 분석 · 국면 전환 · 조건부 전망</h2>
          <p class="market-regime-subtitle">구조적 장세와 Binance 현물·선물 전체 breadth의 단기 국면을 분리해 표시하고, R60-D12 신호가 있을 때만 30분·2시간·6시간 조건부 전망을 냅니다.</p>
        </div>
        <span class="market-regime-safety">OBSERVATION ONLY · 매매 미반영</span>
      </div>
      <div id="market-regime-loading" class="market-regime-empty">대시보드를 열면 시장판단 데이터를 불러옵니다.</div>
      <div id="market-regime-content" class="hidden">
        <div class="market-regime-overview">
          <article class="market-regime-verdict">
            <span>구조적 시장 판정</span>
            <div class="market-regime-title-row">
              <strong id="market-regime-name">—</strong>
              <b id="market-regime-score">—</b>
            </div>
            <small id="market-regime-confidence">—</small>
          </article>
          <article class="market-regime-feature">
            <span>현재 Momentum Phase</span>
            <strong id="market-regime-momentum-phase">—</strong>
            <small id="market-regime-phase-note">R60-D12</small>
          </article>
          <article class="market-regime-feature">
            <span>Binance 30분 Breadth</span>
            <strong id="market-regime-breadth30">—</strong>
            <small id="market-regime-breadth30-note">현물+선물 전체</small>
          </article>
          <article class="market-regime-feature">
            <span>Binance 24시간 Breadth</span>
            <strong id="market-regime-breadth24">—</strong>
            <small>현물+선물 전체</small>
          </article>
          <article class="market-regime-feature">
            <span>최근 R60-D12 신호</span>
            <strong id="market-regime-signal">—</strong>
            <small id="market-regime-signal-note">조건 충족 시 활성</small>
          </article>
        </div>

        <div class="market-regime-validation">
          <div class="market-regime-validation-head">
            <div>
              <span>CONDITIONAL FORECAST</span>
              <strong id="market-regime-forecast-summary">R60-D12 전망 확인 중</strong>
            </div>
            <small id="market-regime-updated">—</small>
          </div>
          <div id="market-regime-forecast" class="market-regime-accuracy"></div>
        </div>

        <div class="market-regime-validation">
          <div class="market-regime-validation-head">
            <div>
              <span>LIVE FORWARD VALIDATION</span>
              <strong id="market-regime-validation-phase">실제 흐름 자동 대조 중</strong>
            </div>
            <small id="market-regime-validation-note">30분·2시간·6시간 결과 자동 채점</small>
          </div>
          <div id="market-regime-accuracy" class="market-regime-accuracy"></div>
        </div>

        <div class="market-regime-footer">
          <span id="market-regime-model">—</span>
          <strong>5분 주기 판정 · R60-D12 조건부 전망 · 진입/청산/사이즈/거래빈도 영향 OFF</strong>
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
      cache: "no-store",
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
          <strong>${samples ? `방향 일치 ${directional}` : "표본 수집 중"}</strong>
          <small>${samples ? `정확 일치 ${exact} · 자동 검증 ${samples.toLocaleString("ko-KR")}건` : "해당 시간이 지난 판정부터 자동 채점됩니다."}</small>
        </article>`;
    }).join("");
  }

  function renderForecast(overlay, data) {
    const target = $("market-regime-forecast");
    if (!target) return;
    const forecast = overlay?.forecast || data?.latest?.features?.conditional_forecast || {};
    const horizons = Array.isArray(forecast?.horizons) ? forecast.horizons : [];
    target.innerHTML = [30, 120, 360].map((horizon) => {
      const row = horizons.find((item) => Number(item?.horizon_minutes) === horizon) || {};
      const probability = Number.isFinite(Number(row.probability))
        ? `${fmt(Number(row.probability) * 100, 0)}%`
        : "—";
      const active = String(row.status) === "ACTIVE";
      const noEdge = String(row.status) === "NO_EDGE";
      return `
        <article>
          <span>${horizonLabel(horizon)} 전망 · ${escapeHtml(statusLabel(row.status))}</span>
          <strong class="${active ? "regime-bull" : noEdge ? "" : "regime-neutral"}">${escapeHtml(directionLabel(row.direction))}${probability !== "—" ? ` ${probability}` : ""}</strong>
          <small>신뢰도 ${escapeHtml(row.confidence || "—")} · ${active ? "현재 유효" : noEdge ? "조건부 우위 없음" : "예측 유효시간 종료"}</small>
        </article>`;
    }).join("");

    const activeRows = horizons.filter((row) => String(row?.status) === "ACTIVE");
    const summary = $("market-regime-forecast-summary");
    if (summary) {
      summary.textContent = activeRows.length
        ? `활성 전망 ${activeRows.map((row) => `${horizonLabel(row.horizon_minutes)} ${directionLabel(row.direction)} ${fmt(finite(row.probability) * 100, 0)}%`).join(" · ")}`
        : "현재 활성 조건부 전망 없음";
    }
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
    $("market-regime-confidence").textContent = `판정 신뢰도 ${fmt(finite(latest.confidence) * 100, 1)}% · ${finite(latest.sample_size, 0).toLocaleString("ko-KR")}개 종목 관측`;

    const overlay = latest.features?.momentum_phase || {};
    const phase = String(overlay.phase || "UNKNOWN");
    const phaseNode = $("market-regime-momentum-phase");
    phaseNode.textContent = phaseLabel(phase);
    phaseNode.className = phaseClass(phase);
    $("market-regime-phase-note").textContent = `${escapeHtml(data.phase_model_revision || overlay.model_revision || "R60-D12")} · ${String(overlay.trading_influence ?? false) === "false" ? "매매 미반영" : "매매 연동"}`;

    $("market-regime-breadth30").textContent = Number.isFinite(Number(overlay.current_binance_breadth_30m_pct))
      ? `${fmt(overlay.current_binance_breadth_30m_pct, 1)}%`
      : "준비 중";
    $("market-regime-breadth30-note").textContent = Number.isFinite(Number(overlay.drop_from_60m_peak_pp))
      ? `최근 60분 고점 대비 ${pctPoint(-Math.abs(Number(overlay.drop_from_60m_peak_pp)), 1)}`
      : "현물+선물 전체";
    $("market-regime-breadth24").textContent = Number.isFinite(Number(overlay.current_binance_breadth_24h_pct))
      ? `${fmt(overlay.current_binance_breadth_24h_pct, 1)}%`
      : "—";

    const signal = overlay.signal || null;
    $("market-regime-signal").textContent = signal
      ? `${fmt(signal.age_minutes, 0)}분 전`
      : "신호 없음";
    $("market-regime-signal-note").textContent = signal
      ? `${dateTime(signal.observed_at)} · 60분 고점 대비 ${pctPoint(-Math.abs(Number(signal.drop_from_peak_pp)), 1)}`
      : "R60-D12 조건 미충족";

    renderForecast(overlay, data);
    renderAccuracy(data);

    const sampleText = [30, 120, 360]
      .map((horizon) => `${horizonLabel(horizon)} ${finite(data?.accuracy?.[String(horizon)]?.samples, 0)}건`)
      .join(" · ");
    $("market-regime-validation-phase").textContent = String(data.learning_phase || "").includes("VALIDATION")
      ? `자동 검증 활성 · ${sampleText}`
      : `자동 검증 수집 중 · ${sampleText}`;
    $("market-regime-updated").textContent = `최근 판정 ${dateTime(latest.observed_at)}`;
    $("market-regime-model").textContent = `${escapeHtml(data.model_revision || "MARKET REGIME")} + ${escapeHtml(data.phase_model_revision || overlay.model_revision || "R60-D12")} · 구조 가중치 고정`;
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