(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  let dashboardToken = "";
  let pending = false;
  let timer = null;
  let manualOpenPositions = [];
  let latestEntryStatus = null;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const dt = (value) => value ? new Date(value).toLocaleString("ko-KR") : "—";
  const finite = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const fmt = (value, digits = 6) => {
    const number = finite(value);
    return number === null ? "—" : number.toLocaleString("ko-KR", { maximumFractionDigits: digits });
  };
  const signed = (value, digits = 4) => {
    const number = finite(value);
    return number === null ? "—" : `${number >= 0 ? "+" : ""}${fmt(number, digits)}`;
  };
  const money = (value, currency) => `${signed(value, currency === "KRW" ? 0 : 4)} ${currency}`;
  const percent = (value) => {
    const number = finite(value);
    return number === null ? "—" : `${number >= 0 ? "+" : ""}${fmt(number, 2)}%`;
  };
  const price = (value, currency) => {
    const number = finite(value);
    if (number === null) return "—";
    const digits = currency === "KRW"
      ? number >= 1000 ? 0 : number >= 1 ? 3 : 8
      : number >= 1000 ? 2 : number >= 1 ? 4 : number >= 0.01 ? 6 : 8;
    return `${number.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${currency === "KRW" ? "원" : " USDT"}`;
  };
  const age = (value) => {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    const remain = minutes % 60;
    return `${hours}시간 ${remain}분`;
  };

  function manualPositionCardRow(row) {
    const exchange = String(row?.exchange || "").toLowerCase();
    const quantity = Math.max(0, finite(row?.remaining_quantity) ?? finite(row?.initial_quantity) ?? 0);
    const entryPrice = finite(row?.average_entry_price) ?? finite(row?.planned_entry_price);
    const manualImport = row?.metadata?.manual_import || {};
    const currentPrice = finite(manualImport.mark_price) ?? finite(row?.current_price);
    const observedValue = finite(manualImport.value_quote);
    const marketValueQuote = observedValue ?? (
      quantity > 0 && currentPrice !== null ? quantity * currentPrice : null
    );
    const costQuote = quantity > 0 && entryPrice !== null ? quantity * entryPrice : null;
    const estimatedExitFee = marketValueQuote === null
      ? null
      : marketValueQuote * (exchange === "upbit" ? 0.0005 : 0.001);
    const estimatedPnl = marketValueQuote !== null && costQuote !== null
      ? marketValueQuote - costQuote - (estimatedExitFee || 0)
      : null;
    return {
      id: row?.id,
      exchange,
      quote_currency: row?.quote_currency || (exchange === "upbit" ? "KRW" : "USDT"),
      market: row?.market,
      state: "MANUAL",
      is_paper: false,
      is_manual: true,
      opened_at: row?.created_at || manualImport.balance_snapshot_at || null,
      quantity,
      entry_price: entryPrice,
      current_price: currentPrice,
      cost_quote: costQuote,
      market_value_quote: marketValueQuote,
      estimated_pnl_quote: estimatedPnl,
      estimated_return_pct: estimatedPnl !== null && costQuote > 0
        ? estimatedPnl / costQuote * 100
        : null,
      estimated_exit_fee_quote: estimatedExitFee,
      target_1: null,
      stop_price: null,
      price_captured_at: manualImport.balance_snapshot_at || row?.updated_at || null,
      cost_basis_source: manualImport.cost_basis_source || null,
    };
  }

  function captureManualPositions(status) {
    manualOpenPositions = (Array.isArray(status?.positions) ? status.positions : [])
      .filter((row) => row?.is_manual === true)
      .map(manualPositionCardRow)
      .filter((row) => row.quantity > 0);
    if (latestEntryStatus) renderPositions(latestEntryStatus);
  }

  function mergePositionRows(automaticRows, manualRows = manualOpenPositions) {
    const manualIds = new Set(manualRows.map((row) => String(row.id || "")));
    return [
      ...automaticRows.filter((row) => !manualIds.has(String(row.id || ""))),
      ...manualRows,
    ].sort((left, right) =>
      (Date.parse(right.opened_at || "") || 0) - (Date.parse(left.opened_at || "") || 0)
    );
  }

  function shouldDisplayPosition(row) {
    const value = finite(row?.market_value_quote);
    // Automatic positions remain visible during a temporary quote outage. A manual row,
    // however, exists only for display and must have a priced value to clear the floor.
    if (value === null) return row?.is_manual !== true;
    const floor = String(row?.exchange || "").toLowerCase() === "upbit" ? 1400 : 1;
    return value >= floor;
  }

  function ensureStyles() {
    if (document.getElementById("entry-status-style")) return;
    const link = document.createElement("link");
    link.id = "entry-status-style";
    link.rel = "stylesheet";
    link.href = "./entry-status.css?v=2-POSITION-PNL-REASONS";
    document.head.appendChild(link);
  }

  function ensurePositionCard() {
    ensureStyles();
    const performance = $("realized-performance-section") || $("trade-performance-section");
    const positions = $("positions-body")?.closest(".section-block");
    let section = $("current-position-estimate-section");
    if (!section) {
      section = document.createElement("section");
      section.id = "current-position-estimate-section";
      section.className = "section-block";
      section.innerHTML = `
        <div class="section-heading performance-heading">
          <div><p class="eyebrow">LIVE OPEN POSITION</p><h2>현재 보유 포지션</h2></div>
          <p><span id="current-position-count">확인 중</span> · <span id="current-position-updated">현재가 확인 중</span></p>
        </div>
        <div id="current-position-list" class="entry-position-list">
          <article class="panel entry-position-empty">보유 포지션과 현재가를 확인하고 있습니다.</article>
        </div>`;
    }
    if (performance) performance.before(section);
    else if (positions && !section.isConnected) positions.after(section);
    return section;
  }

  function ensureCard() {
    ensurePositionCard();
    if ($("entry-diagnostic-card")) return;
    const positions = $("positions-body")?.closest(".section-block");
    const performance = $("realized-performance-section") || $("trade-performance-section");
    const anchor = performance || positions;
    if (!anchor) return;

    const section = document.createElement("section");
    section.id = "entry-diagnostic-card";
    section.className = "section-block";
    section.innerHTML = `
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">AUTO TRADER STATUS</p><h2>왜 지금 거래를 안 하나</h2></div>
        <p>최근 스캔 상태와 실제 진입 판정 로그를 분리해 표시합니다. 판정 로그가 없어도 스캔·모니터 시각이 최신이면 엔진은 정상 동작 중입니다.</p>
      </div>
      <article class="panel entry-status-panel">
        <div class="entry-status-head">
          <div>
            <div id="entry-live-state" class="state-running entry-status-state">확인 중</div>
            <div id="entry-live-message" class="muted entry-status-message">최근 스캔을 확인하고 있습니다.</div>
          </div>
          <button id="entry-status-refresh" class="button-secondary" type="button">상태 새로고침</button>
        </div>
        <div class="performance-detail-grid entry-status-grid">
          <div><span>마지막 스캔</span><b id="entry-last-scan">—</b></div>
          <div><span>마지막 모니터</span><b id="entry-last-monitor">—</b></div>
          <div><span>최근 스캔 진입 판정</span><b id="entry-scan-count">—</b></div>
          <div><span>최근 30분 실제 진입 판정</span><b id="entry-recent-count">—</b></div>
          <div><span>마지막 주문</span><b id="entry-last-order">—</b></div>
          <div><span>게이트웨이</span><b id="entry-gateway">—</b></div>
        </div>
        <div class="entry-status-block">
          <strong>최근 30분 실제 진입 탈락 사유</strong>
          <div id="entry-reasons" class="entry-reason-list muted">확인 중</div>
        </div>
        <div class="entry-status-block">
          <strong>최근 실제 진입 판정</strong>
          <div id="entry-latest-decision" class="entry-latest-decision">—</div>
        </div>
      </article>`;
    anchor.insertAdjacentElement("afterend", section);
    $("entry-status-refresh")?.addEventListener("click", () => load());
  }

  function renderPositions(data) {
    ensurePositionCard();
    const list = $("current-position-list");
    const automaticRows = Array.isArray(data.open_positions) ? data.open_positions : [];
    const rows = mergePositionRows(automaticRows).filter(shouldDisplayPosition);
    if (!list) return;

    $("current-position-count").textContent = rows.length ? `${rows.length}개 보유 중` : "보유 포지션 없음";
    const freshest = rows.map((row) => Date.parse(row.price_captured_at || "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
    $("current-position-updated").textContent = freshest ? `현재가 ${dt(new Date(freshest).toISOString())}` : "현재가 없음";

    if (!rows.length) {
      list.innerHTML = `<article class="panel entry-position-empty">현재 보유 중인 봇 포지션이 없습니다.</article>`;
      return;
    }

    list.innerHTML = rows.map((row) => {
      const currency = String(row.quote_currency || (String(row.exchange).toLowerCase() === "upbit" ? "KRW" : "USDT"));
      const pnl = finite(row.estimated_pnl_quote);
      const pnlClass = pnl === null ? "" : pnl >= 0 ? "realized-positive" : "realized-negative";
      const mode = row.is_manual ? "MANUAL" : row.is_paper ? "PAPER" : "LIVE";
      const state = row.is_manual ? "수동매수" : row.state || "OPEN";
      const note = row.is_manual
        ? "거래소 실시간 잔고에서 자동매매 포지션과 잔여재고를 제외한 수동 보유분입니다. 자동매도·성과·학습 대상에서 제외됩니다."
        : "평가손익은 최신 계좌 스냅샷의 현재가 기준 미확정 추정치입니다. 이미 발생한 수수료와 예상 매도 수수료를 반영하며, 슬리피지는 제외합니다.";
      return `
        <article class="panel entry-position-card">
          <div class="entry-position-head">
            <div class="entry-position-market">
              <strong>${esc(row.market || "—")}</strong>
              <span class="entry-position-badge">${esc(String(row.exchange || "").toUpperCase())}</span>
              <span class="entry-position-badge">${mode}</span>
              <span class="entry-position-badge">${esc(state)}</span>
            </div>
            <div class="entry-position-pnl ${pnlClass}">
              <strong>${money(row.estimated_pnl_quote, currency)}</strong>
              <small>${percent(row.estimated_return_pct)} · 보유 ${age(row.opened_at)}</small>
            </div>
          </div>
          <div class="entry-position-grid">
            <div><span>현재가</span><b>${price(row.current_price, currency)}</b></div>
            <div><span>평균 진입가</span><b>${price(row.entry_price, currency)}</b></div>
            <div><span>수량</span><b>${fmt(row.quantity, 8)}</b></div>
            <div><span>현재 평가액</span><b>${money(row.market_value_quote, currency).replace(/^\+/, "")}</b></div>
            <div><span>목표가</span><b>${price(row.target_1, currency)}</b></div>
            <div><span>손절가</span><b>${price(row.stop_price, currency)}</b></div>
          </div>
          <p class="entry-position-note">${note}</p>
        </article>`;
    }).join("");
  }

  function outcomeLabel(value) {
    const outcome = String(value || "").toUpperCase();
    if (["ENTERED", "BUY", "ORDERED", "ACCEPTED"].includes(outcome)) return "진입 완료";
    if (outcome === "REJECTED") return "진입 탈락";
    if (outcome === "BLOCKED") return "진입 차단";
    if (outcome === "SKIPPED") return "진입 건너뜀";
    return outcome || "판정 없음";
  }

  function render(data) {
    ensureCard();
    latestEntryStatus = data;
    renderPositions(data);
    const state = $("entry-live-state");
    if (!state) return;
    const blocked = data.state === "BLOCKED";
    state.textContent = blocked ? "🔴 거래 중단" : data.state === "ENTRY_FOUND" ? "🟢 진입 신호 발생" : "🟢 정상 가동 · 진입 대기";
    state.className = `${blocked ? "state-paused" : "state-running"} entry-status-state`;
    $("entry-live-message").textContent = data.message || "—";
    $("entry-last-scan").textContent = dt(data.last_scan_at);
    $("entry-last-monitor").textContent = dt(data.last_monitor_at);
    $("entry-scan-count").textContent = `${Number(data.decisions_since_scan || 0)}건 · 승인 ${Number(data.accepted_since_scan || 0)} / 탈락 ${Number(data.rejected_since_scan || 0)}`;
    $("entry-recent-count").textContent = `${Number(data.recent_30m_decisions || 0)}건 · 탈락 ${Number(data.recent_30m_rejections || 0)}건`;
    $("entry-gateway").textContent = Number(data.gateway_error_count || 0) === 0
      ? `정상 · ${dt(data.last_gateway_heartbeat_at)}`
      : `오류 ${Number(data.gateway_error_count)}건`;
    const order = data.last_order;
    $("entry-last-order").textContent = order
      ? `${dt(order.requested_at)} · ${order.market || ""} ${order.side || ""} · ${order.state || ""}`
      : "주문 없음";
    const reasons = Array.isArray(data.top_rejection_reasons_30m) ? data.top_rejection_reasons_30m : [];
    $("entry-reasons").innerHTML = reasons.length
      ? reasons.map((row) => `<div class="entry-reason-row"><span>${esc(row.reason)}${row.detail ? `<small>${esc(row.detail)}</small>` : ""}</span><strong>${Number(row.count)}건</strong></div>`).join("")
      : `<div class="entry-reason-row"><span>최근 30분 실제 진입 판정 없음</span><strong>0건</strong></div>`;
    const latest = data.latest_decision;
    if (latest) {
      const latestReason = latest.reason_label || latest.reason;
      const reasonText = latestReason ? ` · ${latestReason}` : "";
      $("entry-latest-decision").textContent = `${dt(latest.created_at)} · ${latest.exchange?.toUpperCase?.() || ""} ${latest.market || ""} · ${outcomeLabel(latest.outcome)}${reasonText}`;
    } else {
      $("entry-latest-decision").textContent = "최근 실제 진입 판정 없음";
    }
  }

  async function load() {
    if (!dashboardToken || pending) return;
    pending = true;
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${config.entryStatusFunctionName || "trading-entry-status"}`;
      const response = await originalFetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-autotrade-token": dashboardToken,
          ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
        },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      render(data);
    } catch (error) {
      ensureCard();
      if ($("entry-live-state")) {
        $("entry-live-state").textContent = "상태 조회 실패";
        $("entry-live-state").className = "state-paused entry-status-state";
      }
      if ($("entry-live-message")) $("entry-live-message").textContent = error?.message || String(error);
    } finally {
      pending = false;
    }
  }

  window.fetch = async (input, init = {}) => {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (url.includes(`/${config.autotraderFunctionName || "market-autotrader"}`)) {
        const headers = new Headers(init?.headers || (typeof input !== "string" ? input?.headers : undefined));
        const captured = headers.get("x-autotrade-token");
        if (captured && captured.length >= 32) dashboardToken = captured;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body?.action === "status" && response.ok) {
          response.clone().json().then(captureManualPositions).catch(() => {});
          queueMicrotask(load);
        }
      }
    } catch (_) {}
    return response;
  };

  const start = () => {
    ensureStyles();
    ensureCard();
    clearInterval(timer);
    timer = setInterval(load, 15000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();