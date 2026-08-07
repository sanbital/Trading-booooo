(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  let dashboardToken = "";
  let pending = false;
  let timer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const dt = (value) => value ? new Date(value).toLocaleString("ko-KR") : "—";

  function ensureCard() {
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
        <p>최근 실제 스캔과 진입 판정 로그를 기준으로 표시합니다.</p>
      </div>
      <article class="panel" style="padding:18px 20px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <div id="entry-live-state" class="state-running" style="font-size:22px;font-weight:800">확인 중</div>
            <div id="entry-live-message" class="muted" style="margin-top:6px">최근 스캔을 확인하고 있습니다.</div>
          </div>
          <button id="entry-status-refresh" class="button-secondary" type="button">상태 새로고침</button>
        </div>
        <div class="performance-detail-grid" style="margin-top:18px">
          <div><span>마지막 스캔</span><b id="entry-last-scan">—</b></div>
          <div><span>마지막 모니터</span><b id="entry-last-monitor">—</b></div>
          <div><span>이번 스캔 판정</span><b id="entry-scan-count">—</b></div>
          <div><span>최근 30분 판정</span><b id="entry-recent-count">—</b></div>
          <div><span>마지막 주문</span><b id="entry-last-order">—</b></div>
          <div><span>게이트웨이</span><b id="entry-gateway">—</b></div>
        </div>
        <div style="margin-top:18px">
          <strong>최근 30분 주요 진입 탈락 사유</strong>
          <div id="entry-reasons" style="margin-top:10px" class="muted">확인 중</div>
        </div>
        <div style="margin-top:18px">
          <strong>가장 최근 판정</strong>
          <div id="entry-latest-decision" style="margin-top:10px" class="muted">—</div>
        </div>
      </article>`;
    anchor.insertAdjacentElement("afterend", section);
    $("entry-status-refresh")?.addEventListener("click", () => load());
  }

  function render(data) {
    ensureCard();
    const state = $("entry-live-state");
    if (!state) return;
    const blocked = data.state === "BLOCKED";
    state.textContent = blocked ? "🔴 거래 중단" : data.state === "ENTRY_FOUND" ? "🟢 진입 신호 발생" : "🟢 정상 가동 · 진입 대기";
    state.className = blocked ? "state-paused" : "state-running";
    $("entry-live-message").textContent = data.message || "—";
    $("entry-last-scan").textContent = dt(data.last_scan_at);
    $("entry-last-monitor").textContent = dt(data.last_monitor_at);
    $("entry-scan-count").textContent = `${Number(data.decisions_since_scan || 0)}건 · 승인 ${Number(data.accepted_since_scan || 0)} / 탈락 ${Number(data.rejected_since_scan || 0)}`;
    $("entry-recent-count").textContent = `${Number(data.recent_30m_decisions || 0)}건`;
    $("entry-gateway").textContent = Number(data.gateway_error_count || 0) === 0
      ? `정상 · ${dt(data.last_gateway_heartbeat_at)}`
      : `오류 ${Number(data.gateway_error_count)}건`;
    const order = data.last_order;
    $("entry-last-order").textContent = order
      ? `${dt(order.requested_at)} · ${order.market || ""} ${order.side || ""}`
      : "주문 없음";
    const reasons = Array.isArray(data.top_rejection_reasons_30m) ? data.top_rejection_reasons_30m : [];
    $("entry-reasons").innerHTML = reasons.length
      ? reasons.map((row) => `<div class="detail-row"><span>${esc(row.reason)}</span><strong>${Number(row.count)}건</strong></div>`).join("")
      : "최근 30분 탈락 로그 없음";
    const latest = data.latest_decision;
    $("entry-latest-decision").textContent = latest
      ? `${dt(latest.created_at)} · ${latest.exchange?.toUpperCase?.() || ""} ${latest.market || ""} · ${latest.outcome || ""} · ${latest.reason || "사유 없음"}`
      : "최근 판정 없음";
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
        $("entry-live-state").className = "state-paused";
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
        if (body?.action === "status" && response.ok) queueMicrotask(load);
      }
    } catch (_) {}
    return response;
  };

  const start = () => {
    ensureCard();
    clearInterval(timer);
    timer = setInterval(load, 15000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
