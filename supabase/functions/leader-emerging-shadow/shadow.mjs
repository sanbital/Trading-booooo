/** LE-SHADOW-1 orchestration: modes scan / wait / outcome / diagnostic.
 * ORDER-FREE: no order, account, gateway, lease, CEC RPC or production GPT ledger/journal path
 * exists in this function. It reads public market data (through the guard) and the listed
 * production tables, and appends to schema shadow_le. `store` is the only DB surface. */
import {activeSymbols,M15} from '../_shared/leader-momentum-v17.mjs';
import {computeFacts} from '../_shared/gpt-final-decision/facts.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {getJson} from './guard.mjs';
import {MIN,observerPrices,tickerPrices,rankUniverse,kstDayStart,kstDay,OBSERVER_MAX_AGE_MS,ANCHOR_ON_TIME_MS,rankIn} from './universe.mjs';
import {LANE_RULES,classify,shortlist,softCategories,ruleBaseline,takeAll} from './select.mjs';
import {preciseRead,readV17,readBtc15,readQuote} from './features.mjs';
import {gptGate,buildPacket,callAlt1,hashOf,promptHash,BUDGET,payloadFor} from './gpt.mjs';
import {WAIT_TTL_MS,MODEL} from './contract.mjs';
import {evaluateWait,recheckContext} from './wait.mjs';
import {labelOutcome,KLINE_LIMIT} from './outcome.mjs';
import {scoreAlternativeEntry} from './alternative-score.mjs';
import {scoreV2} from './score-v2.mjs';
import {v2Discovery,v2Outcome} from './v2/run.mjs';

export const PATCH='LE-SHADOW-1+2';
const iso=t=>new Date(t).toISOString();
const ms=x=>x instanceof Date?x.getTime():typeof x==='number'?x:Date.parse(x);
const int=x=>Number.isFinite(x)?Math.round(x):null;
const errText=e=>(e?.name==='GuardError'||e?.constructor?.name==='GuardError'?String(e.code):[e?.code,e?.message??String(e)].filter(Boolean).join(':')).slice(0,120)+(e?.detail!=null&&typeof e.detail!=='object'?':'+String(e.detail).slice(0,40):'');

function binanceStatus(g){return g.state.dayHalt??g.state.abort??'OK';}
function baseCycle(mode,started){return {mode,status:'OK',started_at:iso(started),patch:PATCH,errors:[],detail:{},arms_active:[],request_weight:0,gpt_calls:0,binance_status:'OK'};}
function finish(c,guard,now){c.finished_at=iso(now());c.request_weight=guard.state.weight;c.used_weight_max=guard.state.usedMax;
  c.binance_status=binanceStatus(guard);c.detail={...c.detail,requests:guard.state.requests,openai_requests:guard.state.openaiRequests};return c;}

async function anchorFor(store,guard,day,dayStart,now){
  const have=await store.anchor(day);if(have)return have;
  const first=await store.observerFirstAfter(iso(dayStart));
  if(!first)return null;
  const info=await getJson(guard,'/fapi/v1/exchangeInfo');
  const act=activeSymbols(info,Math.floor(now()/M15)*M15);
  const prices=Object.fromEntries(observerPrices(first.liquid_prices));
  const lag=ms(first.observed_at)-dayStart;
  await store.insertAnchor({kst_day:day,day_start:iso(dayStart),anchor_bucket:iso(ms(first.observation_bucket)),anchor_observed_at:iso(ms(first.observed_at)),
    anchor_lag_ms:lag,anchor_quality:lag<=ANCHOR_ON_TIME_MS?'ON_TIME':'LATE',
    source:now()-dayStart<=15*MIN?'OBSERVER_FIRST_AFTER_1500Z':'BOOTSTRAP_OBSERVER',
    prices,n_prices:Object.keys(prices).length,coin_symbols:act.symbols,n_coin:act.symbols.length,excluded:act.excluded.slice(0,200),
    exchange_info_at:iso(now()),patch:PATCH});
  return store.anchor(day);
}

