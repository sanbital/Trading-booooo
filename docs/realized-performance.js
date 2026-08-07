(() => {
  "use strict";

  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  const $ = id => document.getElementById(id);
  let dashboardToken = "";
  let latest = null;
  let pending = false;
  let timer = null;

  const esc = v => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const fmt = (v, d = 6) => Number.isFinite(Number(v))
    ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d }) : "—";
  const money = v => `${num(v) >= 0 ? "+" : ""}${fmt(v, 4)} USDT`;
  const pct = v => `${num(v) >= 0 ? "+" : ""}${fmt(v, 2)}%`;
  const dt = v => v ? new Date(v).toLocaleString("ko-KR") : "—";

  function injectStyles() {
    if ($("realized-performance-style")) return;
    const style = document.createElement("style");
    style.id = "realized-performance-style";
    style.textContent = `
      .runtime-health-grid,.realized-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0}
      .runtime-health-grid>div,.realized-summary-grid>div{padding:14px;border:1px solid rgba(148,163,184,.2);border-radius:14px;background:rgba(15,23,42,.35)}
      .runtime-health-grid span,.realized-summary-grid span{display:block;font-size:12px;color:#8fa0b4;margin-bottom:6px}.runtime-health-grid b,.realized-summary-grid b{font-size:16px}
      .runtime-ok{color:#45e0a8}.runtime-warn{color:#f7c65f}.runtime-bad{color:#ff7187}.realized-positive{color:#45e0a8}.realized-negative{color:#ff7187}
      @media(max-width:760px){.runtime-health-grid,.realized-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.realized-trade-table{min-width:980px}}
    `;
    document.head.appendChild(style);
  }

  function inject() {
    injectStyles();
    const positions = $("positions-body")?.closest(".section-block");
    if (!positions) return false;

    if (!$("runtime-health-section")) {
      const runtime = document.createElement("section");
      runtime.id = "runtime-health-section";
      runtime.className = "section-block";
      runtime.innerHTML = `
        <div class="section-heading"><div><p class="eyebrow">LIVE ENGINE STATUS</p><h2>자동매매 동작 상태</h2></div><p id="runtime-health-note">실시간 상태 확인 중</p></div>
        <article class="panel"><div id="runtime-health-grid" class="runtime-health-grid"><div><span>상태</span><b>확인 중</b></div></div></article>`;
      positions.before(runtime);
    }

    if (!$("realized-performance-section")) {
      const section = document.createElement("section");
      section.id = "realized-performance-section";
      section.className = "section-block";
      section.innerHTML = `
        <div class="section-heading"><div><p class="eyebrow">BINANCE REALIZED PERFORMANCE</p><h2>거래별 성과</h2></div><p>Binance 실제 fill의 확정 원가·매도대금·실현손익을 SELL 주문별로 합산합니다.</p></div>
        <div id="realized-summary-grid" class="realized-summary-grid"><div><span>확정손익</span><b>—</b></div></div>
        <div class="table-wrap panel"><table class="performance-table realized-trade-table"><thead><tr>
          <th>청산 시각</th><th>종목</th><th>수량</th><th>매수 원가</th><th>매수 평균가</th><th>매도 평균가</th><th>매도대금</th><th>수수료</th><th>확정손익</th><th>수익률</th><th>보유시간</th>
        </tr></thead><tbody id="realized-performance-body"><tr><td colspan="11" class="muted">Binance 체결 데이터를 불러오는 중입니다.</td></tr></tbody></table></div>
        <p id="realized-performance-source" class="performance-definition">Binance 실제 fill 기준 · 진행 중 포지션은 확정손익에 포함하지 않음</p>`;
      positions.after(section);
    }
    return true;
  }

  function orderGroups(trades) {
    const rows = Array.isArray(trades) ? trades : [];
    const buysByPosition = new Map();
    for (const row of rows) {
      if (String(row.side).toUpperCase() !== "BUY" || !row.position_id) continue;
      const t = Date.parse(row.executed_at || "");
      if (!Number.isFinite(t)) continue;
      const prev = buysByPosition.get(row.position_id);
      if (!prev || t < prev) buysByPosition.set(row.position_id, t);
    }

    const groups = new Map();
    for (const row of rows) {
      if (String(row.side).toUpperCase() !== "SELL" || String(row.accounting_status || "") !== "ACCOUNTED") continue;
      const key = `${row.market}:${row.exchange_order_id || row.exchange_trade_id}`;
      const current = groups.get(key) || {
        market: row.market, orderId: row.exchange_order_id, positionId: row.position_id,
        quantity: 0, grossQuote: 0, cost: 0, proceeds: 0, pnl: 0, fees: 0,
        executedAt: row.executed_at, buyAt: row.position_id ? buysByPosition.get(row.position_id) : null,
      };
      current.quantity += num(row.quantity);
      current.grossQuote += num(row.quote_amount);
      current.cost += num(row.realized_cost_quote);
      current.proceeds += num(row.realized_proceeds_quote);
      current.pnl += num(row.realized_pnl_quote);
      current.fees += num(row.fee_quote_amount);
      if (Date.parse(row.executed_at || "") > Date.parse(current.executedAt || "")) current.executedAt = row.executed_at;
      groups.set(key, current);
    }
    return [...groups.values()].map(g => ({
      ...g,
      buyAvg: g.quantity > 0 ? g.cost / g.quantity : 0,
      sellAvg: g.quantity > 0 ? g.grossQuote / g.quantity : 0,
      returnPct: g.cost > 0 ? g.pnl / g.cost * 100 : 0,
      holdingMs: g.buyAt ? Math.max(0, Date.parse(g.executedAt) - g.buyAt) : null,
    })).sort((a,b) => Date.parse(b.executedAt) - Date.parse(a.executedAt));
  }

  function hold(ms) {
    if (!Number.isFinite(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m}분 ${r}초`;
    return `${Math.floor(m/60)}시간 ${m%60}분`;
  }

  function renderRuntime() {
    const r = latest?.runtime || {};
    const now = Date.now();
    const scanAge = now - Date.parse(r.last_full_scan_at || "");
    const monitorAge = now - Date.parse(r.last_monitor_at || "");
    const gatewayAge = now - Date.parse(r.last_gateway_heartbeat_at || "");
    const activeMode = String(r.mode || "") === "LIVE_LIMITED";
    const allowed = !r.pause_new_entries && !r.emergency_liquidation && !r.withdrawal_mode && !r.manual_intervention_required;
    const fresh = scanAge >= 0 && scanAge < 60000 && monitorAge >= 0 && monitorAge < 30000 && gatewayAge >= 0 && gatewayAge < 30000;
    const running = activeMode && allowed && fresh;
    const stateClass = running ? "runtime-ok" : allowed ? "runtime-warn" : "runtime-bad";
    const state = running ? "운영 중 · 진입 대기 가능" : !allowed ? "거래 중단/진입 차단" : "상태 지연 확인 필요";
    const grid = $("runtime-health-grid");
    if (grid) grid.innerHTML = `
      <div><span>자동매매</span><b class="${stateClass}">${state}</b></div>
      <div><span>운영 모드</span><b>${esc(r.mode || "—")}</b></div>
      <div><span>신규 매수</span><b class="${allowed ? "runtime-ok" : "runtime-bad"}">${allowed ? "허용" : "차단"}</b></div>
      <div><span>최근 전체 스캔</span><b>${dt(r.last_full_scan_at)}</b></div>
      <div><span>최근 포지션 모니터</span><b>${dt(r.last_monitor_at)}</b></div>
      <div><span>Gateway heartbeat</span><b>${dt(r.last_gateway_heartbeat_at)}</b></div>
      <div><span>Gateway 오류</span><b>${fmt(r.gateway_error_count,0)}건</b></div>
      <div><span>무포지션 의미</span><b>${running ? "조건 충족 종목 대기" : "상태 확인 필요"}</b></div>`;
    const note = $("runtime-health-note");
    if (note) note.textContent = running ? "무포지션이어도 엔진은 정상 동작 중입니다." : "최근 동작 시각과 진입 차단 설정을 확인하세요.";
  }

  function renderPerformance() {
    const rows = orderGroups(latest?.trades);
    const body = $("realized-performance-body");
    if (body) body.innerHTML = rows.length ? rows.slice(0,50).map(row => {
      const tone = row.pnl >= 0 ? "realized-positive" : "realized-negative";
      return `<tr><td>${dt(row.executedAt)}</td><td><strong>${esc(row.market)}</strong></td><td>${fmt(row.quantity,8)}</td><td>${fmt(row.cost,4)} USDT</td><td>${fmt(row.buyAvg,8)}</td><td>${fmt(row.sellAvg,8)}</td><td>${fmt(row.proceeds,4)} USDT</td><td>${fmt(row.fees,4)} USDT</td><td class="${tone}"><strong>${money(row.pnl)}</strong></td><td class="${tone}"><strong>${pct(row.returnPct)}</strong></td><td>${hold(row.holdingMs)}</td></tr>`;
    }).join("") : `<tr><td colspan="11" class="muted">확정된 Binance SELL 거래가 없습니다.</td></tr>`;

    const total = rows.reduce((s,r)=>s+r.pnl,0);
    const wins = rows.filter(r=>r.pnl>0);
    const losses = rows.filter(r=>r.pnl<0);
    const grossWin = wins.reduce((s,r)=>s+r.pnl,0);
    const grossLoss = Math.abs(losses.reduce((s,r)=>s+r.pnl,0));
    const pf = grossLoss > 0 ? grossWin/grossLoss : grossWin > 0 ? Infinity : 0;
    const summary = $("realized-summary-grid");
    if (summary) summary.innerHTML = `
      <div><span>총 확정손익</span><b class="${total>=0?"realized-positive":"realized-negative"}">${money(total)}</b></div>
      <div><span>확정 SELL 주문</span><b>${rows.length}건</b></div>
      <div><span>승률</span><b>${rows.length ? fmt(wins.length/rows.length*100,1) : "0"}%</b></div>
      <div><span>Profit Factor</span><b>${pf===Infinity?"∞":fmt(pf,2)}</b></div>`;
    const src = $("realized-performance-source");
    if (src) src.textContent = `${latest?.data_source || "Binance myTrades"} · ${latest?.revision || ""} · ${dt(latest?.generated_at)} · realized_cost/proceeds/pnl 저장값 사용`;
  }

  function render() { if (!inject()) return; renderRuntime(); renderPerformance(); }

  async function load(force=false) {
    if (!dashboardToken || pending || (!force && document.hidden)) return;
    pending = true;
    try {
      const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/,"")}/functions/v1/${config.binanceSourceFunctionName || "binance-source"}`;
      const response = await originalFetch(endpoint,{method:"POST",cache:"no-store",headers:{"content-type":"application/json","x-autotrade-token":dashboardToken,...(config.supabasePublishableKey?{apikey:config.supabasePublishableKey}:{})},body:JSON.stringify({limit:1000})});
      const data = await response.json().catch(()=>({}));
      if (!response.ok || data.ok===false) throw new Error(data.error || `HTTP ${response.status}`);
      latest = data; render();
    } catch (e) {
      inject(); const n=$("runtime-health-note"); if(n)n.textContent=`상태 조회 실패: ${e?.message||e}`;
    } finally { pending=false; }
  }

  window.fetch = async (input, init={}) => {
    const response = await originalFetch(input,init);
    try {
      const url = typeof input === "string" ? input : String(input?.url || "");
      if (url.includes(`/${config.autotraderFunctionName || "market-autotrader"}`)) {
        const headers = new Headers(init?.headers || (typeof input !== "string" ? input?.headers : undefined));
        const captured = headers.get("x-autotrade-token");
        if (captured && captured.length >= 32) dashboardToken = captured;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body?.action === "status" && response.ok) queueMicrotask(()=>load(true));
      }
    } catch (_) {}
    return response;
  };

  document.addEventListener("click", event => {
    if (event.target?.id !== "unlock-trader") return;
    const entered = String($("trader-token")?.value || "").trim();
    if (entered.length >= 32) dashboardToken = entered;
    setTimeout(()=>load(true),800);
  }, true);

  document.addEventListener("visibilitychange",()=>{if(!document.hidden)load(true);});
  window.addEventListener("pageshow",()=>setTimeout(()=>load(true),500));
  timer=setInterval(()=>load(false),15000);
  inject();
})();
