(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  const $ = id => document.getElementById(id);
  let dashboardToken = "";
  let runtimeSource = null;
  let performanceSource = null;
  let accountSource = null;
  let pending = false;
  let lastLoaded = 0;
  let timer = null;
  let exchangeFilter = "binance";

  const esc = v => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const fmt = (v, d = 6) => Number.isFinite(Number(v)) && v !== null
    ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d }) : "—";
  const signed = (v, d = 4) => `${num(v) >= 0 ? "+" : ""}${fmt(v, d)}`;
  const money = (v, currency = "USDT") => Number.isFinite(Number(v)) && v !== null
    ? `${signed(v, currency === "KRW" ? 0 : 4)} ${currency}` : "—";
  const pct = v => Number.isFinite(Number(v)) && v !== null
    ? `${Number(v) >= 0 ? "+" : ""}${fmt(v, 2)}%` : "—";
  const dt = v => v ? new Date(v).toLocaleString("ko-KR", { hour12: false }) : "—";
  const ageSec = v => {
    const t = Date.parse(v || "");
    return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : Infinity;
  };
  const tone = v => num(v) >= 0 ? "realized-positive" : "realized-negative";

  function hold(seconds) {
    if (!Number.isFinite(Number(seconds))) return "—";
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m}분 ${r}초`;
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return `${h}시간 ${rm}분`;
    return `${Math.floor(h / 24)}일 ${h % 24}시간`;
  }

  function inject() {
    const positions = $("positions-body")?.closest(".section-block");
    if (!positions) return false;

    if (!$("runtime-health-section")) {
      const runtime = document.createElement("section");
      runtime.id = "runtime-health-section";
      runtime.className = "section-block";
      runtime.innerHTML = `
        <div class="section-heading performance-heading">
          <div><p class="eyebrow">LIVE ENGINE STATUS</p><h2>자동매매 동작 상태</h2></div>
          <p id="runtime-health-note">실시간 상태 확인 중</p>
        </div>
        <article class="panel"><div id="runtime-health-grid" class="runtime-health-grid"><div><span>상태</span><b>확인 중</b></div></div></article>`;
      positions.before(runtime);
    }

    if (!$("realized-performance-section")) {
      const section = document.createElement("section");
      section.id = "realized-performance-section";
      section.className = "section-block";
      section.innerHTML = `
        <div class="section-heading performance-heading realized-heading">
          <div>
            <p class="eyebrow">IMMUTABLE REALIZED LEDGER</p>
            <h2>거래별 성과</h2>
            <div class="realized-source-badges">
              <span class="realized-ledger-badge">체결 확정값</span>
              <span id="realized-revision-badge" class="realized-revision-badge">revision 확인 중</span>
            </div>
          </div>
          <p>계정 수익률은 Binance Equity 기준, 전략 ROI는 실제 거래 투입 증거금 기준으로 분리 표시합니다.</p>
        </div>
        <div class="performance-filters realized-filters">
          <select id="realized-exchange-filter" aria-label="거래소 필터">
            <option value="binance">BINANCE · 현물+선물</option>
            <option value="upbit">UPBIT</option>
            <option value="all">전체</option>
          </select>
          <button id="realized-refresh-now" class="button-primary performance-action-button" type="button">새로고침</button>
          <span id="realized-refresh-status" class="performance-refresh-status">체결 장부를 불러오는 중입니다.</span>
        </div>
        <div id="realized-summary-grid" class="realized-summary-grid"><div><span>총 확정손익</span><b>—</b></div></div>
        <div class="table-wrap panel realized-table-wrap">
          <table class="performance-table realized-trade-table">
            <thead><tr>
              <th>청산 시각</th><th>종목</th><th>매도</th><th>원가</th><th>확정손익</th><th>전략 ROI</th><th>매도 평균가</th><th>수량</th><th>수수료</th><th>보유시간</th><th>종료 사유</th>
            </tr></thead>
            <tbody id="realized-performance-body"><tr><td colspan="11" class="muted">체결 데이터를 불러오는 중입니다.</td></tr></tbody>
          </table>
        </div>
        <p id="realized-performance-source" class="performance-definition">계정 수익률과 전략 ROI는 서로 다른 분모를 사용합니다.</p>`;
      positions.after(section);
      $("realized-exchange-filter")?.addEventListener("change", event => {
        exchangeFilter = String(event.target?.value || "binance");
        renderPerformance();
      });
      $("realized-refresh-now")?.addEventListener("click", () => load(true));
    }
    return true;
  }

  function runtimeObject() {
    const raw = runtimeSource || {};
    return raw.runtime || raw.status?.runtime || raw.trading_runtime || raw;
  }

  function renderRuntime() {
    const r = runtimeObject();
    const mode = String(r.mode || r.trading_mode || "");
    const pause = Boolean(r.pause_new_entries ?? r.settings?.pause_new_entries);
    const emergency = Boolean(r.emergency_liquidation ?? r.settings?.emergency_liquidation);
    const withdrawal = Boolean(r.withdrawal_mode ?? r.settings?.withdrawal_mode);
    const manual = Boolean(r.manual_intervention_required ?? r.settings?.manual_intervention_required);
    const allowed = !pause && !emergency && !withdrawal && !manual;
    const scanAt = r.last_full_scan_at || r.last_scan_at || null;
    const monitorAt = r.last_monitor_at || r.last_monitor_cycle_at || null;
    const gatewayAt = r.last_gateway_heartbeat_at || r.gateway_heartbeat_at || null;
    const fresh = ageSec(scanAt) < 90 && ageSec(monitorAt) < 60 && ageSec(gatewayAt) < 60;
    const running = mode === "LIVE_LIMITED" && allowed && fresh;
    const stateClass = running ? "runtime-ok" : allowed ? "runtime-warn" : "runtime-bad";
    const state = running ? "운영 중" : pause ? "신규 진입 일시정지" : !allowed ? "거래 차단" : "상태 지연 확인";
    const grid = $("runtime-health-grid");
    if (grid) grid.innerHTML = `
      <div><span>자동매매</span><b class="${stateClass}">${state}</b></div>
      <div><span>운영 모드</span><b>${esc(mode || "—")}</b></div>
      <div><span>신규 진입</span><b class="${allowed ? "runtime-ok" : "runtime-bad"}">${allowed ? "허용" : "차단"}</b></div>
      <div><span>활성 포지션</span><b>${fmt(r.active_positions ?? r.open_positions ?? 0, 0)}개</b></div>
      <div><span>최근 전체 스캔</span><b>${dt(scanAt)}</b></div>
      <div><span>최근 포지션 모니터</span><b>${dt(monitorAt)}</b></div>
      <div><span>Gateway heartbeat</span><b>${dt(gatewayAt)}</b></div>
      <div><span>Gateway 오류</span><b>${fmt(r.gateway_error_count ?? 0, 0)}건</b></div>`;
    const note = $("runtime-health-note");
    if (note) note.textContent = pause
      ? "신규 진입은 현재 pause 상태입니다. 기존 포지션 관리 상태와는 별개입니다."
      : running ? "엔진 heartbeat와 모니터 사이클이 정상입니다." : "최근 동작 시각과 안전 설정을 확인하세요.";
  }

  function realizedRows() {
    const trades = Array.isArray(performanceSource?.trades) ? performanceSource.trades : [];
    return trades
      .filter(row => String(row?.row_type || "") === "REALIZED_EXIT")
      .filter(row => exchangeFilter === "all" || (exchangeFilter === "binance" ? ["binance","binance_futures"].includes(String(row?.exchange || "")) : String(row?.exchange || "") === exchangeFilter))
      .sort((a, b) => Date.parse(b.exit_at || 0) - Date.parse(a.exit_at || 0));
  }

  function addFallbackExitIndexes(rows) {
    const byPosition = new Map();
    for (const row of [...rows].sort((a, b) => Date.parse(a.exit_at || 0) - Date.parse(b.exit_at || 0))) {
      const key = String(row.position_id || row.id || "");
      const bucket = byPosition.get(key) || []; bucket.push(row); byPosition.set(key, bucket);
    }
    for (const bucket of byPosition.values()) {
      bucket.forEach((row, index) => {
        if (!Number(row.position_exit_count)) row.position_exit_count = bucket.length;
        if (!Number(row.position_exit_index)) row.position_exit_index = index + 1;
      });
    }
    return rows;
  }

  function aggregatePositionStats(rows) {
    const positions = new Map();
    for (const row of rows) {
      if (!row.position_closed) continue;
      const key = String(row.position_id || row.id);
      const current = positions.get(key) || { pnl: 0, cost: 0 };
      current.pnl += num(row.net_pnl_quote);
      current.cost += Math.max(0, num(row.invested_cost_quote));
      positions.set(key, current);
    }
    const values = [...positions.values()];
    const wins = values.filter(v => v.pnl > 0), losses = values.filter(v => v.pnl < 0);
    const grossWin = wins.reduce((s, v) => s + v.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, v) => s + v.pnl, 0));
    return {
      count: values.length,
      wins: wins.length,
      winRate: values.length ? wins.length / values.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    };
  }

  function renderPerformance() {
    if (!inject()) return;
    const rows = addFallbackExitIndexes(realizedRows());
    const body = $("realized-performance-body");
    if (body) body.innerHTML = rows.length ? rows.slice(0, 100).map(row => {
      const currency = String(row.quote_currency || (row.exchange === "upbit" ? "KRW" : "USDT"));
      const split = Number(row.position_exit_count) > 1
        ? `<span class="realized-split-badge">${fmt(row.position_exit_index, 0)}/${fmt(row.position_exit_count, 0)}</span>`
        : `<span class="realized-single-badge">단일</span>`;
      const locked = row.immutable || row.position_closed
        ? `<span class="realized-locked" title="CLOSED 확정값">고정</span>` : "";
      return `<tr>
        <td data-label="청산">${dt(row.exit_at)}</td>
        <td data-label="종목"><strong>${esc(row.market)}</strong><small class="realized-fill-count">${row.exchange === "binance_futures" ? "FUTURES" : row.exchange === "binance" ? "SPOT" : "UPBIT"}</small>${locked}</td>
        <td data-label="매도">${split}<small class="realized-fill-count">fill ${fmt(row.fill_count || 1,0)}</small></td>
        <td data-label="원가">${fmt(row.invested_cost_quote, currency === "KRW" ? 0 : 4)} ${currency}</td>
        <td data-label="확정손익" class="${tone(row.net_pnl_quote)}"><strong>${money(row.net_pnl_quote, currency)}</strong></td>
        <td data-label="전략 ROI" class="${tone(row.return_pct)}"><strong>${pct(row.return_pct)}</strong></td>
        <td data-label="매도 평균가">${fmt(row.average_exit_price, 8)}</td>
        <td data-label="수량">${fmt(row.quantity, 8)}</td>
        <td data-label="수수료">${fmt(row.total_fees_quote, currency === "KRW" ? 0 : 5)} ${currency}</td>
        <td data-label="보유시간">${hold(row.duration_seconds)}</td>
        <td data-label="종료 사유"><span class="realized-reason">${esc(row.close_reason || "SELL")}</span></td>
      </tr>`;
    }).join("") : `<tr><td colspan="11" class="muted">확정된 매도 거래가 없습니다.</td></tr>`;

    const exchangeSummary = exchangeFilter === "all" ? null : performanceSource?.exchanges?.[exchangeFilter];
    const total = exchangeSummary ? num(exchangeSummary.realized_net_pnl_quote) : rows.reduce((s, r) => s + num(r.net_pnl_quote), 0);
    const currency = exchangeFilter === "upbit" ? "KRW" : exchangeFilter === "binance" ? "USDT" : "MIXED";
    const stats = aggregatePositionStats(rows);
    const splitCount = rows.filter(row => Number(row.position_exit_count) > 1).length;
    const accountCombined = accountSource?.venues?.binance || null;
    const accountFutures = accountSource?.venues?.binance_futures || null;
    const summary = $("realized-summary-grid");
    if (summary) {
      if (exchangeFilter === "binance") {
        summary.innerHTML = `
          <div><span>선물 계정 수익률 · 오늘</span><b class="${tone(accountFutures?.account_return_pct)}">${pct(accountFutures?.account_return_pct)}</b></div>
          <div><span>전체 Equity 변동률 · 오늘</span><b class="${tone(accountCombined?.account_return_pct)}">${pct(accountCombined?.account_return_pct)}</b></div>
          <div><span>전략 ROI · 누적</span><b class="${tone(exchangeSummary?.cumulative_return_pct)}">${pct(exchangeSummary?.cumulative_return_pct)}</b></div>
          <div><span>실현 순손익</span><b class="${tone(exchangeSummary?.realized_net_pnl_quote)}">${money(exchangeSummary?.realized_net_pnl_quote,"USDT")}</b></div>
          <div><span>미실현 손익</span><b class="${tone(exchangeSummary?.open_net_pnl_quote)}">${money(exchangeSummary?.open_net_pnl_quote,"USDT")}</b></div>
          <div><span>현재 Binance Equity</span><b>${fmt(accountCombined?.current_equity_quote,4)} USDT</b></div>
          <div><span>완료 포지션</span><b>${fmt(exchangeSummary?.closed_trade_count ?? stats.count,0)}건</b></div>
          <div><span>승률</span><b>${fmt(exchangeSummary?.win_rate_pct ?? stats.winRate,1)}%</b></div>`;
      } else {
        summary.innerHTML = `
          <div><span>총 확정손익</span><b class="${tone(total)}">${currency === "MIXED" ? `${signed(total,4)} (혼합)` : money(total,currency)}</b></div>
          <div><span>전략 ROI · 누적</span><b>${pct(exchangeSummary?.cumulative_return_pct)}</b></div>
          <div><span>완료 포지션</span><b>${fmt(exchangeSummary?.closed_trade_count ?? stats.count,0)}건</b></div>
          <div><span>매도 기록</span><b>${fmt(exchangeSummary?.realized_exit_count ?? rows.length,0)}건</b></div>
          <div><span>분할매도 행</span><b>${fmt(splitCount,0)}건</b></div>
          <div><span>승률</span><b>${fmt(exchangeSummary?.win_rate_pct ?? stats.winRate,1)}%</b></div>
          <div><span>Profit Factor</span><b>${(exchangeSummary?.profit_factor ?? stats.profitFactor) === null || (exchangeSummary?.profit_factor ?? stats.profitFactor) === Infinity ? "∞" : fmt(exchangeSummary?.profit_factor ?? stats.profitFactor,2)}</b></div>`;
      }
    }

    const revision = String(performanceSource?.performance_revision || "—");
    if ($("realized-revision-badge")) $("realized-revision-badge").textContent = revision;
    const src = $("realized-performance-source");
    if (src) src.textContent = exchangeFilter === "binance"
      ? `선물 계정 수익률: Binance Futures Equity 기준 · 전체 Equity 변동률: 현물+선물 합산이며 자금이동 포함 · 전략 ROI: 거래 투입 증거금 기준 · ${revision} · ${dt(performanceSource?.generated_at)}`
      : `체결 확정 장부 · 전략 ROI: 실제 거래원가 기준 · ${revision} · ${dt(performanceSource?.generated_at)}`;
  }

  function render() { if (!inject()) return; renderRuntime(); renderPerformance(); }

  async function postFunction(name, body = {}) {
    const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${name}`;
    const response = await originalFetch(endpoint, {
      method: "POST", cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-autotrade-token": dashboardToken,
        ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function load(force = false) {
    if (!dashboardToken || pending || (!force && document.hidden)) return;
    if (!force && Date.now() - lastLoaded < 12_000) return;
    pending = true;
    const status = $("realized-refresh-status");
    if (status) status.textContent = "계정 Equity와 확정 체결 장부를 갱신하는 중입니다.";
    try {
      const [runtimeResult, perfResult, accountResult] = await Promise.allSettled([
        postFunction(config.binanceSourceFunctionName || "binance-source", { limit: 200 }),
        postFunction(config.performanceFunctionName || "market-performance", force ? { force: true } : {}),
        postFunction(config.accountPerformanceFunctionName || "account-performance", {}),
      ]);
      if (runtimeResult.status === "fulfilled") runtimeSource = runtimeResult.value;
      if (perfResult.status === "rejected") throw perfResult.reason;
      performanceSource = perfResult.value;
      accountSource = accountResult.status === "fulfilled" ? accountResult.value : null;
      lastLoaded = Date.now();
      render();
      const accountNote = accountSource?.venues?.binance_futures?.valid ? " · Binance Equity 연결" : " · 계정 Equity 조회 확인 필요";
      if (status) status.textContent = `체결 확정값 · ${dt(performanceSource?.generated_at)} · ${performanceSource?.cache_status || "LIVE"}${accountNote}`;
    } catch (e) {
      inject();
      if (status) status.textContent = `거래별 성과 조회 실패: ${e?.message || e}`;
    } finally { pending = false; }
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
          response.clone().json().then(data => { runtimeSource = data; renderRuntime(); }).catch(() => {});
          queueMicrotask(() => load(true));
        }
      }
    } catch (_) {}
    return response;
  };

  document.addEventListener("click", event => {
    if (event.target?.id !== "unlock-trader") return;
    const entered = String($("trader-token")?.value || "").trim();
    if (entered.length >= 32) dashboardToken = entered;
    setTimeout(() => load(true), 500);
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
  window.addEventListener("pageshow", () => setTimeout(() => load(true), 300));
  timer = setInterval(() => load(false), 15_000);
  inject();
})();