/** production top10 of its latest scan (read only) -> Map(symbol -> rank) if fresh. */
async function prodTop10(store,t){
  const r=await store.prodTop10Latest();
  if(!r||t-ms(r.signal_close_at)>20*MIN)return new Map();
  return new Map((Array.isArray(r.top10)?r.top10:[]).map((x,i)=>[x.symbol,Number(x.rank??i+1)]));
}

/** vr15 needed only to break a velocity tie at the EMERGING cap boundary (pre-registered order). */
async function tieBreakVr15(guard,rows,recent,now){
  const em=rows.filter(r=>r.lane==='EMERGING'&&!recent.has(r.symbol)).sort((a,b)=>b.velocity-a.velocity);
  const slots=LANE_RULES.maxEmerging,vr=new Map();
  if(em.length<=slots)return vr;
  const edge=em[slots-1].velocity,tied=em.filter(r=>r.velocity===edge).slice(0,4);
  if(tied.length<2)return vr;
  for(const r of tied){try{vr.set(r.symbol,(await readV17(guard,r.symbol,now())).volumeRatio);}catch{/* unknown sorts last */}}
  return vr;
}

function high60(src){
  const xs=(Array.isArray(src?.one)?src.one:[]).slice(-60).map(r=>Number(r[2])).filter(x=>x>0);
  return xs.length?Math.max(...xs):null;
}
function bookMid(book){const b=Number(book?.bids?.[0]?.[0]),a=Number(book?.asks?.[0]?.[0]);return b>0&&a>=b?(b+a)/2:null;}

function entryFields(quote,rich){
  return quote?{hyp_entry_at:iso(quote.at),hyp_entry_ask:quote.ask,hyp_entry_mid:quote.mid,
    hyp_spread_bps:rich?.cost?.spread_bps??quote.spread_bps,hyp_slip_bps_600:rich?.cost?.entry_slippage_bps_600??null,
    hyp_slip_bps_450:rich?.cost?.entry_slippage_bps_450??null}:{};
}

async function gptDecision({store,guard,apiKey,now,c,rich,packet,snapshotAt,attempt=1,parent=null}){
  const ph=await promptHash(),payload=payloadFor(packet),sh=await hashOf(payload.text.format.schema),pk=await hashOf(packet);
  const r=await callAlt1(packet,{apiKey,fetchFn:guard.fetch,now,
    reserve:(usd,purpose)=>store.budgetReserve(usd,purpose),settle:(id,usd)=>store.budgetSettle(id,usd)});
  let quote=null;try{quote=await readQuote(guard,c.symbol,now);}catch{/* no entry price */}
  const a=r.answer;
  const wait=a?.wait?{...a.wait,snapshot_at_ms:snapshotAt,expires_at_ms:snapshotAt+WAIT_TTL_MS,mid:bookMid(rich.src?.book),
    high60:high60(rich.src),spread_bps:rich.facts?.values?.spread_bps??null,rank:c.rank}:null;
  return {row:{symbol:c.symbol,arm:'GPT_ALT1',attempt,parent_decision_id:parent,decision:r.decision,valid:r.valid,
    reasons:a?.reasons??[],support:a?.support??[],expected_move_bps:a?.expected_move_bps??null,
    wait_trigger:wait,wait_expires_at:wait?iso(wait.expires_at_ms):null,packet,packet_hash:pk,model:MODEL,prompt_hash:ph,schema_hash:sh,
    snapshot_at:iso(snapshotAt),answered_at:iso(r.answered_at),latency_ms:int(r.latency_ms),tokens_in:r.tokens_in,tokens_out:r.tokens_out,
    cost_usd:r.cost_usd,request_id:r.request_id,error:r.error,...entryFields(quote,rich)},called:r.attempted};
}

