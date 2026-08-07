(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  let dashboardToken = "";
  let latestSource = null;
  let pending = false;
  let lastLoaded = 0;
  let expanded = false;
  let page = 1;

  const REFRESH_MS = 60_000;
  const COLLAPSED = 12;
  const PAGE = 50;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const fmt = (value, digits = 10) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits })
    : "—";
  const dtMs = value => Number.isFinite(Number(value))
    ? new Date(Number(value)).toLocaleString("ko-KR")
    : "—";
  const dt = value => value ? new Date(value).toLocaleString("ko-KR") : "—";

  const STATUS_LABEL = {
    NEW: "대기",
    PARTIALLY_FILLED: "부분 체결",
    FILLED: "체결 완료",
    CANCELED: "취소",
    PENDING_CANCEL: "취소 대기",
    REJECTED: "거절",
    EXPIRED: "만료",
    EXPIRED_IN_MATCH: "매칭 중 만료",
  };

  const TYPE_LABEL = {
    LIMIT: "Limit",
    MARKET: "Market",
    LIMIT_MAKER: "Limit Maker",
    STOP_LOSS: "Stop Loss",
    STOP_LOSS_LIMIT: "Stop Loss Limit",
    TAKE_PROFIT: "Take Profit",
    TAKE_PROFIT_LIMIT: "Take Profit Limit",
  };

  function inject() {
    if ($("trade-performance-section")) return;
    const positions = $("positions-body")?.closest(".section-block");
    if (!positions) return;

    const section = document.createElement("section");
    section.id = "trade-performance-section";
    section.className = "section-block";
    section.innerHTML = `
      <div class="section-heading performance-heading">
        <div>
          <p class="eyebrow">BINANCE SOURCE OF TRUTH</p>
          <h2>바이낸스 주문 내역</h2>
        </div>
        <p>Binance Spot Order History 원본을 그대로 표시합니다. 손익·수익률·평균단가를 트레이딩 부우에서 계산하지 않습니다.</p>
      </div>

      <div class="performance-filters">
        <select id="binance-side-filter" aria-label="방향 필터">
          <option value="all">전체 방향</option>
          <option value="BUY">매수</option>
          <option value="SELL">매도</option>
        </select>
        <select id="binance-status-filter" aria-label="상태 필터">
          <option value="all">전체 상태</option>
          <option value="FILLED">체결 완료</option>
          <option value="EXPIRED">만료</option>
          <option value="CANCELED">취소</option>
          <option value="NEW">대기</option>
        </select>
        <button id="performance-csv-download" class="button-secondary performance-action-button" type="button">CSV 다운로드</button>
        <button id="performance-expand-toggle" class="button-secondary performance-action-button" type="button">더 보기 · 50개</button>
        <button id="performance-refresh-now" class="button-primary performance-action-button" type="button">새로고침</button>
      </div>

      <div class="performance-refresh-bar">
        <span id="performance-refresh-status" class="performance-refresh-status">Binance Order History를 불러오는 중입니다.</span>
      </div>

      <article class="panel performance-exchange-card" style="margin-bottom:14px">
        <div class="performance-card-head">
          <div><span>BINANCE ACCOUNT</span><h3>현재 실제 잔고</h3></div>
          <strong id="binance-balance-snapshot-at">—</strong>
        </div>
        <div id="binance-balance-grid" class="performance-detail-grid">
          <div><span>불러오는 중</span><b>—</b></div>
        </div>
      </article>

      <div class="table-wrap panel performance-table-wrap">
        <table class="performance-table" style="min-width:1150px">
          <thead><tr>
            <th>주문 시각</th><th>종목</th><th>주문</th><th>수량</th><th>가격</th>
            <th>상태</th><th>주문 ID</th><th>Client Order ID</th><th>업데이트 시각</th>
          </tr></thead>
          <tbody id="trade-performance-body">
            <tr><td colspan="9" class="muted">Binance Order History를 불러오는 중입니다.</td></tr>
          </tbody>
        </table>
      </div>

      <div class="performance-list-footer">
        <span id="performance-row-summary" class="performance-row-summary"></span>
        <nav id="performance-pagination" class="performance-pagination hidden" aria-label="바이낸스 주문내역 페이지">
          <button id="performance-page-prev" class="button-secondary performance-page-button" type="button">이전</button>
          <span id="performance-page-info"></span>
          <button id="performance-page-next" class="button-secondary performance-page-button" type="button">다음</button>
        </nav>
      </div>
      <p class="performance-definition">데이터 원본: Binance Spot GET /api/v3/allOrders. origQty / executedQty, price, type, side, status, time, updateTime, orderId를 Binance 응답 그대로 표시합니다. 합산·손익 계산·평균단가 재계산 없음.</p>`;
    positions.insertAdjacentElement("afterend", section);

    ["binance-side-filter", "binance-status-filter"].forEach(id => {
      $(id)?.addEventListener("change", () => { page = 1; renderOrders(); });
    });
    $("performance-expand-toggle")?.addEventListener("click", () => {
      expanded = !expanded;
      page = 1;
      renderOrders();
    });
    $("performance-page-prev")?.addEventListener("click", () => {
      page = Math.max(1, page - 1);
      renderOrders();
    });
    $("performance-page-next")?.addEventListener("click", () => {
      page += 1;
      renderOrders();
    });
    $("performance-refresh-now")?.addEventListener("click", () => load({ force: true }));
    $("performance-csv-download")?.addEventListener("click", downloadCsv);
  }

  function filtered() {
    const rows = Array.isArray(latestSource?.orders) ? latestSource.orders : [];
    const side = $("binance-side-filter")?.value || "all";
    const status = $("binance-status-filter")?.value || "all";
    return rows.filter(row => {
      if (side !== "all" && String(row?.side || "").toUpperCase() !== side) return false;
      if (status !== "all" && String(row?.status || "").toUpperCase() !== status) return false;
      return true;
    });
  }

  function renderBalances() {
    const grid = $("binance-balance-grid");
    const stamp = $("binance-balance-snapshot-at");
    if (!grid || !stamp) return;
    const snapshot = latestSource?.account_snapshot || null;
    stamp.textContent = snapshot?.captured_at ? dt(snapshot.captured_at) : "스냅샷 없음";
    const balances = Array.isArray(snapshot?.balances) ? snapshot.balances : [];
    const nonzero = balances
      .map(row => ({
        asset: String(row?.asset ?? row?.currency ?? "").toUpperCase(),
        free: Number(row?.free ?? row?.balance ?? 0),
        locked: Number(row?.locked ?? 0),
      }))
      .map(row => ({ ...row, total: row.free + row.locked }))
      .filter(row => row.asset && Number.isFinite(row.total) && row.total > 0)
      .sort((a, b) => a.asset.localeCompare(b.asset));

    grid.innerHTML = nonzero.length
      ? nonzero.map(row => `<div><span>${esc(row.asset)}</span><b>${fmt(row.total, 10)}</b></div>`).join("")
      : `<div><span>잔고</span><b>표시할 자산 없음</b></div>`;
  }

  function renderOrders() {
    const body = $("trade-performance-body");
    if (!body || !latestSource) return;
    const rows = filtered();
    const size = expanded ? PAGE : COLLAPSED;
    const totalPages = expanded ? Math.max(1, Math.ceil(rows.length / PAGE)) : 1;
    page = Math.max(1, Math.min(page, totalPages));
    const start = expanded ? (page - 1) * PAGE : 0;
    const visible = rows.slice(start, start + size);

    body.innerHTML = visible.length ? visible.map(order => {
      const side = String(order?.side || "").toUpperCase();
      const type = String(order?.type || "").toUpperCase();
      const status = String(order?.status || "").toUpperCase();
      const orderLabel = `${TYPE_LABEL[type] || type} / ${side === "BUY" ? "Buy" : side === "SELL" ? "Sell" : side}`;
      const amount = `${esc(order?.executedQty ?? "")} / ${esc(order?.origQty ?? "")}`;
      const price = type === "MARKET"
        ? `${esc(order?.cummulativeQuoteQty ?? order?.cumulativeQuoteQty ?? "")} / Market`
        : esc(order?.price ?? "");
      return `<tr>
        <td>${dtMs(order?.time)}</td>
        <td><strong>${esc(order?.symbol)}</strong></td>
        <td><strong>${esc(orderLabel)}</strong></td>
        <td>${amount}</td>
        <td>${price}</td>
        <td><strong>${esc(STATUS_LABEL[status] || status)}</strong></td>
        <td>${esc(order?.orderId)}</td>
        <td>${esc(order?.clientOrderId)}</td>
        <td>${dtMs(order?.updateTime)}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="9" class="muted">선택 조건에 해당하는 Binance 주문이 없습니다.</td></tr>`;

    const toggle = $("performance-expand-toggle");
    if (toggle) {
      toggle.textContent = expanded ? "접기 · 최신 12개" : "더 보기 · 50개";
      toggle.disabled = rows.length <= COLLAPSED && !expanded;
    }
    const summary = $("performance-row-summary");
    if (summary) summary.textContent = expanded
      ? `Binance 주문 ${rows.length}건 · ${rows.length ? start + 1 : 0}–${Math.min(rows.length, start + visible.length)} 표시`
      : `Binance 최신 ${Math.min(rows.length, visible.length)}건 표시 · 조회 ${rows.length}건`;
    const nav = $("performance-pagination");
    if (nav) nav.classList.toggle("hidden", !expanded || totalPages <= 1);
    if ($("performance-page-info")) $("performance-page-info").textContent = `${page} / ${totalPages}`;
    if ($("performance-page-prev")) $("performance-page-prev").disabled = page <= 1;
    if ($("performance-page-next")) $("performance-page-next").disabled = page >= totalPages;
  }

  function render() {
    inject();
    renderBalances();
    renderOrders();
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function downloadCsv() {
    const rows = filtered();
    if (!rows.length) return;
    const headers = ["symbol", "orderId", "clientOrderId", "price", "origQty", "executedQty", "cummulativeQuoteQty", "status", "timeInForce", "type", "side", "time", "updateTime"];
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map(order => headers.map(key => csvCell(order?.[key] ?? (key === "cummulativeQuoteQty" ? order?.cumulativeQuoteQty : ""))).join(",")),
    ];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `binance-order-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function load({ force = false } = {}) {
    if (!dashboardToken || pending) return;
    if (!force && document.hidden) return;
    pending = true;
    const status = $("performance-refresh-status");
    if (status) status.textContent = "Binance Order History 원본을 불러오는 중입니다.";
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${config.binanceOrderSourceFunctionName || "binance-order-source"}`;
      const response = await originalFetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-autotrade-token": dashboardToken,
          ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
        },
        body: JSON.stringify({ lookback_hours: 48, limit: 200 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      latestSource = data;
      lastLoaded = Date.now();
      render();
      const errorText = Array.isArray(data.errors) && data.errors.length ? ` · 일부 종목 조회 실패 ${data.errors.length}` : "";
      if (status) status.textContent = `Binance Spot /api/v3/allOrders 원본 · 자체 계산 없음 · ${dt(data.generated_at)}${errorText}`;
    } catch (error) {
      if (status) status.textContent = `Binance Order History 조회 실패: ${error?.message || error}`;
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
        if (body?.action === "status" && response.ok) queueMicrotask(() => load());
      }
    } catch (_) {}
    return response;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject, { once: true });
  else inject();

  setInterval(() => {
    if (dashboardToken && !document.hidden && Date.now() - lastLoaded >= REFRESH_MS) load();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && dashboardToken) load({ force: true });
  });
})();
