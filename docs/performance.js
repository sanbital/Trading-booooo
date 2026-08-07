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
  const fmt = (value, digits = 8) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString("ko-KR", { maximumFractionDigits: digits })
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
        <div>
          <p class="eyebrow">BINANCE SOURCE OF TRUTH</p>
          <h2>바이낸스 실거래 내역</h2>
        </div>
        <p>Binance Spot API가 내려준 실제 체결 데이터만 표시합니다. 손익·수익률·평균원가는 이 화면에서 자체 계산하지 않습니다.</p>
      </div>

      <div class="performance-filters">
        <select id="binance-side-filter" aria-label="매수 매도 필터">
          <option value="all">전체 방향</option>
          <option value="BUY">매수</option>
          <option value="SELL">매도</option>
        </select>
        <button id="performance-csv-download" class="button-secondary performance-action-button" type="button">CSV 다운로드</button>
        <button id="performance-expand-toggle" class="button-secondary performance-action-button" type="button">더 보기 · 50개</button>
        <button id="performance-refresh-now" class="button-primary performance-action-button" type="button">새로고침</button>
      </div>

      <div class="performance-refresh-bar">
        <span id="performance-refresh-status" class="performance-refresh-status">Binance 원본 데이터를 불러오는 중입니다.</span>
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
            <th>체결 시각</th><th>종목</th><th>방향</th><th>체결 수량</th><th>체결가</th>
            <th>거래대금</th><th>수수료</th><th>체결 방식</th><th>주문 ID</th><th>체결 ID</th>
          </tr></thead>
          <tbody id="trade-performance-body">
            <tr><td colspan="10" class="muted">Binance 원본 데이터를 불러오는 중입니다.</td></tr>
          </tbody>
        </table>
      </div>

      <div class="performance-list-footer">
        <span id="performance-row-summary" class="performance-row-summary"></span>
        <nav id="performance-pagination" class="performance-pagination hidden" aria-label="바이낸스 체결내역 페이지">
          <button id="performance-page-prev" class="button-secondary performance-page-button" type="button">이전</button>
          <span id="performance-page-info"></span>
          <button id="performance-page-next" class="button-secondary performance-page-button" type="button">다음</button>
        </nav>
      </div>
      <p class="performance-definition">데이터 원본: Binance Spot GET /api/v3/myTrades. 표시값은 Binance 응답의 price, qty, quoteQty, commission, commissionAsset, time, orderId, trade id를 그대로 사용합니다. 한 주문이 여러 번 체결되면 Binance 체결 건수만큼 여러 줄로 보입니다.</p>`;
    positions.insertAdjacentElement("afterend", section);

    $("binance-side-filter")?.addEventListener("change", () => { page = 1; renderTrades(); });
    $("performance-expand-toggle")?.addEventListener("click", () => {
      expanded = !expanded;
      page = 1;
      renderTrades();
    });
    $("performance-page-prev")?.addEventListener("click", () => {
      page = Math.max(1, page - 1);
      renderTrades();
    });
    $("performance-page-next")?.addEventListener("click", () => {
      page += 1;
      renderTrades();
    });
    $("performance-refresh-now")?.addEventListener("click", () => load({ force: true }));
    $("performance-csv-download")?.addEventListener("click", downloadCsv);
  }

  function rawTrade(row) {
    const raw = row?.binance && typeof row.binance === "object" ? row.binance : {};
    return {
      market: raw.symbol || row.market || "",
      tradeId: raw.id ?? row.exchange_trade_id,
      orderId: raw.orderId ?? row.exchange_order_id,
      price: raw.price ?? row.price,
      qty: raw.qty ?? row.quantity,
      quoteQty: raw.quoteQty ?? row.quote_amount,
      commission: raw.commission ?? row.fee_amount,
      commissionAsset: raw.commissionAsset ?? row.fee_asset,
      time: Number.isFinite(Number(raw.time)) ? Number(raw.time) : Date.parse(row.executed_at || ""),
      isBuyer: raw.isBuyer ?? String(row.side).toUpperCase() === "BUY",
      isMaker: raw.isMaker ?? Boolean(row.is_maker),
    };
  }

  function filtered() {
    const rows = Array.isArray(latestSource?.trades) ? latestSource.trades : [];
    const side = $("binance-side-filter")?.value || "all";
    return rows.filter(row => {
      const trade = rawTrade(row);
      const tradeSide = trade.isBuyer ? "BUY" : "SELL";
      return side === "all" || tradeSide === side;
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

  function renderTrades() {
    const body = $("trade-performance-body");
    if (!body || !latestSource) return;
    const rows = filtered();
    const size = expanded ? PAGE : COLLAPSED;
    const totalPages = expanded ? Math.max(1, Math.ceil(rows.length / PAGE)) : 1;
    page = Math.max(1, Math.min(page, totalPages));
    const start = expanded ? (page - 1) * PAGE : 0;
    const visible = rows.slice(start, start + size);

    body.innerHTML = visible.length ? visible.map(row => {
      const trade = rawTrade(row);
      const sideLabel = trade.isBuyer ? "매수" : "매도";
      const time = Number.isFinite(trade.time) ? new Date(trade.time).toLocaleString("ko-KR") : "—";
      return `<tr>
        <td>${time}</td>
        <td><strong>${esc(trade.market)}</strong></td>
        <td><strong>${sideLabel}</strong></td>
        <td>${esc(trade.qty)}</td>
        <td>${esc(trade.price)}</td>
        <td>${esc(trade.quoteQty)}</td>
        <td>${esc(trade.commission)} ${esc(trade.commissionAsset)}</td>
        <td>${trade.isMaker ? "Maker" : "Taker"}</td>
        <td>${esc(trade.orderId)}</td>
        <td>${esc(trade.tradeId)}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="10" class="muted">선택 조건에 해당하는 Binance 체결이 없습니다.</td></tr>`;

    const toggle = $("performance-expand-toggle");
    if (toggle) {
      toggle.textContent = expanded ? "접기 · 최신 12개" : "더 보기 · 50개";
      toggle.disabled = rows.length <= COLLAPSED && !expanded;
    }
    const summary = $("performance-row-summary");
    if (summary) summary.textContent = expanded
      ? `Binance 체결 ${rows.length}건 · ${rows.length ? start + 1 : 0}–${Math.min(rows.length, start + visible.length)} 표시`
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
    renderTrades();
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function downloadCsv() {
    const rows = filtered();
    if (!rows.length) return;
    const headers = ["체결시각", "종목", "방향", "수량", "체결가", "거래대금", "수수료", "수수료자산", "Maker", "주문ID", "체결ID"];
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map(row => {
        const t = rawTrade(row);
        return [
          Number.isFinite(t.time) ? new Date(t.time).toISOString() : "",
          t.market,
          t.isBuyer ? "BUY" : "SELL",
          t.qty,
          t.price,
          t.quoteQty,
          t.commission,
          t.commissionAsset,
          t.isMaker,
          t.orderId,
          t.tradeId,
        ].map(csvCell).join(",");
      }),
    ];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `binance-mytrades-${new Date().toISOString().slice(0, 10)}.csv`;
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
    if (status) status.textContent = "Binance 원본 체결 데이터를 불러오는 중입니다.";
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/${config.binanceSourceFunctionName || "binance-source"}`;
      const response = await originalFetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-autotrade-token": dashboardToken,
          ...(config.supabasePublishableKey ? { apikey: config.supabasePublishableKey } : {}),
        },
        body: JSON.stringify({ limit: 500 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      latestSource = data;
      lastLoaded = Date.now();
      render();
      const run = data.sync_run || {};
      const syncText = run.completed_at ? ` · 동기화 ${dt(run.completed_at)}` : "";
      if (status) status.textContent = `Binance Spot /api/v3/myTrades 원본 · 자체 계산 없음${syncText}`;
    } catch (error) {
      if (status) status.textContent = `Binance 원본 조회 실패: ${error?.message || error}`;
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