// ------------------------------------------------------------------------------------ scan
export async function runScan({store,store2=null,guard,now=Date.now,apiKey=null}){
  const started=now(),cycle=baseCycle('SCAN',started);
  const ctl=await store.control();
  if(ctl?.enabled!==true)return {ok:true,mode:'scan',status:'DISABLED',written:false};
  if(await store.haltedToday()){cycle.status='HALTED_TODAY';await store.insertCycleOnly(finish(cycle,guard,now));return {ok:true,mode:'scan',status:cycle.status};}
  // 1. prices: observer (weight 0) or ticker fallback (weight 2)
  const obs=await store.observerLatest();
  let prices,observedAt,bucket;
  const age=obs?started-ms(obs.observed_at):Infinity;
  try{
    if(age<=OBSERVER_MAX_AGE_MS){prices=observerPrices(obs.liquid_prices);observedAt=ms(obs.observed_at);bucket=ms(obs.observation_bucket);cycle.source='REGIME_OBSERVER';}
    else{prices=tickerPrices(await getJson(guard,'/fapi/v1/ticker/price'));observedAt=now();bucket=Math.floor(observedAt/(5*MIN))*5*MIN;cycle.source='TICKER';}
  }catch(e){cycle.status='NO_PRICES';cycle.errors.push(errText(e));await store.insertCycleOnly(finish(cycle,guard,now));return {ok:false,mode:'scan',status:cycle.status};}
  cycle.observer_age_ms=Number.isFinite(age)?age:null;cycle.observed_at=iso(observedAt);cycle.observation_bucket=iso(bucket);
  if(await store.scanExists(iso(bucket)))return {ok:true,mode:'scan',status:'DUPLICATE_BUCKET',written:false};
  const dayStart=kstDayStart(observedAt),day=kstDay(observedAt);cycle.kst_day=day;
  // 2. KST-day anchor (bootstrap once per day)
  let anchor;
  try{anchor=await anchorFor(store,guard,day,dayStart,now);}catch(e){cycle.errors.push('ANCHOR:'+errText(e));}
  if(!anchor){cycle.status='NO_ANCHOR';await store.insertCycleOnly(finish(cycle,guard,now));return {ok:false,mode:'scan',status:cycle.status};}
  const {ranked,unanchored}=rankUniverse(prices,anchor.prices,anchor.coin_symbols);
  cycle.n_universe=ranked.length;cycle.n_unanchored=unanchored;cycle.rank_order=ranked.map(r=>r.symbol);
  cycle.top50=ranked.slice(0,50).map(r=>({s:r.symbol,r:r.rank,d:+r.dayReturn.toFixed(6)}));
  cycle.detail.anchor={observed_at:anchor.anchor_observed_at,quality:anchor.anchor_quality};
  if(ranked.length<100){cycle.status='UNIVERSE_TOO_SMALL';await store.insertCycleOnly(finish(cycle,guard,now));return {ok:false,mode:'scan',status:cycle.status};}
  // 3. rank history and lanes
  const refs=(await store.historyRefs(iso(observedAt-62.5*MIN),iso(observedAt-12.5*MIN))).map(r=>({observedAt:ms(r.observed_at),rankOrder:r.rank_order}));
  const today=(await store.historyToday(day,iso(observedAt))).map(r=>({observedAt:ms(r.observed_at),top10:r.top10??[]}));
  const rows=classify(ranked,observedAt,{cycles:refs,today});
  cycle.velocity_valid=rows.some(r=>r.velocityValid);
  const recent=await store.recentShortlisted(iso(observedAt-LANE_RULES.cooldownMs));
  const vrTie=await tieBreakVr15(guard,rows,recent,now);
  const {selected,reason}=shortlist(rows,{recentShortlisted:recent,vr15Of:s=>vrTie.get(s)});
  cycle.n_leader=rows.filter(r=>r.lane==='LEADER').length;cycle.n_emerging=rows.filter(r=>r.lane==='EMERGING').length;
  cycle.n_control=rows.filter(r=>r.lane==='CONTROL').length;cycle.n_shortlist=selected.length;
  // 4. precise reads for the shortlist only
  const gptOn=ctl.gpt_enabled===true&&!!apiKey;
  const health=gptOn?await store.gptHealth():null;
  const gate=gptGate({control:ctl,apiKey,health});
  cycle.gpt_state=gate??'ENABLED';
  cycle.arms_active=['RULE_BASELINE','TAKE_ALL',...(gate===null?['GPT_ALT1']:[])];
  const cecRow=selected.length?await store.cec():null;
  const cec=cecRow?{ewma_usdt:Number(cecRow.ewma_usdt),training_count:Number(cecRow.training_count),read_at:iso(now()),
    source_updated_at:cecRow.updated_at?iso(ms(cecRow.updated_at)):null,label:'strategy-wide realized result (production), not about this candidate'}:null;
  const v17Top10=selected.length?await prodTop10(store,observedAt):new Map();
  let btc15=null;
  if(selected.length){try{btc15=await readBtc15(guard,Math.floor(now()/MIN)*MIN);}catch(e){cycle.errors.push('BTC15:'+errText(e));}}
  const btcCache=new Map(),rich=new Map(),decisions=[];
  for(const sym of selected){
    const c=rows.find(r=>r.symbol===sym);c.observedAt=observedAt;
    try{
      const x=await preciseRead(guard,c,{asOf:now(),btc15,btcCache,v17Top10});
      x.snapshotAt=now();x.cec=cec;
      x.soft=softCategories(c,{vr15:x.vr15,costBandBps:x.cost?.cost_band_bps},LANE_RULES,x.snapshotAt);
      rich.set(sym,x);
      const rb=ruleBaseline(c,{vr15:x.vr15,hardBlock:x.hardBlock});
      let quote=null;try{quote=await readQuote(guard,sym,now);}catch(e){x.errors.quote=errText(e);}
      const common={symbol:sym,attempt:1,valid:true,support:[],snapshot_at:iso(x.snapshotAt),answered_at:iso(quote?.at??now()),...entryFields(quote,x)};
      decisions.push({...common,arm:'RULE_BASELINE',decision:rb.decision,reasons:rb.reasons});
      decisions.push({...common,arm:'TAKE_ALL',decision:takeAll().decision,reasons:takeAll().reasons});
      if(gate===null&&cycle.gpt_calls<BUDGET.perCycle){
        if(x.hardBlock.length)decisions.push({...common,arm:'GPT_ALT1',decision:'SKIP_DETERMINISTIC',reasons:x.hardBlock});
        else{
          const packet=buildPacket({candidate:c,rich:x});
          const g=await gptDecision({store,guard,apiKey,now,c,rich:x,packet,snapshotAt:x.snapshotAt});
          if(g.called)cycle.gpt_calls++;
          decisions.push(g.row);
        }
      }
    }catch(e){cycle.errors.push(sym+':'+errText(e));if(guard.state.dayHalt||guard.state.abort)break;}
  }
  // 5. rows (all top30) and one atomic write
  const candidates=rows.map(r=>{
    const x=rich.get(r.symbol),v1=x?.facts?scoreAlternativeEntry({facts:x.facts,model_judgments:{b06133:{factors:x.b06133?.factors},v30:x.v30,cec0040:x.cec}}):null;
    return {observed_at:iso(observedAt),kst_day:day,symbol:r.symbol,lane:r.lane,rank_now:r.rank,rank_15m:r.rank15m,rank_30m:r.rank30m,rank_60m:r.rank60m,
      rank_velocity_15m:r.velocity15,rank_velocity_60m:r.velocity60,velocity_valid:r.velocityValid,minutes_since_kst_midnight:r.minutesSinceMidnight,
      first_top3_today:r.firstTop3Today,leader_reentry_60m:r.leaderReentry60m,first_top10_today:r.firstTop10Today,
      first_top10_at:r.firstTop10At===null?null:iso(r.firstTop10At),minutes_in_top10_today:r.minutesInTop10Today,
      day_return_live:r.dayReturn,obs_price:r.price,shortlisted:selected.includes(r.symbol),selection_reason:reason.get(r.symbol)??'CONTROL',
      vr15:x?.vr15??vrTie.get(r.symbol)??null,v17:x?.v17??null,b06133:x?.b06133??null,v30:x?.v30??null,cec_readonly:x?cec:null,
      facts:x?.facts?{version:x.facts.version,values:x.facts.values,missing:x.facts.missing,quality:x.facts.quality,as_of:iso(x.snapshotAt)}:null,
      micro_complete:x?.facts?.quality?.micro_complete??null,cost:x?.cost??null,soft_categories:x?.soft??null,hard_block:x?.hardBlock??null,
      alt_score_v1:v1,alt_score_v2:x?scoreV2({lane:r.lane,rank:r.rank,velocity15:r.velocity15,velocity60:r.velocity60,vr15:x.vr15,
        dayReturn:r.dayReturn,firstTop10Today:r.firstTop10Today,cost:x.cost}):null,
      read_errors:x&&Object.keys(x.errors).length?x.errors:null};
  });
  finish(cycle,guard,now);
  const w=await store.writeCycle(cycle,candidates,decisions);
  // LE-SHADOW-2 DISCOVERY lane: runs only after the LE-SHADOW-1 cycle is safely written; any V2
  // failure is reported and never touches the V1 record.
  let v2=null;
  if(store2&&w?.cycle_id&&selected.length){
    try{v2=await v2Discovery({store2,guard,apiKey,now,health:apiKey?await store.gptHealth():null,cycleId:w.cycle_id,observedAt,written:w,rows,selected,rich,decisions});}
    catch(e){v2={error:errText(e)};}
  }
  return {ok:true,mode:'scan',v2,status:cycle.status,cycle_id:w?.cycle_id??null,observed_at:cycle.observed_at,source:cycle.source,
    n_universe:cycle.n_universe,lanes:{leader:cycle.n_leader,emerging:cycle.n_emerging,control:cycle.n_control},shortlist:selected,
    top30:rows.map(r=>r.symbol),request_weight:cycle.request_weight,used_weight_max:cycle.used_weight_max,binance_status:cycle.binance_status,
    gpt_state:cycle.gpt_state,gpt_calls:cycle.gpt_calls,decisions:decisions.map(d=>({s:d.symbol,arm:d.arm,d:d.decision})),errors:cycle.errors,orderCalls:0};
}

