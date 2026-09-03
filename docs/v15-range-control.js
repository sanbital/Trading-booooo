(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const $ = id => document.getElementById(id);
  const originalFetch = window.fetch.bind(window);
  let capturedToken = "";
  let busy = false;
  let pendingIntent = "";
  let latestData = null;
  let timer = null;
  let authWaitTimer = null;

  function tokenFromInput() {
    return String($("trader-token")?.value || "").trim();
  }

  function bridgedToken() {
    return String(window.__TRADING_DASHBOARD_AUTH__?.token || "").trim();
  }

  function accessToken() {
    const bridged = bridgedToken();
    if (bridged.length >= 32) return bridged;
    const input = tokenFromInput();
    if (input.length >= 32) return input;
    if (capturedToken.length >= 32) return capturedToken;
    return "";
  }

  function rememberToken(value) {
    const token = String(value || "").trim();
    if (token.length < 32) return false;
    capturedToken = token;
    return true;
  }

  function endpoint() {
    return `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/v15-range-live-control`;
  }

  function ensureStyle() {
    if ($("v15-range-control-style")) return;
    const link = document.createElement("link");
    link.id = "v15-range-control-style";
    link.rel = "stylesheet";
    link.href = "./v15-range-control.css?v=2-V15-R7-LIVE-CONTROL";
    document.head.appendChild(link);
  }

  function ensureCard() {
    ensureStyle();
    let section = $("v15-range-control-section");
    if (section) return section;
    section = document.createElement("section");
    section.id = "v15-range-control-section";
    section.className = "section-block";
    section.innerHTML = `
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">V15 RANGE LIVE CONTROL</p><h2>V15 RANGE 실거래</h2></div>
        <p>버튼 한 번으로 V15 R7 운용을 재개합니다. 실제 진입은 R7 안전조건을 충족할 때만 실행됩니다.</p>
      </div>
      <article class="panel v15-control-panel">
        <div class="v15-control-head">
          <div>
            <div id="v15-range-control-state" class="v15-control-state">운용 상태 확인 중</div>
            <div id="v15-range-control-message" class="muted">아래 버튼으로 V15 RANGE 운용을 제어합니다.</div>
          </div>
        </div>
        <div class="v15-control-grid">
          <div><span>현재 레짐</span><b id="v15-range-control-regime">—</b></div>
          <div><span>가용 자금</span><b id="v15-range-control-available">—</b></div>
          <div><span>현재 지원 슬롯</span><b id="v15-range-control-slots">—</b></div>
          <div><span>주문 실행회로</span><b id="v15-range-control-compiled">—</b></div>
        </div>
        <div id="v15-range-control-blockers" class="v15-control-blockers"></div>
        <div class="v15-control-actions">
          <button id="v15-range-control-action" class="button-primary" type="button">V15 RANGE 운용 재개</button>
          <span id="v15-range-control-updated" class="muted"></span>
        </div>
        <div class="v15-control-note">운용이 켜져 있어도 현재 레짐·BTC72·ATR·BB·거래대금·가용자금·거래소↔DB reconciliation 조건을 통과하지 못하면 주문하지 않고 대기합니다.</div>
      </article>`;
    const anchor = $("trader-notice") || $("trader-alert") || document.querySelector("#trader-console .operator-header");
    const positions = $("positions-body")?.closest(".section-block");
    if (anchor) anchor.after(section);
    else if (positions) positions.before(section);
    else $("trader-console")?.prepend(section);
    $("v15-range-control-action")?.addEventListener("click", toggleLive);
    return section;
  }

  function fmtUsdt(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? `${number.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} USDT`
      : "—";
  }

  function showLocal(message, stateText = "V15 RANGE") {
    ensureCard();
    const state = $("v15-range-control-state");
    if (state) {
      state.className = "v15-control-state";
      state.textContent = stateText;
    }
    const msg = $("v15-range-control-message");
    if (msg) msg.textContent = message;
    const action = $("v15-range-control-action");
    if (action) {
      action.disabled = busy;
      if (!latestData?.runtime?.liveEnabled) action.textContent = "V15 RANGE 운용 재개";
    }
  }

  function render(data) {
    latestData = data;
    ensureCard();
    const runtime = data?.runtime || {};
    const pf = data?.preflight || {};
    const live = runtime.liveEnabled === true;
    const operationalReady = data?.activationReady === true;
    const entryReady = data?.entryGateReady === true;
    const state = $("v15-range-control-state");
    state.className = `v15-control-state ${live ? "v15-state-live" : operationalReady ? "v15-state-ready" : "v15-state-blocked"}`;
    state.textContent = live ? "실거래 운용 중" : operationalReady ? "운용 재개 가능" : "안전 점검 필요";

    if (live) {
      $("v15-range-control-message").textContent = entryReady
        ? "V15은 LIVE 상태이며 R7 진입조건도 현재 충족 중입니다."
        : "V15은 LIVE 상태입니다. 현재 R7 진입조건이 아니므로 주문 없이 대기합니다.";
    } else if (operationalReady) {
      $("v15-range-control-message").textContent = "아래 버튼을 누르면 즉시 V15 RANGE 운용 상태가 LIVE로 전환됩니다.";
    } else {
      $("v15-range-control-message").textContent = "하드 안전조건을 먼저 정상화해야 운용을 재개할 수 있습니다.";
    }

    $("v15-range-control-regime").textContent = pf.regime
      ? `${pf.regime} · ${(Number(pf.confidence || 0) * 100).toFixed(1)}%`
      : "—";
    $("v15-range-control-available").textContent = fmtUsdt(pf.availableUsdt);
    $("v15-range-control-slots").textContent = Number.isFinite(Number(pf.equitySupportedSlots))
      ? `${pf.equitySupportedSlots} / ${runtime.maxSlots || 10}`
      : "—";
    $("v15-range-control-compiled").textContent = runtime.orderRoutingCompiled ? "READY" : "NOT READY";

    const blockers = Array.isArray(data?.blockers) ? data.blockers : [];
    const entryBlockers = Array.isArray(data?.entryBlockers) ? data.entryBlockers : [];
    $("v15-range-control-blockers").textContent = blockers.length
      ? `운용 차단: ${blockers.join(" · ")}`
      : live && entryBlockers.length
      ? `현재 진입 대기: ${entryBlockers.join(" · ")}`
      : "";

    const action = $("v15-range-control-action");
    action.disabled = busy || (!live && latestData && !operationalReady);
    action.textContent = live ? "V15 RANGE 신규 진입 중지" : "V15 RANGE 운용 재개";
    action.classList.toggle("v15-live-stop", live);
    action.dataset.live = live ? "true" : "false";
    $("v15-range-control-updated").textContent = pf.checkedAt
      ? `검증 ${new Date(pf.checkedAt).toLocaleString("ko-KR")}`
      : "";
  }

  async function callControl(action, refresh = false) {
    const token = accessToken();
    if (!token || token.length < 32) throw new Error("DASHBOARD_TOKEN_UNAVAILABLE");
    const response = await originalFetch(endpoint(), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-autotrade-token": token,
        ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
      },
      body: JSON.stringify({ action, refresh }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) capturedToken = "";
      const reason = Array.isArray(data?.blockers) && data.blockers.length
        ? data.blockers.join(" · ")
        : data?.error || `HTTP ${response.status}`;
      throw new Error(reason);
    }
    return data;
  }

  async function load(refresh = false) {
    if (busy) return;
    if (accessToken().length < 32) {
      showLocal("기존 대시보드 운영 인증을 연결하는 중입니다.", "운용 재개 대기");
      requestDashboardToken();
      return;
    }
    try {
      const data = await callControl("status", refresh);
      render(data);
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) === "UNAUTHORIZED") {
        showLocal("기존 대시보드 운영 인증을 다시 연결하는 중입니다.", "인증 재연결");
        requestDashboardToken();
        return;
      }
      showLocal(error instanceof Error ? error.message : String(error), "상태 확인 실패");
    }
  }

  function requestDashboardToken() {
    const bridged = bridgedToken();
    if (rememberToken(bridged)) return true;
    const input = tokenFromInput();
    if (rememberToken(input)) return true;
    const refresh = $("refresh-trader");
    if (refresh && !refresh.disabled) {
      refresh.click();
      return true;
    }
    const unlock = $("unlock-trader");
    if (unlock && !unlock.disabled && input.length >= 32) {
      unlock.click();
      return true;
    }
    return false;
  }

  async function executeIntent(action) {
    if (busy) return;
    rememberToken(bridgedToken());
    rememberToken(tokenFromInput());
    const token = accessToken();
    if (token.length < 32) {
      pendingIntent = action;
      showLocal("대시보드 운영 인증 연결 중…", "운용 재개 준비");
      const actionButton = $("v15-range-control-action");
      if (actionButton) {
        actionButton.disabled = true;
        actionButton.textContent = "인증 연결 중…";
      }
      requestDashboardToken();
      clearTimeout(authWaitTimer);
      authWaitTimer = setTimeout(() => {
        if (!pendingIntent || accessToken().length >= 32) return;
        pendingIntent = "";
        if (actionButton) {
          actionButton.disabled = false;
          actionButton.textContent = "V15 RANGE 운용 재개";
        }
        showLocal("대시보드 운영 인증을 찾지 못했습니다. 페이지를 새로고침한 뒤 버튼을 다시 누르세요.", "인증 연결 실패");
      }, 6000);
      return;
    }

    pendingIntent = "";
    clearTimeout(authWaitTimer);
    busy = true;
    const button = $("v15-range-control-action");
    if (button) {
      button.disabled = true;
      button.textContent = action === "enable" ? "운용 재개 중…" : "중지 중…";
    }
    try {
      const data = await callControl(action, true);
      busy = false;
      render(data?.state || data);
    } catch (error) {
      busy = false;
      const message = error instanceof Error ? error.message : String(error);
      if (message === "UNAUTHORIZED") {
        pendingIntent = action;
        showLocal("운영 인증 재연결 중…", "인증 재연결");
        requestDashboardToken();
        return;
      }
      showLocal(message, "변경 실패");
      await load(true);
    }
  }

  function toggleLive() {
    if (busy) return;
    const live = latestData?.runtime?.liveEnabled === true || $("v15-range-control-action")?.dataset.live === "true";
    executeIntent(live ? "disable" : "enable");
  }

  function captureDashboardToken(input, init) {
    try {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (!url.includes(`/${config.autotraderFunctionName || "market-autotrader"}`)) return;
      const headers = new Headers(init?.headers || (typeof input !== "string" ? input?.headers : undefined));
      const token = String(headers.get("x-autotrade-token") || "").trim();
      if (!rememberToken(token)) return;
      if (pendingIntent) {
        const action = pendingIntent;
        queueMicrotask(() => executeIntent(action));
      } else {
        queueMicrotask(() => load(false));
      }
    } catch (_) {}
  }

  window.fetch = async (input, init) => {
    captureDashboardToken(input, init);
    return originalFetch(input, init);
  };

  window.addEventListener("trading-dashboard-auth", event => {
    const token = String(event?.detail?.token || "").trim();
    if (!rememberToken(token)) return;
    if (pendingIntent) {
      const action = pendingIntent;
      queueMicrotask(() => executeIntent(action));
    } else {
      queueMicrotask(() => load(true));
    }
  });

  function captureLoginInput() {
    if (!rememberToken(tokenFromInput())) return;
    queueMicrotask(() => load(true));
  }

  function boot() {
    ensureCard();
    $("unlock-trader")?.addEventListener("click", captureLoginInput, true);
    $("trader-token")?.addEventListener("keydown", event => {
      if (event.key === "Enter") captureLoginInput();
    }, true);

    rememberToken(bridgedToken());
    rememberToken(tokenFromInput());
    if (accessToken().length >= 32) load(true);
    else {
      showLocal("기존 대시보드 운영 인증을 연결하는 중입니다.", "운용 재개 대기");
      setTimeout(() => requestDashboardToken(), 250);
    }

    clearInterval(timer);
    timer = setInterval(() => {
      if (accessToken().length >= 32 && !busy) load(false);
      else requestDashboardToken();
    }, 15_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  window.addEventListener("pageshow", () => setTimeout(boot, 0));
})();