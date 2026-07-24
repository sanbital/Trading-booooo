import type { FinalCandidate, RiskConfig } from "./engine.ts";

export type Exchange = "upbit" | "binance";
export type LearningParameters = {
  scoreThreshold: number;
  minNetRR: number;
  shortTargetAtrMult: number;
  stopAtrMult: number;
  mediumTargetAtr4hMult: number;
  mediumTargetAtrDayMult: number;
};
export type RuntimeProfile = {
  version: number;
  source: "CODE_DEFAULT" | "FORWARD_AUTO";
  parameters: LearningParameters;
  samples: number;
  validationSamples: number;
  objective: number;
  promotedAt: string | null;
};

export type StoredCandidate = {
  id: string;
  scan_id: string;
  exchange: Exchange;
  market: string;
  created_at: string;
  decision: "BUY" | "WAIT" | "AVOID";
  score: number;
  entry_low: number | null;
  entry_high: number | null;
  stop_price: number | null;
  target_1: number | null;
  target_2: number | null;
  net_rr: number | null;
  estimated_cost_pct: number | null;
  snapshot: Record<string, unknown>;
};

type Outcome = {
  candidate_id: string;
  entered: boolean;
  entry_price: number | null;
  entry_time: string | null;
  outcome: string;
  net_return_pct: number;
  mfe_pct: number;
  mae_pct: number;
  peak_capture_ratio: number | null;
  target_first: boolean;
  stop_first: boolean;
  evaluated_until: string;
};

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function configured(): boolean { return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")); }
function headers(extra: Record<string,string> = {}): HeadersInit {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra };
}
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`forward store ${response.status}: ${await response.text()}`);
  return response;
}

export async function loadRuntimeProfile(defaults: LearningParameters): Promise<RuntimeProfile> {
  if (!configured()) return { version: 0, source: "CODE_DEFAULT", parameters: defaults, samples: 0, validationSamples: 0, objective: 0, promotedAt: null };
  try {
    const r = await rest("scanner_runtime_profiles?active=eq.true&select=*&order=version.desc&limit=1");
    const rows = await r.json();
    const row = rows?.[0];
    if (!row?.parameters) throw new Error("no active profile");
    return { version: Number(row.version), source: "FORWARD_AUTO", parameters: { ...defaults, ...row.parameters }, samples: Number(row.samples || 0), validationSamples: Number(row.validation_samples || 0), objective: Number(row.objective || 0), promotedAt: row.promoted_at || null };
  } catch { return { version: 0, source: "CODE_DEFAULT", parameters: defaults, samples: 0, validationSamples: 0, objective: 0, promotedAt: null }; }
}

export function applyRuntimeRisk(risk: RiskConfig, profile: RuntimeProfile): RiskConfig {
  return { ...risk, ...profile.parameters };
}

function candidateRows(scanId: string, exchange: Exchange, candidates: FinalCandidate[]) {
  return candidates.map((c) => ({
    scan_id: scanId, exchange, market: c.market, created_at: new Date().toISOString(), decision: c.decision,
    score: c.score, confidence: c.confidence, entry_low: c.trade_plan?.entry_low ?? c.watch_entry_plan?.zone_low,
    entry_high: c.trade_plan?.entry_high ?? c.watch_entry_plan?.zone_high, stop_price: c.trade_plan?.stop_price ?? c.watch_entry_plan?.stop_price,
    target_1: c.trade_plan?.short_target ?? c.watch_entry_plan?.reference_target, target_2: c.trade_plan?.medium_target,
    net_rr: c.trade_plan?.net_rr ?? c.watch_entry_plan?.estimated_net_rr, estimated_cost_pct: c.trade_plan?.estimated_round_trip_cost_pct,
    failed_gate_count: c.failed_gates?.length || 0, snapshot: c,
  }));
}