// ------------------------------------------------------------------------------------ wait
export async function runWait({store,guard,now=Date.now,apiKey=null}){
  const ctl=await store.control();
  if(ctl?.enabled!==true)return {ok:true,mode:'wait',status:'DISABLED'};
  const swept=(await store.sweepExpiredWaits()).length;
  const waits=await store.activeWaits();
  if(!waits.length)return {ok:true,mode:'wait',status:'NO_ACTIVE_WAIT',swept};
  const started=now(),cycle=baseCycle('WAIT',started);
  if(await store.haltedToday()){cycle.status='HALTED_TODAY';await store.insertCycleOnly(finish(cycle,guard,now));return {ok:true,mode:'wait',status:cycle.status};}
  const out=[],health=ctl.gpt_enabled===true&&apiKey?await store.gptHealth():null,gate=gptGate({control:ctl,apiKey,health});
  for(const w of waits.slice(0,5)){
    const spec=w.wait_trigger,snapAt=ms(w.snapshot_at);
    try{
      const [bars,book]=[await getJson(guard,'/fapi/v1/klines',{symbol:w.symbol,interval:'1m',limit:5}),await getJson(guard,'/fapi/v1/depth',{symbol:w.symbol,limit:20})];
      const after=(await store.cyclesAfter(iso(snapAt))).map(r=>({observedAt:ms(r.observed_at),rank:rankIn({rankOrder:r.rank_order},w.symbol)}));
      const ev=evaluateWait({...spec,snapshot_at_ms:snapAt,expires_at_ms:ms(w.wait_expires_at)},{now:now(),bars,book,rankFirst:after[0]??null,rankLatest:after.at(-1)??null});
      if(ev.state==='PENDING'){out.push({d:w.decision_id,state:'PENDING'});continue;}
      const claim=await store.claimWaitEvent({decision_id:w.decision_id,symbol:w.symbol,event:ev.state,at:iso(now()),hyp_price:ev.price??null,detail:{reason:ev.reason,...(ev.detail??{})}});
      if(!claim){out.push({d:w.decision_id,state:'ALREADY_TERMINAL'});continue;}
      out.push({d:w.decision_id,state:ev.state,reason:ev.reason});
      if(ev.state!=='TRIGGERED')continue;
      // (i) mechanical entry at the trigger, (ii) one GPT re-ask with INITIAL/CURRENT/DELTA
      let quote=null;try{quote=await readQuote(guard,w.symbol,now);}catch{/* none */}
      const initial=w.packet??{};
      const mech={candidate_id:w.candidate_id,cycle_id:w.cycle_id,symbol:w.symbol,arm:'WAIT_MECHANICAL',attempt:1,parent_decision_id:w.decision_id,
        decision:'BUY',valid:true,reasons:['WAIT_TRIGGER:'+spec.trigger],support:[],snapshot_at:iso(snapAt),answered_at:iso(now()),
        ...entryFields(quote,{cost:initial.cost})};
      const reask=[];
      if(gate!==null)reask.push({candidate_id:w.candidate_id,cycle_id:w.cycle_id,symbol:w.symbol,arm:'GPT_ALT1',attempt:2,parent_decision_id:w.decision_id,
        decision:'ABSTAIN',valid:false,error:'ALT_GATE:'+gate,reasons:[],support:[],snapshot_at:iso(now()),answered_at:iso(now())});
      else{
        const asOf=now(),{src}=await readSources(w.symbol,asOf,{mode:'LIVE',fetchFn:guard.fetch,ms:3000});
        let facts=null;try{facts=computeFacts(src,{asOf,referenceClose:spec.mid,dayReturn:initial.day_return_live,rank:w.rank_now});}catch{/* ABSTAIN below */}
        const ctx=recheckContext(initial,facts,{price:ev.price,snapshotMid:spec.mid,elapsedMs:asOf-snapAt,trigger:spec.trigger});
        const c={symbol:w.symbol,rank:w.rank_now,observedAt:ms(w.snapshot_at),lane:w.lane};
        const packet={...initial,attempt:2,facts:ctx.current,...ctx};
        const g=await gptDecision({store,guard,apiKey,now,c,rich:{src,facts,cost:initial.cost},packet,snapshotAt:asOf,attempt:2,parent:w.decision_id});
        if(g.called)cycle.gpt_calls++;
        reask.push({...g.row,candidate_id:w.candidate_id,cycle_id:w.cycle_id,wait_trigger:null,wait_expires_at:null});
      }
      await store.insertDecisions([mech,...reask]);
    }catch(e){cycle.errors.push(w.symbol+':'+errText(e));if(guard.state.dayHalt||guard.state.abort)break;}
  }
  cycle.detail={waits:out,swept,gate};
  await store.insertCycleOnly(finish(cycle,guard,now));
  return {ok:true,mode:'wait',status:'OK',waits:out,swept,request_weight:cycle.request_weight,errors:cycle.errors,orderCalls:0};
}

