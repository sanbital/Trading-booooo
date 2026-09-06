// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const CONTROL_REVISION = "V16-PRODUCTION-CONTROL-1.0.0";
const CANARY_REVISION = "V16-PRODUCTION-CANARY-1.0.0";
const BROAD_REVISION = "V16-MOMENTUM-BROAD-SHADOW-1.0.0";
const EXPECTED_MARGIN = 40;
const EXPECTED_LEVERAGE = 3;
const EXPECTED_NOTIONAL = 120;
const EXPECTED_MAX_SLOTS = 10;
const FRESH_MS = 12 * 60_000;
const CONFIRM_PHRASE = "V16_READY_FOR_FINAL_CUTOVER";

const env = (name: string) => (Deno.env.get(name) || "").trim();
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const ALLOWED_ORIGIN = (env("ALLOWED_ORIGINS").split(",")[0] || "*").trim();

const CORS = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
  "access-control-max-age": "86400",
};
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function html(body: string) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
function n(v: any, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function safeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right), length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
function authorized(req: Request) {
  const provided = (req.headers.get("x-autotrade-token") || "").trim();
  if (!provided) return false;
  return (AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, provided)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, provided));
}
function ageMs(ts: any) {
  const t = Date.parse(String(ts || ""));
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

async function getIntents(db: any, runId: string | null) {
  if (!runId) return [];
  const q = await db.from("v16_production_canary_intents")
    .select("rank,symbol,score,side,margin_usdt,leverage,intended_notional_usdt,regime,exit_modifier,source_metrics,source_microstructure,executable,order_submitted")
    .eq("run_id", runId)
    .order("rank", { ascending: true });
  if (q.error) throw new Error(`INTENTS:${q.error.message}`);
  return q.data || [];
}

async function latestState(db: any) {
  const [controlQ, broadQ, canaryQ, lastActionableQ, settingsQ, openQ] = await Promise.all([
    db.from("v16_production_operator_control").select("*").eq("singleton", true).single(),
    db.from("v16_broad_shadow_runs")
      .select("id,run_at,revision,regime,universe_count,stage1_count,actionable_count,broad_confirm_count,data_error_count")
      .eq("revision", BROAD_REVISION).order("run_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("v16_production_canary_runs")
      .select("id,run_at,revision,regime,source_run_id,live_open_count,available_slots,candidate_count,selected_count,summary")
      .eq("revision", CANARY_REVISION).order("run_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("v16_production_canary_runs")
      .select("id,run_at,revision,regime,source_run_id,live_open_count,available_slots,candidate_count,selected_count,summary")
      .eq("revision", CANARY_REVISION).gt("selected_count", 0).order("run_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("trading_settings")
      .select("mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,binance_futures_allocation_usdt,updated_at")
      .eq("id", 1).single(),
    db.from("v11_long_regime_positions").select("id,symbol,revision,active_lane", { count: "exact" }).eq("state", "OPEN"),
  ]);
  if (controlQ.error || !controlQ.data) throw new Error(`CONTROL:${controlQ.error?.message || "missing"}`);
  if (broadQ.error) throw new Error(`BROAD:${broadQ.error.message}`);
  if (canaryQ.error) throw new Error(`CANARY:${canaryQ.error.message}`);
  if (lastActionableQ.error) throw new Error(`LAST_ACTIONABLE:${lastActionableQ.error.message}`);
  if (settingsQ.error) throw new Error(`SETTINGS:${settingsQ.error.message}`);
  if (openQ.error) throw new Error(`OPEN_POSITIONS:${openQ.error.message}`);

  const control = controlQ.data;
  const broad = broadQ.data || null;
  const canary = canaryQ.data || null;
  const lastActionable = lastActionableQ.data || null;
  const settings = settingsQ.data || {};
  const actualOpen = openQ.data || [];
  const currentIntents = await getIntents(db, canary?.id || null);
  const displayRun = canary?.selected_count > 0 ? canary : lastActionable;
  const displayIntents = canary?.selected_count > 0 ? currentIntents : await getIntents(db, displayRun?.id || null);

  const broadFresh = !!broad && ageMs(broad.run_at) <= FRESH_MS;
  const canaryFresh = !!canary && ageMs(canary.run_at) <= FRESH_MS;
  const routingLocked = control.order_routing_enabled === false && control.execution_effect === "NONE" &&
    String(canary?.summary?.orderRouting || "") === "DISABLED_CANARY_ONLY";
  const noIntentLeak = currentIntents.every((x: any) => x.executable === false && x.order_submitted === false) &&
    displayIntents.every((x: any) => x.executable === false && x.order_submitted === false);
  const sizingValid = displayIntents.every((x: any) =>
    n(x.margin_usdt) === EXPECTED_MARGIN && n(x.leverage) === EXPECTED_LEVERAGE &&
    n(x.intended_notional_usdt) === EXPECTED_NOTIONAL && String(x.side) === "LONG"
  );
  const slotValid = actualOpen.length <= EXPECTED_MAX_SLOTS && (!canary || (
    n(canary.available_slots) === Math.max(0, EXPECTED_MAX_SLOTS - actualOpen.length) &&
    n(canary.selected_count) <= n(canary.available_slots)
  ));
  const universeValid = !!broad && n(broad.universe_count) > 0;
  const blockers: string[] = [];
  if (!broadFresh) blockers.push("BROAD_SCAN_STALE_OR_MISSING");
  if (!canaryFresh) blockers.push("CANARY_STALE_OR_MISSING");
  if (!routingLocked) blockers.push("ORDER_ROUTING_LOCK_NOT_PROVEN");
  if (!noIntentLeak) blockers.push("CANARY_INTENT_EXECUTION_FLAG_LEAK");
  if (!sizingValid) blockers.push("INTENT_SIZING_MISMATCH");
  if (!slotValid) blockers.push("PORTFOLIO_SLOT_MISMATCH");
  if (!universeValid) blockers.push("UNIVERSE_EMPTY");
  const operatorApprovalReady = blockers.length === 0;

  const postApprovalManualLocks: string[] = ["V16_LIVE_EXECUTOR_NOT_CONNECTED"];
  if (settings.pause_new_entries === true) postApprovalManualLocks.push("GLOBAL_NEW_ENTRIES_PAUSED");
  if (settings.withdrawal_mode === true) postApprovalManualLocks.push("WITHDRAWAL_MODE");
  if (settings.manual_intervention_required === true) postApprovalManualLocks.push("MANUAL_INTERVENTION_REQUIRED");
  if (settings.scalp_kill_switch === true) postApprovalManualLocks.push("SCALP_KILL_SWITCH");

  return {
    controlRevision: CONTROL_REVISION,
    strategyRevision: CANARY_REVISION,
    control: {
      state: control.state,
      operatorAcknowledged: control.operator_acknowledged === true,
      acknowledgedAt: control.acknowledged_at || null,
      acknowledgedSource: control.acknowledged_source || null,
      acknowledgedNote: control.acknowledged_note || null,
      acknowledgedCanaryRunId: control.acknowledged_canary_run_id || null,
      orderRoutingEnabled: false,
      executionEffect: "NONE",
    },
    broad: broad ? {
      id: broad.id, runAt: broad.run_at, revision: broad.revision, regime: broad.regime,
      universeCount: n(broad.universe_count), stage1Count: n(broad.stage1_count),
      actionableCount: n(broad.actionable_count), broadConfirmCount: n(broad.broad_confirm_count),
      dataErrorCount: n(broad.data_error_count), fresh: broadFresh,
    } : null,
    canary: canary ? {
      id: canary.id, runAt: canary.run_at, revision: canary.revision, regime: canary.regime,
      liveOpenCount: n(canary.live_open_count), availableSlots: n(canary.available_slots),
      candidateCount: n(canary.candidate_count), selectedCount: n(canary.selected_count),
      orderRouting: canary.summary?.orderRouting || null, fresh: canaryFresh,
    } : null,
    displayIntentSource: displayRun ? {
      id: displayRun.id,
      runAt: displayRun.run_at,
      isCurrent: displayRun.id === canary?.id,
    } : null,
    intents: displayIntents,
    actualOpenPositions: actualOpen.map((x: any) => ({ symbol: x.symbol, revision: x.revision, activeLane: x.active_lane })),
    portfolio: { marginUsdt: EXPECTED_MARGIN, leverage: EXPECTED_LEVERAGE, notionalUsdt: EXPECTED_NOTIONAL, maxSlots: EXPECTED_MAX_SLOTS },
    settings: {
      mode: settings.mode || null,
      pauseNewEntries: settings.pause_new_entries === true,
      withdrawalMode: settings.withdrawal_mode === true,
      manualInterventionRequired: settings.manual_intervention_required === true,
      scalpKillSwitch: settings.scalp_kill_switch === true,
      futuresAllocationUsdt: n(settings.binance_futures_allocation_usdt),
      updatedAt: settings.updated_at || null,
    },
    safety: {
      regimeIsEntryGate: false,
      routingLocked,
      noIntentLeak,
      sizingValid,
      slotValid,
      universeValid,
      operatorApprovalReady,
      approvalBlockers: blockers,
      postApprovalManualLocks,
      approvalExecutionEffect: "NONE",
    },
  };
}

async function audit(db: any, action: string, result: string, state: any, source = "DASHBOARD_USER") {
  const q = await db.from("v16_production_operator_control_audit").insert({
    action, result, source, canary_run_id: state?.canary?.id || null,
    snapshot: {
      controlRevision: state?.controlRevision || null,
      strategyRevision: state?.strategyRevision || null,
      broad: state?.broad || null,
      canary: state?.canary || null,
      portfolio: state?.portfolio || null,
      safety: state?.safety || null,
      intentSymbols: (state?.intents || []).map((x: any) => x.symbol),
    },
  });
  if (q.error) throw new Error(`AUDIT:${q.error.message}`);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V16 Production Control</title>
<style>
:root{color-scheme:dark;--bg:#0a0d12;--card:#121720;--line:#252c38;--muted:#9aa7b7;--text:#eef3f8;--good:#42d392;--warn:#f5c451;--bad:#ff6b6b;--accent:#7aa2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1180px;margin:0 auto;padding:24px}.top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.eyebrow{font-size:12px;color:var(--accent);font-weight:700;letter-spacing:.08em}h1{font-size:30px;margin:5px 0 8px}.sub{color:var(--muted);font-size:14px}.auth{display:flex;gap:8px;align-items:center}.auth input{width:230px;background:#0e131b;border:1px solid var(--line);color:var(--text);border-radius:9px;padding:10px 12px}.btn{border:0;border-radius:9px;padding:10px 14px;font-weight:750;cursor:pointer;background:#29344a;color:#fff}.btn.primary{background:var(--accent);color:#08101f}.btn.approve{background:var(--good);color:#07150f;padding:13px 18px}.btn:disabled{opacity:.35;cursor:not-allowed}.banner{margin:20px 0;padding:16px 18px;border:1px solid var(--line);background:var(--card);border-radius:12px;display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}.lock{font-weight:800}.lock.good{color:var(--good)}.lock.bad{color:var(--bad)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.k{font-size:12px;color:var(--muted);margin-bottom:7px}.v{font-size:25px;font-weight:800}.small{font-size:12px;color:var(--muted);margin-top:5px}.section{margin-top:18px}.section h2{font-size:17px;margin:0 0 10px}.statusrow{display:flex;gap:8px;flex-wrap:wrap}.chip{font-size:12px;padding:6px 9px;border-radius:999px;border:1px solid var(--line);background:#0e131b}.chip.good{color:var(--good);border-color:#22543e}.chip.warn{color:var(--warn);border-color:#58491f}.chip.bad{color:var(--bad);border-color:#5a2929}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}th,td{text-align:right;padding:10px 9px;border-bottom:1px solid var(--line);font-size:12px}th{color:var(--muted);font-weight:650}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}.empty{padding:24px;color:var(--muted);text-align:center;background:var(--card);border:1px solid var(--line);border-radius:12px}.approval{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}.approval strong{display:block;margin-bottom:5px}.danger-note{color:var(--warn);font-size:12px;max-width:720px}.footer{margin-top:24px;color:var(--muted);font-size:11px}.err{color:var(--bad);font-size:12px;margin-top:8px;white-space:pre-wrap}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}.wrap{padding:16px}table{display:block;overflow-x:auto;white-space:nowrap}}@media(max-width:480px){.grid{grid-template-columns:1fr}.auth input{width:180px}}
</style></head><body><div class="wrap">
<div class="top"><div><div class="eyebrow">TRADING-BOOOOO / V16</div><h1>Production Control</h1><div class="sub">전체시장 탐색 → 정밀검증 → 최대 10슬롯 배분 → 운영자 승인 직전 상태</div></div><div class="auth"><input id="token" type="password" placeholder="Dashboard access token"><button class="btn" id="connect">연결</button></div></div>
<div class="banner"><div><div class="k">LIVE ORDER ROUTING</div><div id="routing" class="lock good">LOCKED · 주문 전송 없음</div></div><div><div class="k">OPERATOR STATE</div><div id="opstate" class="lock">미연결</div></div><button class="btn" id="refresh">새로고침</button></div>
<div class="grid"><div class="card"><div class="k">전체 유니버스</div><div class="v" id="universe">-</div><div class="small">Binance USDT perpetual</div></div><div class="card"><div class="k">1차 기회</div><div class="v" id="stage1">-</div><div class="small">5m momentum states</div></div><div class="card"><div class="k">정밀 대상</div><div class="v" id="actionable">-</div><div class="small">reclaim / direct / watch</div></div><div class="card"><div class="k">Broad Confirm</div><div class="v" id="confirmed">-</div><div class="small">flow + OI + book</div></div></div>
<div class="section"><h2>운용 상태</h2><div class="statusrow" id="chips"></div></div>
<div class="section"><h2>생산 후보 <span id="intentSource" class="small"></span></h2><div id="tableWrap" class="empty">토큰을 입력하고 연결하세요.</div></div>
<div class="section card approval"><div><strong>운영자 승인</strong><div id="approvalText" class="sub">상태 확인 전입니다.</div><div class="danger-note">이 버튼은 V16 운용 스택의 준비상태만 승인·감사기록합니다. Binance 주문 전송, 글로벌 pause 해제, live executor 연결은 수행하지 않습니다.</div><div class="err" id="err"></div></div><button id="approve" class="btn approve" disabled>최종 전환 준비 승인</button></div>
<div class="footer" id="footer">V16 Production Control · 15초 자동 새로고침</div></div>
<script>
let state=null; const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tok(){return $('token').value.trim()} function pct(v){const n=Number(v);return Number.isFinite(n)?(n*100).toFixed(2)+'%':'-'} function f(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'-'} function kst(v){if(!v)return '-';try{return new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})}catch{return String(v)}}
async function api(action,extra={}){const r=await fetch(location.href,{method:'POST',headers:{'content-type':'application/json','x-autotrade-token':tok()},body:JSON.stringify({action,...extra})});const t=await r.text();let d={};try{d=t?JSON.parse(t):{}}catch{d={raw:t}}if(!r.ok)throw new Error(d.error||d.blockers?.join(', ')||t);return d}
function chip(text,kind=''){return '<span class="chip '+kind+'">'+esc(text)+'</span>'}
function render(d){state=d;$('universe').textContent=d.broad?.universeCount??'-';$('stage1').textContent=d.broad?.stage1Count??'-';$('actionable').textContent=d.broad?.actionableCount??'-';$('confirmed').textContent=d.broad?.broadConfirmCount??'-';
 $('routing').textContent=d.safety?.routingLocked?'LOCKED · 주문 전송 없음':'LOCK 검증 실패';$('routing').className='lock '+(d.safety?.routingLocked?'good':'bad');
 $('opstate').textContent=d.control?.operatorAcknowledged?'OPERATOR ACKNOWLEDGED':'READY FOR OPERATOR APPROVAL';$('opstate').className='lock '+(d.control?.operatorAcknowledged?'good':'');
 const chips=[];chips.push(chip('Regime '+(d.broad?.regime||'-'),'good'));chips.push(chip('Entry gate: OFF','good'));chips.push(chip('Exit '+((d.intents?.[0]?.exit_modifier)||((d.broad?.regime==='BULL'||d.broad?.regime==='STRONG_BULL')?'WIDE':((d.broad?.regime==='BEAR'||d.broad?.regime==='RISK_OFF')?'TIGHT':'MEDIUM'))),'good'));chips.push(chip('Live slots '+(d.actualOpenPositions?.length||0)+'/10'));chips.push(chip('40 USDT × 3x','good'));chips.push(chip('Global new entries '+(d.settings?.pauseNewEntries?'PAUSED':'OPEN'),d.settings?.pauseNewEntries?'warn':'good'));chips.push(chip('Scan '+(d.broad?.fresh?'FRESH':'STALE'),d.broad?.fresh?'good':'bad'));chips.push(chip('Canary '+(d.canary?.fresh?'FRESH':'STALE'),d.canary?.fresh?'good':'bad'));$('chips').innerHTML=chips.join('');
 const rows=d.intents||[];$('intentSource').textContent=d.displayIntentSource?('· '+(d.displayIntentSource.isCurrent?'현재':'최근 actionable')+' '+kst(d.displayIntentSource.runAt)):'';
 if(!rows.length){$('tableWrap').className='empty';$('tableWrap').innerHTML='현재 production-admission 후보가 없습니다. 스캐너는 계속 5분마다 전체시장을 탐색합니다.'}else{$('tableWrap').className='';$('tableWrap').innerHTML='<table><thead><tr><th>#</th><th>Symbol</th><th>Score</th><th>Margin</th><th>Lev</th><th>Notional</th><th>Impulse</th><th>Pullback</th><th>Taker Buy</th><th>OI 15m</th><th>Spread</th><th>Slip</th><th>Exit</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.rank)+'</td><td><b>'+esc(x.symbol)+'</b></td><td>'+f(x.score,1)+'</td><td>'+f(x.margin_usdt,0)+'</td><td>'+f(x.leverage,0)+'x</td><td>'+f(x.intended_notional_usdt,0)+'</td><td>'+pct(x.source_metrics?.impulseReturn)+'</td><td>'+pct(x.source_metrics?.pullbackDepth)+'</td><td>'+pct(x.source_metrics?.takerBuyShare)+'</td><td>'+pct(x.source_microstructure?.oiDelta15)+'</td><td>'+f(x.source_microstructure?.spreadBps,2)+'</td><td>'+f(x.source_microstructure?.buySlippageBps,2)+'</td><td>'+esc(x.exit_modifier||'-')+'</td></tr>').join('')+'</tbody></table>'}
 const ready=d.safety?.operatorApprovalReady===true, ack=d.control?.operatorAcknowledged===true;$('approve').disabled=!ready||ack;$('approve').textContent=ack?'승인 완료':'최종 전환 준비 승인';$('approvalText').textContent=ack?('승인시각 '+kst(d.control?.acknowledgedAt)+' · 실제 주문 라우팅은 계속 LOCKED'):ready?'V16 스캔·canary·사이징·슬롯·비실행 플래그 검증 완료. 운영자 승인 대기중.':'승인 차단: '+(d.safety?.approvalBlockers||[]).join(', ');$('err').textContent='';$('footer').textContent='Broad '+kst(d.broad?.runAt)+' · Canary '+kst(d.canary?.runAt)+' · Control '+esc(d.controlRevision)+' · 15초 자동 새로고침';
}
async function load(){if(!tok()){ $('err').textContent='대시보드 토큰이 필요합니다.';return }try{const d=await api('status');sessionStorage.setItem('v16DashboardToken',tok());render(d)}catch(e){$('err').textContent=e.message}}
$('connect').onclick=load;$('refresh').onclick=load;$('approve').onclick=async()=>{if(!state?.safety?.operatorApprovalReady)return;if(!confirm('V16 운용 스택의 준비상태를 승인하시겠습니까?\n\n이 작업은 실제 주문을 전송하지 않습니다.'))return;try{const d=await api('acknowledge',{confirmPhrase:'${CONFIRM_PHRASE}',note:'Approved from V16 Production Control dashboard'});render(d.state)}catch(e){$('err').textContent=e.message}};
const saved=sessionStorage.getItem('v16DashboardToken');if(saved){$('token').value=saved;load()}setInterval(()=>{if(tok())load()},15000);
</script></body></html>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return html(DASHBOARD_HTML);
  if (req.method !== "POST") return json({ ok: false, error: "GET_OR_POST_ONLY" }, 405);
  if (!authorized(req)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "SUPABASE_ENV_MISSING" }, 500);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "status").toLowerCase();
    if (!['status','acknowledge'].includes(action)) return json({ ok: false, error: "INVALID_ACTION" }, 400);
    if (action === "status") return json({ ok: true, action: "status", ...(await latestState(db)) });

    if (String(body?.confirmPhrase || "") !== CONFIRM_PHRASE) {
      return json({ ok: false, error: "CONFIRM_PHRASE_REQUIRED" }, 400);
    }
    const before = await latestState(db);
    if (!before.safety.operatorApprovalReady) {
      await audit(db, "ACKNOWLEDGE", "BLOCKED", before);
      return json({ ok: false, error: "OPERATOR_APPROVAL_BLOCKED", blockers: before.safety.approvalBlockers, state: before }, 409);
    }
    const now = new Date().toISOString();
    const note = String(body?.note || "").slice(0, 500);
    const snapshot = {
      controlRevision: before.controlRevision,
      strategyRevision: before.strategyRevision,
      broad: before.broad,
      canary: before.canary,
      portfolio: before.portfolio,
      intentSymbols: (before.intents || []).map((x: any) => x.symbol),
      routingLockedAtApproval: before.safety.routingLocked,
      postApprovalManualLocks: before.safety.postApprovalManualLocks,
      executionEffect: "NONE",
    };
    const u = await db.from("v16_production_operator_control").update({
      state: "OPERATOR_ACKNOWLEDGED",
      operator_acknowledged: true,
      acknowledged_at: now,
      acknowledged_source: "DASHBOARD_USER",
      acknowledged_note: note,
      acknowledged_canary_run_id: before.canary?.id || null,
      acknowledged_snapshot: snapshot,
      order_routing_enabled: false,
      execution_effect: "NONE",
      updated_at: now,
    }).eq("singleton", true).select("state,operator_acknowledged,acknowledged_at,order_routing_enabled,execution_effect").single();
    if (u.error) throw new Error(`ACK_UPDATE:${u.error.message}`);
    const after = await latestState(db);
    await audit(db, "ACKNOWLEDGE", "ACKNOWLEDGED_NO_EXECUTION_EFFECT", after);
    return json({
      ok: true,
      action: "acknowledge",
      message: "V16 준비상태가 운영자 승인으로 기록되었습니다. 주문 라우팅은 계속 잠겨 있습니다.",
      liveOrdersSubmitted: 0,
      orderRoutingEnabled: false,
      executionEffect: "NONE",
      state: after,
    });
  } catch (e) {
    return json({ ok: false, controlRevision: CONTROL_REVISION, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
