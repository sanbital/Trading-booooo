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
  function syncDashboardToken() {
    const entered = String($("trader-token")?.value || "").trim();
    if (entered.length >= 32) dashboardToken = entered;
    return dashboardToken;
  }
  const esc = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const dtMs = value => Number.isFinite(Number(value))
    ? new Date(Number(value)).toLocaleString("ko-KR")
    : "—";
  const dt = value => value ? new Date(value).toLocaleString("ko-KR") : "—";

  function inject() {
    if ($("trade-performance-section")) return;
    const positions = $("positions-body")?.closest(".section-block");
    if (!positions) return;

    const section = document.createElement("section");
    section.id = "trade-performance-section";
    section.className = "section-block";
    section.innerHTML = `
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">BINANCE SOURCE OF TRUTH</p><h2>바이낸스 주문 내역</h2></div>
        <p>Binance Spot Order History와 계좌 잔고의 원본 필드만 표시합니다. 트레이딩 부우에서 손익·수익률·평균단가·체결가를 재계산하지 않습니다.</p>
      </div>
      <div class="performance-filters">
        <select id="binance-side-filter" aria-label="방향 필터">
          <option value="all">전체 방향</option><option value="BUY">BUY</option><option value="SELL">SELL</option>
        </select>
        <select id="binance-status-filter" aria-label="상태 필터">
          <option value="all">전체 상태</option><option value="FILLED">FILLED</option><option value="EXPIRED">EXPIRED</option><option value="CANCELED">CANCELED</option><option value="NEW">NEW</option>
        </select>
        <button id="performance-csv-download" class="button-secondary performance-action-button" type="button">CSV 다운로드</button>
        <button id="performance-expand-toggle" class="button-secondary performance-action-button" type="button">더 보기 · 50개</button>
        <button id="performance-refresh-now" class="button-primary performance-action-button" type="button">새로고침</button>
      </div>
      <div class="performance-refresh-bar"><span id="performance-refresh-status" class="performance-refresh-status">Binance Order History를 불러오는 중입니다.</span></div>

      <article class="panel performance-exchange-card" style="margin-bottom:14px">
        <div class="performance-card-head"><div><span>BINANCE ACCOUNT</span><h3>현재 실제 잔고</h3></div><strong id="binance-balance-snapshot-at">—</strong></div>
        <div id="binance-balance-grid" class="performance-detail-grid"><div><span>불러오는 중</span><b>—</b></div></div>
      </article>

      <div class="table-wrap panel performance-table-wrap">
        <table class="performance-table" style="min-width:1200px">
          <thead><tr><th>주문 시각</th><th>종목</th><th>Type</th><th>Side</th><th>Executed / Orig Qty</th><th>Price</th><th>Status</th><th>Order ID</th><th>Client Order ID</th><th>Update Time</th></tr></thead>
          <tbody id="trade-performance-body"><tr><td colspan="10" class="muted">Binance Order History를 불러오는 중입니다.</td></tr></tbody>
        </table>
      </div>
      <div class="performance-list-footer">
        <span id="performance-row-summary" class="performance-row-summary"></span>
        <nav id="performance-pagination" class="performance-pagination hidden"><button id="performance-page-prev" class="button-secondary" type="button">이전</button><span id="performance-page-info"></span><button id="performance-page-next" class="button-secondary" type="button">다음</button></nav>
      </div>
      <p class="performance-definition">원본: Binance Spot GET /api/v3/allOrders. MARKET 주문의 price가 Binance API에서 0으로 오면 0 그대로 표시합니다. 앱 화면처럼 체결 평균가를 만들기 위한 나눗셈도 하지 않습니다.</p>`;
    positions.insertAdjacentElement("afterend", section);

    ["binance-side-filter", "binance-status-filter"].forEach(id => $(id)?.addEventListener("change", () => { page = 1; renderOrders(); }));
    $("performance-expand-toggle")?.addEventListener("click", () => { expanded = !expanded; page = 1; renderOrders(); });
    $("performance-page-prev")?.addEventListener("click", () => { page = Math.max(1, page - 1); renderOrders(); });
    $("performance-page-next")?.addEventListener("click", () => { page += 1; renderOrders(); });
    $("performance-refresh-now")?.addEventListener("click", () => load({ force: true }));
    $("performance-csv-download")?.addEventListener("click", downloadCsv);
  }

  function filtered() {
    const rows = Array.isArray(latestSource?.orders) ? latestSource.orders : [];
    const side = $("binance-side-filter")?.value || "all";
    const status = $("binance-status-filter")?.value || "all";
    return rows.filter(row =>
      (side === "all" || String(row?.side || "").toUpperCase() === side) &&
      (status === "all" || String(row?.status || "").toUpperCase() === status)
    );
  }

  function renderBalances() {
    const grid = $("binance-balance-grid");
    const stamp = $("binance-balance-snapshot-at");
    if (!grid || !stamp) return;
    const snapshot = latestSource?.account_snapshot || null;
    stamp.textContent = snapshot?.captured_at ? dt(snapshot.captured_at) : "스냅샷 없음";
    const balances = Array.isArray(snapshot?.balances) ? snapshot.balances : [];
    const rows = balances
      .map(row => ({
        asset: String(row?.asset ?? row?.currency ?? "").toUpperCase(),
        available: row?.free ?? row?.balance ?? "",
        locked: row?.locked ?? "",
      }))
      .filter(row => row.asset && (Number(row.available) > 0 || Number(row.locked) > 0))
      .sort((a, b) => a.asset.localeCompare(b.asset));
    grid.innerHTML = rows.length
      ? rows.map(row => `<div><span>${esc(row.asset)}</span><b>Available ${esc(row.available)} · Locked ${esc(row.locked)}</b></div>`).join("")
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

    body.innerHTML = visible.length ? visible.map(order => `<tr>
      <td>${dtMs(order?.time)}</td>
      <td><strong>${esc(order?.symbol)}</strong></td>
      <td>${esc(order?.type)}</td>
      <td>${esc(order?.side)}</td>
      <td>${esc(order?.executedQty)} / ${esc(order?.origQty)}</td>
      <td>${esc(order?.price)}${String(order?.type || "").toUpperCase() === "MARKET" ? " / Market" : ""}</td>
      <td><strong>${esc(order?.status)}</strong></td>
      <td>${esc(order?.orderId)}</td>
      <td>${esc(order?.clientOrderId)}</td>
      <td>${dtMs(order?.updateTime)}</td>
    </tr>`).join("") : `<tr><td colspan="10" class="muted">선택 조건에 해당하는 Binance 주문이 없습니다.</td></tr>`;

    const toggle = $("performance-expand-toggle");
    if (toggle) { toggle.textContent = expanded ? "접기 · 최신 12개" : "더 보기 · 50개"; toggle.disabled = rows.length <= COLLAPSED && !expanded; }
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

  function render() { inject(); renderBalances(); renderOrders(); }
  function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
  function downloadCsv() {
    const rows = filtered();
    if (!rows.length) return;
    const headers = ["symbol", "orderId", "clientOrderId", "price", "origQty", "executedQty", "cummulativeQuoteQty", "status", "timeInForce", "type", "side", "time", "updateTime"];
    const lines = [headers.map(csvCell).join(","), ...rows.map(order => headers.map(key => csvCell(order?.[key] ?? "")).join(","))];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `binance-order-history-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function load({ force = false } = {}) {
    syncDashboardToken();
    if (!dashboardToken || pending) return;
    if (!force && document.hidden) return;
    pending = true;
    const status = $("performance-refresh-status");
    if (status) status.textContent = "Binance Order History 원본을 불러오는 중입니다.";
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${config.binanceOrderSourceFunctionName || "binance-order-source"}`;
      const response = await originalFetch(endpoint, {
        method: "POST", cache: "no-store",
        headers: { "content-type": "application/json", "x-autotrade-token": dashboardToken, ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}) },
        body: JSON.stringify({ routing_lookback_hours: 48, limit: 200 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      latestSource = data; lastLoaded = Date.now(); render();
      const errorText = Array.isArray(data.errors) && data.errors.length ? ` · 일부 종목 실패 ${data.errors.length}` : "";
      if (status) status.textContent = `Binance /api/v3/allOrders 원본 · 계산 없음 · ${dt(data.generated_at)}${errorText}`;
    } catch (error) {
      if (status) status.textContent = `Binance Order History 조회 실패: ${error?.message || error}`;
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
        if (body?.action === "status" && response.ok) queueMicrotask(() => load());
      }
    } catch (_) {}
    return response;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject, { once: true }); else inject();
  setInterval(() => {
    syncDashboardToken();
    if (dashboardToken && !document.hidden && Date.now() - lastLoaded >= REFRESH_MS) load();
  }, 5000);
  document.addEventListener("click", event => {
    if (event.target?.id !== "unlock-trader") return;
    syncDashboardToken();
    setTimeout(() => load({ force: true }), 500);
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ force: true }); });
})();