// ------------------------------------------------------------------------------------ outcome
export async function runOutcome({store,store2=null,guard,now=Date.now,limit=20}){
  const ctl=await store.control();
  if(ctl?.enabled!==true)return {ok:true,mode:'outcome',status:'DISABLED'};
  const started=now(),cycle=baseCycle('OUTCOME',started);
  const swept=(await store.sweepExpiredWaits()).length;
  let labeled=0;
  if(!(await store.haltedToday())){
    const due=await store.outcomeDue(iso(started-(KLINE_LIMIT+1)*MIN),limit);
    const rows=[];
    for(const d of due){
      const at=ms(d.hyp_entry_at);
      try{
        const raw=await getJson(guard,'/fapi/v1/klines',{symbol:d.symbol,interval:'1m',startTime:Math.floor(at/MIN)*MIN,limit:KLINE_LIMIT});
        const spread=Number(d.hyp_spread_bps),s600=Number(d.hyp_slip_bps_600),s450=Number(d.hyp_slip_bps_450);
        const beyond=(s)=>d.hyp_slip_bps_600!==null&&Number.isFinite(s)&&Number.isFinite(spread)?Math.max(0,s-spread/2):null;
        const l=labelOutcome({at,price:Number(d.hyp_entry_ask),beyondAskBps:beyond(s600),beyondAskBps450:d.hyp_slip_bps_450===null?null:beyond(s450)},raw);
        rows.push({...l,candidate_id:d.candidate_id,decision_id:d.decision_id,entry_ref:d.entry_ref,hyp_entry_at:iso(at),hyp_entry_price:Number(d.hyp_entry_ask)});
      }catch(e){cycle.errors.push(d.symbol+':'+errText(e));if(guard.state.dayHalt||guard.state.abort)break;}
    }
    if(rows.length)labeled=(await store.insertOutcomes(rows)).length;
  }else cycle.status='HALTED_TODAY_PRECISE_SKIPPED';
  const observer=await store.labelObserver(8),linked=await store.linkProduction(1500);
  // LE-SHADOW-2 outcomes: own guard (cap 60, abort at shared used-weight 1000), never blocks V1 labels
  let v2=null;
  if(store2&&!(await store.haltedToday())){try{v2=await v2Outcome({store2,now});}catch(e){v2={error:errText(e)};}}
  cycle.detail={labeled,observer,linked,swept,v2};
  await store.insertCycleOnly(finish(cycle,guard,now));
  return {ok:true,mode:'outcome',status:cycle.status,labeled,observer,linked,swept,v2,request_weight:cycle.request_weight,errors:cycle.errors,orderCalls:0};
}

