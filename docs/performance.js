(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  let dashboardToken = "";
  let latestPerformance = null;
  let pending = false;
  let refreshQueued = false;
  let performanceExpanded = false;
  let performancePage = 1;

  const COLLAPSED_TRADE_LIMIT = 10;
  const EXPANDED_PAGE_SIZE = 50;

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const fmt = (value, digits = 2) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "—";
  const money = (value, quote) => quote === "KRW" ? `${fmt(value, 0)}원` : `${fmt(value, 4)} USDT`;
  const pct = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
  };
  const signedMoney = (value, quote) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number > 0 ? "+" : ""}${money(number, quote)}`;
  };
  const dateTime = value => value ? new Date(value).toLocaleString("ko-KR") : "—";
  const duration = seconds => {
    const total = Math.max(0, Math.round(finite(seconds)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours ? `${hours}시간 ${minutes}분` : minutes ? `${minutes}분 ${secs}초` : `${secs}초`;
  };
  const pnlClass = value => finite(value) > 0 ? "performance-positive" : finite(value) < 0 ? "performance-negative" : "";

  function injectDashboard() {
    if ($("exchange-performance-section")) return;
    const allocationSection = $("save-allocation")?.closest(".section-block");
    const positionsSection = $("positions-body")?.closest(".section-block");
    if (!allocationSection || !positionsSection) return;

    const summary = document.createElement("section");
    summary.id = "exchange-performance-section";
    summary.className = "section-block";
    summary.innerHTML = `
      <div class="section-heading">
        <div><p class="eyebrow">PERFORMANCE BY EXCHANGE</p><h2>거래소별 누적 성과</h2></div>
        <p>실제 체결된 LIVE 거래만 집계합니다. 취소·미체결·유령 포지션은 제외됩니다.</p>
      </div>
      <div id="exchange-performance-grid" class="performance-exchange-grid">
        <article class="panel performance-empty">성과 데이터를 불러오는 중입니다.</article>
      </div>`;
    allocationSection.insertAdjacentElement("afterend", summary);

    const trades = document.createElement("section");
    trades.id = "trade-performance-section";
    trades.className = "section-block";
    trades.innerHTML = `
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">TRADE PERFORMANCE</p><h2>거래별 성과</h2></div>
        <div class="performance-filters">
          <select id="performance-exchange-filter" aria-label="거래소 필터">
            <option value="all">전체 거래소</option><option value="upbit">업비트</option><option value="binance">바이낸스</option>
          </select>
          <select id="performance-state-filter" aria-label="상태 필터">
            <option value="all">전체 상태</option><option value="open">보유 중</option><option value="closed">종료</option>
          </select>
          <select id="performance-period-filter" aria-label="기간 필터">
            <option value="all">전체 기간</option><option value="today">오늘</option><option value="7">최근 7일</option><option value="30">최근 30일</option>
          </select>
          <button id="performance-csv-download" class="button-secondary performance-action-button" type="button">CSV 다운로드</button>
          <button id="performance-expand-toggle" class="button-secondary performance-action-button" type="button">더 보기 · 50개</button>
        </div>
      </div>
      <div class="table-wrap panel performance-table-wrap">
        <table class="performance-table">
          <thead><tr>
            <th>거래소</th><th>종목</th><th>상태</th><th>진입 시각</th><th>청산 시각</th><th>거래시간</th>
            <th>투자금</th><th>진입가</th><th>현재가·청산가</th><th>수수료</th><th>순손익</th><th>순수익률</th><th>청산 사유</th>
          </tr></thead>
          <tbody id="trade-performance-body"><tr><td colspan="13" class="muted">성과 데이터를 불러오는 중입니다.</td></tr></tbody>
        </table>
      </div>
      <div class="performance-list-footer">
        <span id="performance-row-summary" class="performance-row-summary" aria-live="polite"></span>
        <nav id="performance-pagination" class="performance-pagination hidden" aria-label="거래별 성과 페이지">
          <button id="performance-page-prev" class="button-secondary performance-page-button" type="button">이전</button>
          <span id="performance-page-info"></span>
          <button id="performance-page-next" class="button-secondary performance-page-button" type="button">다음</button>
        </nav>
      </div>
      <p id="performance-definition" class="performance-definition"></p>`;
    positionsSection.insertAdjacentElement("afterend", trades);

    ["performance-exchange-filter", "performance-state-filter", "performance-period-filter"]
      .forEach(id => $(id)?.addEventListener("change", () => {
        performancePage = 1;
        renderTrades();
      }));
    $("performance-csv-download")?.addEventListener("click", downloadTradesCsv);
    $("performance-expand-toggle")?.addEventListener("click", () => {
      performanceExpanded = !performanceExpanded;
      performancePage = 1;
      renderTrades();
    });
    $("performance-page-prev")?.addEventListener("click", () => {
      performancePage = Math.max(1, performancePage - 1);
      renderTrades();
      $("trade-performance-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("performance-page-next")?.addEventListener("click", () => {
      performancePage += 1;
      renderTrades();
      $("trade-performance-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function renderExchange(exchange, row) {
    const quote = row?.quote_currency || (exchange === "upbit" ? "KRW" : "USDT");
    const pf = row?.profit_factor == null
      ? (finite(row?.win_count) > 0 && finite(row?.loss_count) === 0 ? "∞" : "—")
      : fmt(row.profit_factor, 2);
    return `
      <article class="panel performance-exchange-card">
        <div class="performance-card-head"><div><span>${exchange === "upbit" ? "UPBIT" : "BINANCE"}</span><h3>${exchange === "upbit" ? "KRW 현물" : "USDT 현물"}</h3></div><strong>${money(row?.current_equity_quote, quote)}</strong></div>
        <div class="performance-primary-grid">
          <div><span>누적 순손익</span><strong class="${pnlClass(row?.cumulative_net_pnl_quote)}">${signedMoney(row?.cumulative_net_pnl_quote, quote)}</strong></div>
          <div><span>누적 거래수익률</span><strong class="${pnlClass(row?.cumulative_return_pct)}">${pct(row?.cumulative_return_pct)}</strong></div>
          <div><span>현재 포지션 손익</span><strong class="${pnlClass(row?.open_net_pnl_quote)}">${signedMoney(row?.open_net_pnl_quote, quote)}</strong></div>
          <div><span>현재 포지션 수익률</span><strong class="${pnlClass(row?.current_open_return_pct)}">${pct(row?.current_open_return_pct)}</strong></div>
        </div>
        <div class="performance-detail-grid">
          <div><span>실현손익</span><b class="${pnlClass(row?.realized_net_pnl_quote)}">${signedMoney(row?.realized_net_pnl_quote, quote)}</b></div>
          <div><span>오늘 거래손익</span><b class="${pnlClass(row?.today_net_pnl_quote)}">${signedMoney(row?.today_net_pnl_quote, quote)}</b></div>
          <div><span>총 수수료</span><b>${money(row?.total_fees_quote, quote)}</b></div>
          <div><span>승률</span><b>${fmt(row?.win_rate_pct, 1)}%</b></div>
          <div><span>Profit Factor</span><b>${pf}</b></div>
          <div><span>거래 수</span><b>${fmt(row?.trade_count, 0)}건 · 보유 ${fmt(row?.open_trade_count, 0)}</b></div>
          <div><span>평균 거래수익률</span><b class="${pnlClass(row?.average_return_pct)}">${pct(row?.average_return_pct)}</b></div>
          <div><span>평균 보유시간</span><b>${row?.average_hold_seconds == null ? "—" : duration(row.average_hold_seconds)}</b></div>
          <div><span>계좌 로그성장/시간</span><b class="${pnlClass(row?.account_log_growth_per_hour)}">${fmt(finite(row?.account_log_growth_per_hour) * 100, 4)}%/h</b></div>
          <div><span>관리자본 활용률</span><b>${fmt(finite(row?.capital_utilization) * 100, 1)}%</b></div>
          <div><span>관리자본 회전율</span><b>${fmt(row?.account_capital_turns_per_hour, 4)}회/h</b></div>
          <div><span>수수료 검증 거래</span><b>${fmt(row?.fee_verified_trade_count, 0)}건</b></div>
        </div>
      </article>`;
  }

  function renderSummary() {
    if (!latestPerformance) return;
    const grid = $("exchange-performance-grid");
    if (!grid) return;
    grid.innerHTML = ["upbit", "binance"].map(exchange => renderExchange(exchange, latestPerformance.exchanges?.[exchange] || {})).join("");
  }

  function filteredTrades() {
    const rows = Array.isArray(latestPerformance?.trades) ? latestPerformance.trades : [];
    const exchange = $("performance-exchange-filter")?.value || "all";
    const state = $("performance-state-filter")?.value || "all";
    const period = $("performance-period-filter")?.value || "all";
    const now = Date.now();
    return rows.filter(row => {
      if (exchange !== "all" && row.exchange !== exchange) return false;
      if (state === "open" && !row.is_open) return false;
      if (state === "closed" && !row.is_closed) return false;
      if (period !== "all") {
        const reference = new Date(row.exit_at || row.entry_at || 0).getTime();
        if (!Number.isFinite(reference)) return false;
        if (period === "today") {
          const current = new Date();
          const target = new Date(reference);
          if (current.toLocaleDateString("ko-KR") !== target.toLocaleDateString("ko-KR")) return false;
        } else if (reference < now - Number(period) * 86400000) return false;
      }
      return true;
    });
  }

  function tradeStateLabel(row) {
    return row.is_closed ? "종료" : row.state === "EXITING" ? "청산 중" : "보유 중";
  }

  function csvCell(value) {
    if (value == null) return '""';
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function downloadTradesCsv() {
    const rows = filteredTrades();
    if (!rows.length) return;
    const headers = [
      "거래소",
      "종목",
      "상태",
      "진입 시각",
      "청산 시각",
      "거래시간(초)",
      "투자금",
      "통화",
      "진입가",
      "현재가·청산가",
      "수수료",
      "순손익",
      "순수익률(%)",
      "청산 사유",
      "수수료 품질",
      "잔량 회계 품질",
    ];
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map(row => {
        const mark = row.is_closed ? row.average_exit_price : row.current_price;
        return [
          row.exchange === "upbit" ? "UPBIT" : "BINANCE",
          row.market,
          tradeStateLabel(row),
          row.entry_at ? dateTime(row.entry_at) : "",
          row.exit_at ? dateTime(row.exit_at) : "",
          finite(row.duration_seconds),
          finite(row.invested_cost_quote),
          row.quote_currency,
          finite(row.average_entry_price),
          finite(mark),
          finite(row.total_fees_quote),
          finite(row.net_pnl_quote),
          finite(row.return_pct),
          row.close_reason || (row.is_closed ? "종료" : "보유 중"),
          row.fee_accounting_quality || "",
          row.accounting_quality || "",
        ].map(csvCell).join(",");
      }),
    ];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `trading-performance-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function renderTrades() {
    const body = $("trade-performance-body");
    if (!body || !latestPerformance) return;
    const rows = filteredTrades();
    const pageSize = performanceExpanded ? EXPANDED_PAGE_SIZE : COLLAPSED_TRADE_LIMIT;
    const totalPages = performanceExpanded
      ? Math.max(1, Math.ceil(rows.length / EXPANDED_PAGE_SIZE))
      : 1;
    performancePage = Math.max(1, Math.min(performancePage, totalPages));
    const start = performanceExpanded ? (performancePage - 1) * EXPANDED_PAGE_SIZE : 0;
    const visibleRows = rows.slice(start, start + pageSize);
    body.innerHTML = visibleRows.length ? visibleRows.map(row => {
      const quote = row.quote_currency;
      const mark = row.is_closed ? row.average_exit_price : row.current_price;
      const stateLabel = tradeStateLabel(row);
      return `<tr>
        <td>${row.exchange === "upbit" ? "UPBIT" : "BINANCE"}</td>
        <td><strong>${escapeHtml(row.market)}</strong></td>
        <td><span class="performance-state ${row.is_closed ? "closed" : "open"}">${stateLabel}</span></td>
        <td>${dateTime(row.entry_at)}</td>
        <td>${row.exit_at ? dateTime(row.exit_at) : "—"}</td>
        <td>${duration(row.duration_seconds)}</td>
        <td>${money(row.invested_cost_quote, quote)}</td>
        <td>${fmt(row.average_entry_price, 8)}</td>
        <td>${fmt(mark, 8)}</td>
        <td title="수수료 품질: ${escapeHtml(row.fee_accounting_quality || "미확인")}">${money(row.total_fees_quote, quote)}</td>
        <td class="${pnlClass(row.net_pnl_quote)}"><strong>${signedMoney(row.net_pnl_quote, quote)}</strong></td>
        <td class="${pnlClass(row.return_pct)}"><strong>${pct(row.return_pct)}</strong></td>
        <td>${escapeHtml(row.close_reason || (row.is_closed ? "종료" : "보유 중"))}</td>
      </tr>`;
    }).join("") : '<tr><td colspan="13" class="muted">선택 조건에 해당하는 실제 체결 거래가 없습니다.</td></tr>';

    const expandToggle = $("performance-expand-toggle");
    if (expandToggle) {
      expandToggle.textContent = performanceExpanded ? "접기 · 최신 10개" : "더 보기 · 50개";
      expandToggle.disabled = rows.length <= COLLAPSED_TRADE_LIMIT && !performanceExpanded;
    }
    const csvDownload = $("performance-csv-download");
    if (csvDownload) csvDownload.disabled = rows.length === 0;

    const shownFrom = rows.length ? start + 1 : 0;
    const shownTo = Math.min(rows.length, start + visibleRows.length);
    const summary = $("performance-row-summary");
    if (summary) {
      summary.textContent = performanceExpanded
        ? `필터 결과 ${rows.length}건 · ${shownFrom}–${shownTo} 표시`
        : `최신 ${shownTo}건 표시 · 필터 결과 ${rows.length}건`;
    }
    const pagination = $("performance-pagination");
    if (pagination) pagination.classList.toggle("hidden", !performanceExpanded || totalPages <= 1);
    const pageInfo = $("performance-page-info");
    if (pageInfo) pageInfo.textContent = `${performancePage} / ${totalPages}`;
    const previous = $("performance-page-prev");
    if (previous) previous.disabled = performancePage <= 1;
    const next = $("performance-page-next");
    if (next) next.disabled = performancePage >= totalPages;

    const definition = $("performance-definition");
    if (definition) definition.textContent = "기본 화면은 최신 10건입니다. 계좌 로그성장은 입출금 등 외부 현금흐름을 제거하며, 관리자본 회전율·활용률·승률을 함께 봅니다. 수수료 품질이 검증되지 않은 거래는 학습·승격 표본에서 제외됩니다.";
  }

  function render() {
    injectDashboard();
    renderSummary();
    renderTrades();
  }

  async function loadPerformance() {
    if (!dashboardToken || pending) return;
    pending = true;
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${config.performanceFunctionName || "market-performance"}`;
      const response = await originalFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-autotrade-token": dashboardToken,
          ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
        },
        body: JSON.stringify({ action: "status" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      latestPerformance = data;
      render();
    } catch (error) {
      const grid = $("exchange-performance-grid");
      if (grid) grid.innerHTML = `<article class="panel performance-empty performance-negative">성과 집계 실패: ${escapeHtml(error?.message || error)}</article>`;
    } finally {
      pending = false;
      if (refreshQueued) {
        refreshQueued = false;
        queueMicrotask(loadPerformance);
      }
    }
  }

  function scheduleLoad() {
    if (pending) refreshQueued = true;
    else queueMicrotask(loadPerformance);
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
        if (body?.action === "status" && response.ok) scheduleLoad();
      }
    } catch (_) {}
    return response;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectDashboard, { once: true });
  else injectDashboard();
})();