export async function persistScan(result: any, profile: RuntimeProfile): Promise<{stored:boolean; reason?:string}> {
  if (!configured()) return { stored: false, reason: "SUPABASE persistence not configured" };
  const scanId = String(result.scan_id);
  await rest("scanner_scan_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: scanId, created_at: result.meta?.generated_at || new Date().toISOString(), mode: result.meta?.exchange || "combined", engine_version: result.meta?.engine_version, status: result.status, profile_version: profile.version, profile_source: profile.source, summary: { coverage: result.coverage, assumptions: result.assumptions } }) });
  const rows:any[] = [];
  if (result.meta?.exchange === "combined") {
    for (const c of result.exchanges?.upbit?.finalists || []) rows.push(...candidateRows(scanId, "upbit", [c]));
    for (const c of result.exchanges?.binance?.finalists || []) rows.push(...candidateRows(scanId, "binance", [c]));
  } else rows.push(...candidateRows(scanId, result.meta.exchange, result.finalists || []));
  if (rows.length) await rest("scanner_candidates?on_conflict=scan_id,exchange,market", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  return { stored: true };
}

async function pendingCandidates(hours = 36): Promise<StoredCandidate[]> {
  if (!configured()) return [];
  const before = new Date(Date.now() - 18 * 3600_000).toISOString();
  const after = new Date(Date.now() - hours * 3600_000).toISOString();
  const q = `scanner_candidates?created_at=gte.${encodeURIComponent(after)}&created_at=lte.${encodeURIComponent(before)}&select=id,scan_id,exchange,market,created_at,decision,score,entry_low,entry_high,stop_price,target_1,target_2,net_rr,estimated_cost_pct,snapshot&scanner_signal_outcomes=is.null&limit=200`;
  try { return await (await rest(q)).json(); } catch { // PostgREST embedded anti-join fallback through RPC-less id lookup
    const c:StoredCandidate[] = await (await rest(`scanner_candidates?created_at=gte.${encodeURIComponent(after)}&created_at=lte.${encodeURIComponent(before)}&select=id,scan_id,exchange,market,created_at,decision,score,entry_low,entry_high,stop_price,target_1,target_2,net_rr,estimated_cost_pct,snapshot&limit=200`)).json();
    const ids = c.map(x=>x.id); if (!ids.length) return [];
    const existing:any[] = await (await rest(`scanner_signal_outcomes?candidate_id=in.(${ids.join(",")})&select=candidate_id`)).json();
    const done = new Set(existing.map(x=>x.candidate_id)); return c.filter(x=>!done.has(x.id));
  }
}

export type Bar = {t:number;o:number;h:number;l:number;c:number};
async function path(exchange: Exchange, market: string, from: number, to: number): Promise<Bar[]> {
  if (exchange === "binance") {
    const url = new URL("https://api.binance.com/api/v3/klines"); url.searchParams.set("symbol", market); url.searchParams.set("interval", "5m"); url.searchParams.set("startTime", String(from)); url.searchParams.set("endTime", String(to)); url.searchParams.set("limit", "1000");
    const rows:any[] = await (await fetch(url)).json(); return rows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4]}));
  }
  const code = encodeURIComponent(market); const count = Math.min(288, Math.ceil((to-from)/300000)+5); const url=`https://api.upbit.com/v1/candles/minutes/5?market=${code}&count=${count}&to=${encodeURIComponent(new Date(to).toISOString())}`;
  const rows:any[] = await (await fetch(url)).json(); return rows.map(r=>({t:new Date(r.candle_date_time_utc+"Z").getTime(),o:+r.opening_price,h:+r.high_price,l:+r.low_price,c:+r.trade_price})).filter(r=>r.t>=from&&r.t<=to).sort((a,b)=>a.t-b.t);
}

export function evaluatePath(c: StoredCandidate, bars: Bar[], until: number): Outcome {
  const low = Number(c.entry_low), high = Number(c.entry_high), stop = Number(c.stop_price), t1 = Number(c.target_1), t2 = Number(c.target_2 || c.target_1), cost = Number(c.estimated_cost_pct || 0);
  let entry:Bar|null=null; for (const b of bars) { if (Number.isFinite(low)&&Number.isFinite(high)&&b.l<=high&&b.h>=low) { entry=b; break; } }
  if (!entry) return { candidate_id:c.id, entered:false, entry_price:null, entry_time:null, outcome:"NO_ENTRY", net_return_pct:0, mfe_pct:0, mae_pct:0, peak_capture_ratio:null, target_first:false, stop_first:false, evaluated_until:new Date(until).toISOString() };
  const ep=Math.min(high,Math.max(low,entry.o)); let maxH=ep,minL=ep,targetFirst=false,stopFirst=false,exit=bars.at(-1)?.c||ep,outcome="TIMEOUT";
  for (const b of bars.filter(x=>x.t>=entry!.t)) { maxH=Math.max(maxH,b.h); minL=Math.min(minL,b.l); const hitS=Number.isFinite(stop)&&b.l<=stop; const hitT=Number.isFinite(t1)&&b.h>=t1; if(hitS&&hitT){stopFirst=true;exit=stop;outcome="AMBIGUOUS_STOP_FIRST";break;} if(hitS){stopFirst=true;exit=stop;outcome="STOP_FIRST";break;} if(hitT){targetFirst=true;exit=t1;outcome="TARGET_FIRST";break;} }
  const gross=(exit/ep-1)*100; const net=gross-cost; const mfe=(maxH/ep-1)*100; const mae=(minL/ep-1)*100; const maxNet=Math.max(0,mfe-cost); const capture=maxNet>0?Math.max(-1,Math.min(1,net/maxNet)):null;
  return {candidate_id:c.id,entered:true,entry_price:ep,entry_time:new Date(entry.t).toISOString(),outcome,net_return_pct:+net.toFixed(6),mfe_pct:+mfe.toFixed(6),mae_pct:+mae.toFixed(6),peak_capture_ratio:capture==null?null:+capture.toFixed(6),target_first:targetFirst,stop_first:stopFirst,evaluated_until:new Date(until).toISOString()};
}