// ------------------------------------------------------------------------------------ diagnostic (NO writes)
/** G5: shadow top10 (observer snapshot at each 15m boundary) vs production top10 at that boundary. */
export async function runDiagnostic({store,guard,now=Date.now,hours=3}){
  const t=now(),since=Math.floor((t-hours*3600_000)/M15)*M15;
  const prod=new Map();
  for(const r of await store.prodTop10Since(iso(since)))prod.set(ms(r.signal_close_at),(Array.isArray(r.top10)?r.top10:[]).map(x=>x.symbol));
  const info=await getJson(guard,'/fapi/v1/exchangeInfo');
  const coin=activeSymbols(info,Math.floor(t/M15)*M15).symbols;
  const obs=(await store.observerRange(iso(since),iso(t))).map(r=>({at:ms(r.observed_at),prices:observerPrices(r.liquid_prices)}));
  const anchors=new Map(),out=[];
  for(const [b,top] of [...prod.entries()].sort((a,b)=>a[0]-b[0])){
    const snap=obs.find(o=>o.at>=b&&o.at<b+3*MIN);
    if(!snap||top.length<10)continue;
    const ds=kstDayStart(b-1);
    if(!anchors.has(ds)){const a=await store.observerFirstAfter(iso(ds));anchors.set(ds,a?Object.fromEntries(observerPrices(a.liquid_prices)):null);}
    const anchor=anchors.get(ds);if(!anchor)continue;
    const {ranked}=rankUniverse(snap.prices,anchor,coin),mine=ranked.slice(0,10).map(r=>r.symbol);
    const overlap=mine.filter(s=>top.includes(s)).length/10;
    out.push({boundary:iso(b),observer_at:iso(snap.at),overlap,shadow_top10:mine,production_top10:top});
  }
  const ov=out.map(x=>x.overlap);
  return {ok:true,mode:'diagnostic',writes:0,boundaries:out.length,mean_overlap:ov.length?ov.reduce((a,b)=>a+b,0)/ov.length:null,
    min_overlap:ov.length?Math.min(...ov):null,request_weight:guard.state.weight,used_weight_max:guard.state.usedMax,rows:out};
}
