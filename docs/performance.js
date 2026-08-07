(() => {
  "use strict";
  const config = window.TRADING_SCANNER_CONFIG || {};
  const originalFetch = window.fetch.bind(window);
  let dashboardToken = "";
  let latestPerformance = null;
  let pending = false;
  let lastLoaded = 0;
  let expanded = false;
  let page = 1;
  const REFRESH_MS = 45_000;
  const COLLAPSED = 10;
  const PAGE = 50;
  const $ = id => document.getElementById(id);
  const finite = (v, f=0) => Number.isFinite(Number(v)) ? Number(v) : f;
  const fmt = (v,d=2) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("ko-KR",{maximumFractionDigits:d}) : "—";
  const pct = v => Number.isFinite(Number(v)) ? `${Number(v)>0?"+":""}${Number(v).toFixed(2)}%` : "—";
  const money = (v,q) => q === "KRW" ? `${fmt(v,0)}원` : `${fmt(v,4)} USDT`;
  const signedMoney = (v,q) => `${finite(v)>0?"+":""}${money(v,q)}`;
  const dt = v => v ? new Date(v).toLocaleString("ko-KR") : "—";
  const dur = s => { const n=Math.max(0,Math.round(finite(s))); const h=Math.floor(n/3600),m=Math.floor((n%3600)/60),x=n%60; return h?`${h}시간 ${m}분`:m?`${m}분 ${x}초`:`${x}초`; };
  const esc = v => String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
  const cls = v => finite(v)>0?"performance-positive":finite(v)<0?"performance-negative":"";

  function inject() {
    if ($("trade-performance-section")) return;
    const allocation = $("save-allocation")?.closest(".section-block");
    const positions = $("positions-body")?.closest(".section-block");
    if (!allocation || !positions) return;
    const summary=document.createElement("section"); summary.id="exchange-performance-section"; summary.className="section-block";
    summary.innerHTML=`<div class="section-heading"><div><p class="eyebrow">PERFORMANCE BY EXCHANGE</p><h2>거래소별 누적 성과</h2></div><p>실제 체결 데이터만 집계합니다. 매도 체결은 확정 손익, 남은 수량만 현재가 평가합니다.</p></div><div id="exchange-performance-grid" class="performance-exchange-grid"><article class="panel performance-empty">성과 데이터를 불러오는 중입니다.</article></div>`;
    allocation.insertAdjacentElement("afterend",summary);
    const section=document.createElement("section"); section.id="trade-performance-section"; section.className="section-block";
    section.innerHTML=`
      <div class="section-heading performance-heading">
        <div><p class="eyebrow">TRADE PERFORMANCE</p><h2>거래별 성과</h2></div>
        <div class="performance-filters">
          <select id="performance-exchange-filter"><option value="all">전체 거래소</option><option value="upbit">업비트</option><option value="binance">바이낸스</option></select>
          <select id="performance-state-filter"><option value="all">전체 상태</option><option value="open">보유 중</option><option value="closed">매도 완료</option></select>
          <select id="performance-period-filter"><option value="all">전체 기간</option><option value="today">오늘</option><option value="7">최근 7일</option><option value="30">최근 30일</option></select>
          <button id="performance-csv-download" class="button-secondary performance-action-button" type="button">CSV 다운로드</button>
          <button id="performance-expand-toggle" class="button-secondary performance-action-button" type="button">더 보기 · 50개</button>
          <button id="performance-refresh-now" class="button-primary performance-action-button" type="button">새로고침</button>
        </div>
      </div>
      <div class="performance-refresh-bar"><span id="performance-refresh-status" class="performance-refresh-status">성과 데이터를 불러오는 중입니다.</span></div>
      <div class="table-wrap panel performance-table-wrap"><table class="performance-table"><thead><tr>
        <th>거래소</th><th>종목</th><th>구분</th><th>수량</th><th>진입 시각</th><th>매도 시각</th><th>거래시간</th><th>투자금</th><th>진입가</th><th>현재가·매도가</th><th>수수료</th><th>순손익</th><th>순수익률</th><th>사유</th>
      </tr></thead><tbody id="trade-performance-body"><tr><td colspan="14" class="muted">성과 데이터를 불러오는 중입니다.</td></tr></tbody></table></div>
      <div class="performance-list-footer"><span id="performance-row-summary"></span><nav id="performance-pagination" class="performance-pagination hidden"><button id="performance-page-prev" class="button-secondary" type="button">이전</button><span id="performance-page-info"></span><button id="performance-page-next" class="button-secondary" type="button">다음</button></nav></div>
      <p id="performance-definition" class="performance-definition">기준: 실제 거래소 fill. 분할 매도는 매도 주문별로 별도 확정하고, 아직 팔지 않은 수량만 보유 중 손익으로 평가합니다.</p>`;
    positions.insertAdjacentElement("afterend",section);
    ["performance-exchange-filter","performance-state-filter","performance-period-filter"].forEach(id=>$(id)?.addEventListener("change",()=>{page=1;renderTrades();}));
    $("performance-expand-toggle")?.addEventListener("click",()=>{expanded=!expanded;page=1;renderTrades();});
    $("performance-page-prev")?.addEventListener("click",()=>{page=Math.max(1,page-1);renderTrades();});
    $("performance-page-next")?.addEventListener("click",()=>{page+=1;renderTrades();});
    $("performance-refresh-now")?.addEventListener("click",()=>load({force:true}));
    $("performance-csv-download")?.addEventListener("click",downloadCsv);
  }

  function filtered() {
    const rows=Array.isArray(latestPerformance?.trades)?latestPerformance.trades:[];
    const ex=$("performance-exchange-filter")?.value||"all", st=$("performance-state-filter")?.value||"all", per=$("performance-period-filter")?.value||"all", now=Date.now();
    return rows.filter(r=>{
      if(ex!=="all"&&r.exchange!==ex)return false;
      if(st==="open"&&!r.is_open)return false;
      if(st==="closed"&&!r.is_closed)return false;
      if(per!=="all"){
        const t=new Date(r.exit_at||r.entry_at||0).getTime(); if(!Number.isFinite(t))return false;
        if(per==="today"){ if(new Date().toLocaleDateString("ko-KR")!==new Date(t).toLocaleDateString("ko-KR"))return false; }
        else if(t<now-Number(per)*86400000)return false;
      }
      return true;
    });
  }

  function rowLabel(r){ return r.row_type==="REALIZED_EXIT"?"매도 완료":"보유 중"; }
  function reason(r){ return r.row_type==="REALIZED_EXIT"?(r.close_reason||"SELL"):"보유 중"; }
  function renderTrades(){
    const body=$("trade-performance-body"); if(!body||!latestPerformance)return;
    const rows=filtered(), size=expanded?PAGE:COLLAPSED, total=expanded?Math.max(1,Math.ceil(rows.length/PAGE)):1; page=Math.max(1,Math.min(page,total)); const start=expanded?(page-1)*PAGE:0, visible=rows.slice(start,start+size);
    body.innerHTML=visible.length?visible.map(r=>{const q=r.quote_currency,mark=r.is_closed?r.average_exit_price:r.current_price;return `<tr>
      <td>${r.exchange==="upbit"?"UPBIT":"BINANCE"}</td><td><strong>${esc(r.market)}</strong></td><td>${rowLabel(r)}</td><td><strong>${fmt(r.quantity,8)}</strong></td>
      <td>${dt(r.entry_at)}</td><td>${r.exit_at?dt(r.exit_at):"—"}</td><td>${dur(r.duration_seconds)}</td><td>${money(r.invested_cost_quote,q)}</td>
      <td>${fmt(r.average_entry_price,8)}</td><td>${fmt(mark,8)}</td><td>${money(r.total_fees_quote,q)}</td><td class="${cls(r.net_pnl_quote)}"><strong>${signedMoney(r.net_pnl_quote,q)}</strong></td><td class="${cls(r.return_pct)}"><strong>${pct(r.return_pct)}</strong></td><td>${esc(reason(r))}</td></tr>`;}).join(""):`<tr><td colspan="14" class="muted">선택 조건에 해당하는 실제 체결 거래가 없습니다.</td></tr>`;
    const toggle=$("performance-expand-toggle"); if(toggle){toggle.textContent=expanded?"접기 · 최신 10개":"더 보기 · 50개";toggle.disabled=rows.length<=COLLAPSED&&!expanded;}
    const sm=$("performance-row-summary"); if(sm)sm.textContent=expanded?`필터 결과 ${rows.length}건 · ${rows.length?start+1:0}–${Math.min(rows.length,start+visible.length)} 표시`:`최신 ${Math.min(rows.length,visible.length)}건 표시 · 필터 결과 ${rows.length}건`;
    const nav=$("performance-pagination"); if(nav)nav.classList.toggle("hidden",!expanded||total<=1); if($("performance-page-info"))$("performance-page-info").textContent=`${page} / ${total}`; if($("performance-page-prev"))$("performance-page-prev").disabled=page<=1; if($("performance-page-next"))$("performance-page-next").disabled=page>=total;
  }

  function renderSummary(){
    const grid=$("exchange-performance-grid"); if(!grid||!latestPerformance)return;
    grid.innerHTML=["upbit","binance"].map(ex=>{const r=latestPerformance.exchanges?.[ex]||{},q=r.quote_currency||(ex==="upbit"?"KRW":"USDT");return `<article class="panel performance-exchange-card"><div class="performance-card-head"><div><span>${ex.toUpperCase()}</span><h3>${ex==="upbit"?"KRW 현물":"USDT 현물"}</h3></div><strong>${money(r.current_equity_quote,q)}</strong></div><div class="performance-primary-grid"><div><span>실현손익</span><strong class="${cls(r.realized_net_pnl_quote)}">${signedMoney(r.realized_net_pnl_quote,q)}</strong></div><div><span>보유중 손익</span><strong class="${cls(r.open_net_pnl_quote)}">${signedMoney(r.open_net_pnl_quote,q)}</strong></div><div><span>누적 손익</span><strong class="${cls(r.cumulative_net_pnl_quote)}">${signedMoney(r.cumulative_net_pnl_quote,q)}</strong></div><div><span>현재 보유 수익률</span><strong class="${cls(r.current_open_return_pct)}">${pct(r.current_open_return_pct)}</strong></div></div><div class="performance-detail-grid"><div><span>매도 완료</span><b>${fmt(r.closed_trade_count,0)}건</b></div><div><span>보유</span><b>${fmt(r.open_trade_count,0)}건</b></div><div><span>승률</span><b>${fmt(r.win_rate_pct,1)}%</b></div><div><span>총 수수료</span><b>${money(r.total_fees_quote,q)}</b></div></div></article>`;}).join("");
  }
  function render(){inject();renderSummary();renderTrades();}

  function downloadCsv(){
    const rows=filtered(); if(!rows.length)return; const headers=["거래소","종목","구분","수량","진입시각","매도시각","투자금","진입가","현재가/매도가","수수료","순손익","순수익률","사유"];
    const cell=v=>`"${String(v??"").replaceAll('"','""')}"`;
    const lines=[headers.map(cell).join(","),...rows.map(r=>[r.exchange,r.market,rowLabel(r),r.quantity,r.entry_at,r.exit_at||"",r.invested_cost_quote,r.average_entry_price,r.is_closed?r.average_exit_price:r.current_price,r.total_fees_quote,r.net_pnl_quote,r.return_pct,reason(r)].map(cell).join(","))];
    const blob=new Blob(["\uFEFF",lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`trading-performance-${new Date().toISOString().slice(0,10)}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
  }

  async function load({force=false}={}){
    if(!dashboardToken||pending)return; pending=true; const status=$("performance-refresh-status"); if(status)status.textContent="실제 체결 기준으로 집계 중입니다.";
    try{
      const endpoint=`${String(config.supabaseUrl||"").replace(/\/$/,"")}/functions/v1/${config.performanceFunctionName||"market-performance"}`;
      const res=await originalFetch(endpoint,{method:"POST",cache:"no-store",headers:{"content-type":"application/json","x-autotrade-token":dashboardToken,...(config.supabasePublishableKey?{apikey:config.supabasePublishableKey}:{})},body:JSON.stringify({action:force?"refresh":"status",force})});
      const data=await res.json().catch(()=>({})); if(!res.ok||data.ok===false)throw new Error(data.error||`HTTP ${res.status}`); latestPerformance=data;lastLoaded=Date.now();render();if(status)status.textContent=`실제 fill 기준 · ${new Date(lastLoaded).toLocaleTimeString("ko-KR")} 갱신 · ${data.performance_revision||""}`;
    }catch(e){if(status)status.textContent=`성과 집계 실패: ${e?.message||e}`;}finally{pending=false;}
  }

  window.fetch=async(input,init={})=>{
    const res=await originalFetch(input,init);
    try{const url=typeof input==="string"?input:String(input?.url||"");if(url.includes(`/${config.autotraderFunctionName||"market-autotrader"}`)){const h=new Headers(init?.headers||(typeof input!=="string"?input?.headers:undefined));const t=h.get("x-autotrade-token");if(t&&t.length>=32)dashboardToken=t;const b=typeof init?.body==="string"?JSON.parse(init.body):{};if(b?.action==="status"&&res.ok)queueMicrotask(()=>load());}}catch(_){}
    return res;
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",inject,{once:true});else inject();
  setInterval(()=>{if(dashboardToken&&!document.hidden&&Date.now()-lastLoaded>=REFRESH_MS)load();},5000);
})();