export async function reconcileForwardOutcomes(): Promise<{evaluated:number; errors:number}> {
  if (!configured()) return {evaluated:0,errors:0}; const pending=await pendingCandidates(); const outcomes:Outcome[]=[]; let errors=0;
  for(const c of pending){try{const from=new Date(c.created_at).getTime(); const to=Math.min(Date.now(),from+24*3600_000); const bars=await path(c.exchange,c.market,from,to); if(bars.length) outcomes.push(evaluatePath(c,bars,to)); else errors++;}catch{errors++;}}
  if(outcomes.length) await rest("scanner_signal_outcomes?on_conflict=candidate_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(outcomes)});
  return {evaluated:outcomes.length,errors};
}

function objective(rows:any[], scoreThreshold:number, minNetRR:number){
  const picked=rows.filter(r=>r.entered&&r.score>=scoreThreshold&&Number(r.net_rr||0)>=minNetRR&&r.decision!=="AVOID"); if(!picked.length)return {value:-999,n:0,expectancy:0,pf:0,dd:100};
  const returns=picked.map(r=>Number(r.net_return_pct)); const expectancy=returns.reduce((a,b)=>a+b,0)/returns.length; const gains=returns.filter(x=>x>0).reduce((a,b)=>a+b,0); const losses=Math.abs(returns.filter(x=>x<0).reduce((a,b)=>a+b,0)); const pf=losses?gains/losses:gains>0?5:0; let equity=0,peak=0,dd=0; for(const x of returns){equity+=x;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);} return {value:expectancy*5+Math.min(pf,4)-dd*.15,n:picked.length,expectancy,pf,dd};
}

export async function autoCalibrateForward(current: RuntimeProfile): Promise<{promoted:boolean; reason:string; profile:RuntimeProfile}> {
  if(!configured()) return {promoted:false,reason:"storage disabled",profile:current};
  const rows:any[] = await (await rest("scanner_candidates?select=id,created_at,decision,score,net_rr,scanner_signal_outcomes!inner(entered,net_return_pct,mfe_pct,mae_pct,peak_capture_ratio)&order=created_at.asc&limit=5000")).json();
  const flat=rows.map(r=>({...r,...(Array.isArray(r.scanner_signal_outcomes)?r.scanner_signal_outcomes[0]:r.scanner_signal_outcomes)})).filter(r=>r.net_return_pct!=null);
  if(flat.length<60) return {promoted:false,reason:`forward samples ${flat.length}/60`,profile:current};
  const split=Math.floor(flat.length*.7), train=flat.slice(0,split), valid=flat.slice(split); if(valid.length<20)return {promoted:false,reason:"validation samples <20",profile:current};
  const scores=[66,68,70,72,74,76,78,80], rrs=[1.2,1.3,1.4,1.5,1.6,1.8,2.0]; let best={s:current.parameters.scoreThreshold,r:current.parameters.minNetRR,...objective(train,current.parameters.scoreThreshold,current.parameters.minNetRR)};
  for(const s of scores)for(const r of rrs){const x=objective(train,s,r);if(x.n>=30&&x.value>best.value)best={s,r,...x};}
  const champion=objective(valid,current.parameters.scoreThreshold,current.parameters.minNetRR), challenger=objective(valid,best.s,best.r);
  if(challenger.n<20||challenger.expectancy<=0||challenger.pf<1.1||challenger.value<champion.value+0.15)return {promoted:false,reason:`challenger rejected n=${challenger.n} obj=${challenger.value.toFixed(3)} champion=${champion.value.toFixed(3)}`,profile:current};
  const winners=train.filter(x=>x.entered&&x.net_return_pct>0), losers=train.filter(x=>x.entered&&x.net_return_pct<0); const q=(a:number[],p:number)=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[Math.min(b.length-1,Math.floor((b.length-1)*p))]:0};
  const mfe=q(winners.map(x=>Number(x.mfe_pct)),.5), mae=Math.abs(q(losers.map(x=>Number(x.mae_pct)),.5)); const p={...current.parameters,scoreThreshold:best.s,minNetRR:best.r,shortTargetAtrMult:Math.max(1.4,Math.min(3.2,current.parameters.shortTargetAtrMult*(mfe>2.5?1.05:mfe<1.2?.95:1))),stopAtrMult:Math.max(.9,Math.min(1.8,current.parameters.stopAtrMult*(mae>2?1.05:mae<.7?.95:1)))};
  await rest("scanner_runtime_profiles?active=eq.true",{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({active:false})});
  const version=current.version+1; await rest("scanner_runtime_profiles",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({version,active:true,source:"FORWARD_AUTO",parameters:p,samples:flat.length,validation_samples:valid.length,objective:challenger.value,champion_objective:champion.value,promoted_at:new Date().toISOString(),evidence:{expectancy:challenger.expectancy,profit_factor:challenger.pf,max_drawdown_pct:challenger.dd}})});
  return {promoted:true,reason:"forward challenger promoted",profile:{version,source:"FORWARD_AUTO",parameters:p,samples:flat.length,validationSamples:valid.length,objective:challenger.value,promotedAt:new Date().toISOString()}};
}
