import {captureDisposition} from './clock.mjs';
import {exchangeMinuteWeight,restWeightLimit,recoveryOrder} from './bootstrap.mjs';
import {Book,Flow,WeightBudget,VERSION,BOOK_STATE,symbolSingleFlight,boundedSnapshotResync,iso,inWindow,streamURLs,normalizeSymbol,transportFresh,closedCandle,btcCandleFields,retireBookCapture,retireMarketCapture,snapshotStillCurrent,completeCaptureInterval,captureBucketDue,invalidateUnusableBook,initialBucketBoundary,controlBackoffMs,controlDisposition} from './core.mjs';
import {randomUUID} from 'node:crypto';
import {summarizeCapture} from './context.mjs';
const endpoint=process.env.CAPTURE_ENDPOINT;
const token=process.env.CAPTURE_TOKEN;
const expected=process.env.PROTOCOL_SHA256;
if(endpoint!=='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest' || !/^[a-f0-9]{64}$/.test(token||'') || !/^[a-f0-9]{64}$/.test(expected||'')) throw Error('INVALID_CONFIG');
const worker_id=randomUUID(), states=new Map(), budget=new WeightBudget(), queue=new Map(), seen=new Map();
let windows=[],deadline=0,lastControl=0,lastWatch=0,lastFlush=0,busyBackfill=false,stop=false,restFailures=0,wsGaps=0,coverageRefreshes=0,backoffUntil=0,bufferDrops=0,resyncSuccesses=0,resyncFailures=0;
// A transport failure is never fatal (see controlDisposition). `signalled` and `crashed` are the
// only states that end the process; `disabled` idles and keeps polling so a re-enable recovers.
let controlFailures=0,controlRetryAt=0,signalled=false,crashed=false,disabled=false,idleSince=0;
let clockWindow=null;
let exchangeWeightLimit=null;
const currentRestLimit=()=>restWeightLimit(clockWindow,[...states.values()],Date.now(),exchangeWeightLimit);
let production=false,universe=new Set(),universeAt=0,unavailableSymbols={};
const boot=Date.now();
const log=(event,extra={})=>console.log(JSON.stringify({event,at:iso(Date.now()),version:VERSION,...extra}));
async function api(action,extra={}){
  let r;
  try{
    r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-doa-capture-token':token},body:JSON.stringify({action,worker_id,...extra}),signal:AbortSignal.timeout(12000)});
  }catch(e){controlFail('NETWORK:'+e.name);throw Error('INGEST_NETWORK');}
  // Only the control plane's own decision stops capture. Anything else is transport.
  if(!r.ok){controlFail('HTTP_'+r.status);throw Error('INGEST_'+r.status);}
  const out=await r.json();
  controlFailures=0;controlRetryAt=0;
  if(!out.enabled&&out.reason!=='LEASE_BUSY'){disabled=true;log('CONTROL_DISABLED',{reason:out.reason});}
  else if(disabled){disabled=false;log('CONTROL_REENABLED');}
  return out;
}
/** Back off, do not die: retry the control plane forever with jittered exponential backoff. */
function controlFail(reason){
  controlFailures++;
  const wait=controlBackoffMs(controlFailures);
  controlRetryAt=Date.now()+wait;
  log('CONTROL_RETRY',{reason,failures:controlFailures,retry_in_ms:wait});
}
async function publicGet(path,weight){
  if(Date.now()<backoffUntil || !budget.claim(weight,Date.now(),currentRestLimit()))return null;
  const r=await fetch('https://fapi.binance.com'+path,{signal:AbortSignal.timeout(8000)});
  // A REST rate limit pauses REST only. WebSocket capture is unaffected and must keep running.
  if(r.status===418 || r.status===429){backoffUntil=Date.now()+Math.max(60000,Number(r.headers.get('retry-after')||60)*1000);log('REST_RATE_LIMIT_PAUSE',{status:r.status,until:iso(backoffUntil)});throw Error('RATE_LIMIT_PAUSE');}
  if(!r.ok)throw Error('PUBLIC_HTTP_'+r.status);
  return await r.json();
}
const PERSIST_QUEUE_CAP=1200;
function enqueue(row){
  const key=row.kind+':'+row.symbol+':'+row.at;if(seen.has(key))return;seen.set(key,Date.now());
  if(queue.size>=PERSIST_QUEUE_CAP){
    let evict=null;
    for(const [oldKey,oldRow] of queue){
      if(!states.get(oldRow.symbol)?.roles?.includes('OPEN_POSITION')){evict=oldKey;break;}
    }
    evict??=queue.keys().next().value??null;
    if(evict!==null){queue.delete(evict);bufferDrops++;log('PERSIST_QUEUE_EVICT',{buffer_dropped_rows:bufferDrops,queue_cap:PERSIST_QUEUE_CAP});}
  }
  queue.set(key,row);
}
function connect(symbol,candles){
  const now=Date.now();
  // Only the first timer anchor uses the grid. Actual connection/sync times still
  // invalidate its partial interval; every later interval uses its real end.
  const s={symbol,candles,book:new Book(),flow:new Flow(),ring:[],socket:null,marketSocket:null,started:now,lastBucket:initialBucketBoundary(now),marketResetAt:now,marketSequenceVerified:true,bookGeneration:0,lastTradeAt:0,lastCandle:null,needBackfill:candles,bookReconnectAt:0,marketReconnectAt:0,derivatives:{fundingRate:null,markPrice:null,indexPrice:null,basisBps:null,markEventAt:0,markReceivedAt:0,nextFundingTime:null,openInterest:null,openInterestAt:0,openInterestReceivedAt:0,lastOiPollAt:0}};
  states.set(symbol,s);openSocket(s);return s;
}
function resyncTelemetry(s,success,failureReason=null,completedAt=Date.now(),bufferedCount=s.book.buffer.length){
  const active=s.activeResync??{},incident=active.incident??s.book.lastIncident??{};
  const row={symbol:s.symbol,gap_detected_at:Number.isSafeInteger(incident.gap_detected_at)?iso(incident.gap_detected_at):null,
    reason:incident.reason??'INITIAL_SNAPSHOT',previous_last_update_id:incident.previous_last_update_id??null,
    incoming_first_update_id:incident.incoming_first_update_id??null,incoming_final_update_id:incident.incoming_final_update_id??null,
    snapshot_last_update_id:active.snapshot_last_update_id??null,
    resync_started_at:Number.isSafeInteger(active.started_at)?iso(active.started_at):null,
    resync_completed_at:success?iso(completedAt):null,
    resync_duration_ms:Number.isSafeInteger(active.started_at)?Math.max(0,completedAt-active.started_at):null,
    buffered_event_count:bufferedCount,recovery_success:success,recovery_failure_reason:failureReason};
  s.lastResyncTelemetry=row;s.activeResync=null;
  if(success){resyncSuccesses++;s.resyncFailures=0;log('BOOK_RESYNC_COMPLETED',row);}
  else{resyncFailures++;s.resyncFailures=(s.resyncFailures??0)+1;log('BOOK_RESYNC_FAILED',row);}
  return row;
}
function noteBookOutcome(s,outcome){
  if(outcome?.status===BOOK_STATE.SYNCED&&outcome.resync_completed_at&&s.activeResync)
    resyncTelemetry(s,true,null,outcome.resync_completed_at,outcome.buffered_event_count);
  else if(outcome?.status===BOOK_STATE.UNSYNCED&&outcome.resync&&s.activeResync){
    resyncTelemetry(s,false,outcome.reason??outcome.incident?.reason??'RESYNC_SEQUENCE_FAILED');
    s.resyncRetryAt=Date.now()+Math.min(5000,500*2**Math.min(s.resyncFailures??0,4));
  }
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function resyncSymbol(s){
  if(s.resyncPromise||s.book.state===BOOK_STATE.SYNCED||s.socket?.readyState!==WebSocket.OPEN||Date.now()<(s.resyncRetryAt??0))return s.resyncPromise??false;
  const generation=s.bookGeneration,socket=s.socket,started=Date.now(),incident={...(s.book.lastIncident??{})};
  s.book.beginResync(started);s.activeResync={started_at:started,incident,snapshot_last_update_id:null};
  log('BOOK_RESYNC_STARTED',{symbol:s.symbol,gap_detected_at:Number.isSafeInteger(incident.gap_detected_at)?iso(incident.gap_detected_at):null,
    reason:incident.reason??'INITIAL_SNAPSHOT',previous_last_update_id:incident.previous_last_update_id??null,
    incoming_first_update_id:incident.incoming_first_update_id??null,incoming_final_update_id:incident.incoming_final_update_id??null,
    resync_started_at:iso(started),single_flight:true});
  return symbolSingleFlight(s,async()=>{
    const result=await boundedSnapshotResync({
      fetchSnapshot:()=>publicGet('/fapi/v1/depth?symbol='+s.symbol+'&limit=1000',20),
      stillCurrent:()=>snapshotStillCurrent(s,generation,socket),sleep:pause,
      applySnapshot:snap=>{s.depthSnapshots=(s.depthSnapshots??0)+1;s.activeResync.snapshot_last_update_id=+snap.lastUpdateId;
        return s.book.snapshot(snap,Date.now());}
    });
    if(result.stale_generation)return false;
    if(result.ok){if(result.outcome.status===BOOK_STATE.SYNCED)noteBookOutcome(s,result.outcome);return true;}
    if(snapshotStillCurrent(s,generation,socket)){
      s.book.failResync(result.failure_reason);restFailures++;resyncTelemetry(s,false,result.failure_reason);
      s.resyncRetryAt=Date.now()+Math.min(5000,500*2**Math.min(s.resyncFailures??0,4));
    }
    return false;
  });
}
function openSocket(s){
  const urls=streamURLs(s.symbol);
  if(!s.socket){
    s.book.reset();s.bookGeneration++;s.started=Date.now();
    const ws=new WebSocket(urls.book);s.socket=ws;
    const retire=()=>{if(s.socket!==ws)return;s.socket=null;retireBookCapture(s,Date.now());ws.close();};
    ws.addEventListener('message',msg=>{let eventIds;try{
      if(s.socket!==ws)return;
      const e=JSON.parse(msg.data).data,now=Date.now();
      if(!e || (e.st!==undefined && +e.st!==1) || e.s && e.s!==s.symbol)return;
      eventIds={U:e.U,u:e.u,pu:e.pu,previous_u:s.book.last,event_ms:e.E,received_ms:now};
      if(!transportFresh(e,now))throw Error('TRANSPORT_EVENT_STALE_OR_FUTURE');
      if(e.e==='depthUpdate'){
        const outcome=s.book.event(e,now);noteBookOutcome(s,outcome);
        if(outcome?.resync&&outcome.incident){wsGaps++;s.resyncRetryAt=0;
          log('STREAM_GAP',{symbol:s.symbol,stream:'book',reason:outcome.incident.reason,event_ids});void resyncSymbol(s);}
      }
    }catch(e){wsGaps++;retire();log('STREAM_GAP',{symbol:s.symbol,stream:'book',reason:e.message,event_ids:eventIds});}});
    ws.addEventListener('error',retire);ws.addEventListener('close',retire);
  }
  if(!s.marketSocket){
    const marketWs=new WebSocket(urls.market);s.marketSocket=marketWs;
    const retire=()=>{if(s.marketSocket!==marketWs)return;s.marketSocket=null;retireMarketCapture(s,Date.now());marketWs.close();};
    marketWs.addEventListener('message',msg=>{let eventIds;try{
    if(s.marketSocket!==marketWs)return;
    const e=JSON.parse(msg.data).data;const now=Date.now();
    if(!e || (e.st!==undefined && +e.st!==1) || e.s && e.s!==s.symbol)return;
    eventIds={aggregate_id:e.a,previous_aggregate_id:s.flow.last,event_ms:e.E,trade_ms:e.T,received_ms:now};
    if(!transportFresh(e,now))throw Error('TRANSPORT_EVENT_STALE_OR_FUTURE');
    if(e.e==='markPriceUpdate'){
      const mark=Number(e.p),index=Number(e.i),funding=Number(e.r),eventAt=Number(e.E),nextFunding=Number(e.T);
      if(Number.isFinite(mark)&&mark>0&&Number.isFinite(index)&&index>0&&Number.isFinite(funding)&&Number.isSafeInteger(eventAt)){
        s.derivatives={...s.derivatives,markPrice:mark,indexPrice:index,basisBps:(mark/index-1)*10000,fundingRate:funding,markEventAt:eventAt,markReceivedAt:now,nextFundingTime:Number.isSafeInteger(nextFunding)?nextFunding:null};
      }
    }
    if(e.e==='aggTrade'){
      const previous=s.flow.last;
      s.flow.event(e,now);
      if(!s.marketSequenceVerified && previous!==null && +e.a===previous+1)s.marketSequenceVerified=true;
      s.lastTradeAt=now;
    }
    if(e.e==='forceOrder')s.flow.liquidation+=Number(e.o.ap||e.o.p)*Number(e.o.z);
    if(e.e==='kline' && e.k.x){const k=e.k;s.lastCandle=closedCandle(e,now);if(s.candles&&captureDisposition(s.roles,clockWindow,now).persist)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k.t),payload:{open:+k.o,high:+k.h,low:+k.l,close:+k.c,quote_volume:+k.q,taker_buy_quote:+k.Q,exchange_at:iso(+e.E),available_at:iso(now),source:'WS_CLOSED',complete:true}});}
    }catch(e){wsGaps++;retire();log('STREAM_GAP',{symbol:s.symbol,stream:'market',reason:e.message,event_ids:eventIds});}});
    marketWs.addEventListener('error',retire);marketWs.addEventListener('close',retire);
  }
}
async function watch(){
  const out=await api('watch');if(stop)return;
  if(out.reason==='LEASE_BUSY'){log('LEASE_WAIT');return false;}
  if(out.protocol_sha256!==expected)throw Error('PROTOCOL_MISMATCH');
  clockWindow=out.entry_window??null;
  deadline=Date.parse(out.ends_at);lastControl=Date.now();windows=out.windows;production=out.production_enabled===true;
  if(Date.now()-universeAt>900000){
    const info=await publicGet('/fapi/v1/exchangeInfo',1);
    if(info?.symbols){universe=new Set(info.symbols.filter(x=>x.status==='TRADING'&&x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT').map(x=>x.symbol));universeAt=Date.now();exchangeWeightLimit=exchangeMinuteWeight(info);}
    if(!universe.size)throw Error('ACTIVE_UNIVERSE_UNAVAILABLE');
  }
  unavailableSymbols={};
  const desired=new Map(out.watch.map(x=>({...x,symbol:normalizeSymbol(x.symbol)})).filter(x=>{
    if(x.symbol&&universe.has(x.symbol))return captureDisposition(x.roles,clockWindow,Date.now()).connect;
    unavailableSymbols[x.symbol??'INVALID']='NOT_ACTIVE_USDM_PERPETUAL';return false;
  }).map(x=>[x.symbol,x]));
  for(const [symbol,s] of states)if(!desired.has(symbol)){s.socket?.close();s.marketSocket?.close();states.delete(symbol);}
  for(const w of desired.values()){
    if(!normalizeSymbol(w.symbol))continue;
    const s=states.get(w.symbol)||connect(w.symbol,w.candles);
    if(w.candles && !s.candles)s.needBackfill=true;s.candles=w.candles;s.roles=w.roles??[];
  }
  for(const s of states.values())for(const row of s.ring)if((production||inWindow(Date.parse(row.at),windows,s.symbol))&&captureDisposition(s.roles,clockWindow,Date.parse(row.at)).persist)enqueue(row);
}
async function recover(){
  if(stop)return;const now=Date.now(),ordered=recoveryOrder(states.values());
  for(const s of ordered){
    if(s.socket?.readyState!==WebSocket.OPEN)continue;
    if(s.book.needsStaleResync(now)){
      const lastReceived=s.book.received;
      const outcome=s.book.markUnsynced('DEPTH_EVENT_STALE',null,now);
      log('STREAM_STALE',{symbol:s.symbol,stream:'book',last_received_at:lastReceived?iso(lastReceived):null});noteBookOutcome(s,outcome);
    }
    if(s.book.state===BOOK_STATE.SYNCED&&s.book.needsCoverageRefresh(now)){
      const outcome=s.book.markUnsynced('DEPTH_COVERAGE_STALE',null,now);coverageRefreshes++;
      log('COVERAGE_BOUNDARY_RESYNC',{symbol:s.symbol});noteBookOutcome(s,outcome);
    }
    const bridgeStarted=s.book.snapshotLoaded?s.book.snapshotAt:s.book.resyncStartedAt;
    if(s.book.state===BOOK_STATE.RESYNCING&&now-(bridgeStarted??now)>3000&&!s.resyncPromise){
      s.book.failResync('SNAPSHOT_BRIDGE_TIMEOUT');
      if(s.activeResync)resyncTelemetry(s,false,'SNAPSHOT_BRIDGE_TIMEOUT');
      s.resyncRetryAt=now+500;
    }
    if(s.book.state===BOOK_STATE.UNSYNCED)void resyncSymbol(s);
  }
  // Open interest has no USD-M market websocket stream. Poll at low frequency and
  // keep it observational: failure never invalidates the core order-book/flow capture.
  for(const s of ordered){
    if(s.symbol==='BTCUSDT'&&!s.roles?.includes('OPEN_POSITION'))continue;
    if(s.book.state!==BOOK_STATE.SYNCED||now-(s.derivatives?.lastOiPollAt??0)<30000)continue;
    try{
      const oi=await publicGet('/fapi/v1/openInterest?symbol='+s.symbol,1);
      if(!oi)break;
      const value=Number(oi.openInterest),exchangeAt=Number(oi.time),receivedAt=Date.now();
      if(Number.isFinite(value)&&value>=0){
        s.derivatives.openInterest=value;s.derivatives.openInterestAt=Number.isSafeInteger(exchangeAt)?exchangeAt:receivedAt;
        s.derivatives.openInterestReceivedAt=receivedAt;s.derivatives.lastOiPollAt=receivedAt;
      }
    }catch(e){restFailures++;log('OPEN_INTEREST_RECOVERY_ERROR',{symbol:s.symbol,reason:e.message});}
    break;
  }
  if(busyBackfill)return;busyBackfill=true;
  try{
    for(const s of ordered)if(s.needBackfill&&captureDisposition(s.roles,clockWindow,Date.now()).persist){
      const rows=await publicGet('/fapi/v1/klines?symbol='+s.symbol+'&interval=1m&limit=65',2);if(rows){for(const k of rows)if(+k[6]<Date.now() && +k[0]>=boot-120000)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k[0]),payload:{open:+k[1],high:+k[2],low:+k[3],close:+k[4],quote_volume:+k[7],taker_buy_quote:+k[10],available_at:iso(Date.now()),source:'REST_CLOSED_BACKFILL',complete:true}});s.needBackfill=false;}return;
    }
  }catch(e){restFailures++;log('RECOVERY_ERROR',{reason:e.message});}finally{busyBackfill=false;}
}
function bucket(now){
  let emitted=false;
  for(const [key,t] of seen)if(now-t>600000)seen.delete(key);
  const btc=states.get('BTCUSDT')?.lastCandle;
  for(const s of states.values()){
    if(!captureBucketDue(s.lastBucket,now))continue;
    const m=s.book.metrics(now),flow=s.flow.metrics(now);
    const invalid=invalidateUnusableBook(s.book,m,now);
    if(invalid){log('BOOK_INTEGRITY_RESYNC',{symbol:s.symbol,reason:m.reason});noteBookOutcome(s,invalid);void resyncSymbol(s);}
    const full=completeCaptureInterval(s,now,s.marketSocket?.readyState===WebSocket.OPEN);
    const d=s.derivatives??{},markFresh=Number.isSafeInteger(d.markReceivedAt)&&now-d.markReceivedAt<=5000,oiFresh=Number.isSafeInteger(d.openInterestReceivedAt)&&now-d.openInterestReceivedAt<=45000;
    const derivativePayload={funding_rate:markFresh&&Number.isFinite(d.fundingRate)?d.fundingRate:null,mark_price:markFresh&&Number.isFinite(d.markPrice)?d.markPrice:null,index_price:markFresh&&Number.isFinite(d.indexPrice)?d.indexPrice:null,
      basis_bps:markFresh&&Number.isFinite(d.basisBps)?d.basisBps:null,mark_event_at:markFresh?iso(d.markEventAt):null,mark_received_at:markFresh?iso(d.markReceivedAt):null,next_funding_at:markFresh&&Number.isSafeInteger(d.nextFundingTime)?iso(d.nextFundingTime):null,
      open_interest:oiFresh&&Number.isFinite(d.openInterest)?d.openInterest:null,open_interest_at:oiFresh?iso(d.openInterestAt):null,open_interest_received_at:oiFresh?iso(d.openInterestReceivedAt):null};
    const row={kind:'micro',symbol:s.symbol,at:iso(Math.floor(now/5000)*5000),payload:{...m,...flow,...derivativePayload,available_at:iso(now),interval_start:iso(s.lastBucket),interval_end:iso(now),interval_ms:now-s.lastBucket,
      bucket_complete:full && m.book_complete && flow.trade_sequence_complete && flow.flow_causal,
      ...btcCandleFields(btc,now),watch_roles:s.roles??[],sector_return_1m:null,sector_map_version:null,maker_fee_bps:null,taker_fee_bps:null,funding_cashflow:null,
      source:'BINANCE_USDM_DIFF_AGGTRADE',version:VERSION}};
    s.lastBucket=now;s.ring.push(row);s.ring=s.ring.filter(x=>Date.parse(x.at)>=now-240000);
    if((production||inWindow(Date.parse(row.at),windows,s.symbol))&&captureDisposition(s.roles,clockWindow,now).persist)enqueue(row);
    s.book.add=0;s.book.remove=0;s.book.bidAdd=0;s.book.bidRemove=0;s.flow.reset();
    emitted=true;
  }
  return emitted;
}
let pending=null;
async function flush(){
  if(!pending){
    const selected=[];let size=0;
    for(const [k,row] of [...queue].sort((a,b)=>Number(!states.get(a[1].symbol)?.roles?.includes('OPEN_POSITION'))-Number(!states.get(b[1].symbol)?.roles?.includes('OPEN_POSITION')))){const bytes=Buffer.byteLength(JSON.stringify(row));if(selected.length>=300||size+bytes>350000)break;selected.push([k,row]);size+=bytes;}
    pending={batch_id:randomUUID(),rows:selected.map(x=>x[1]),metrics:{version:VERSION,source_commit:process.env.SOURCE_COMMIT??null,watched:states.size,synced:[...states.values()].filter(s=>s.book.state===BOOK_STATE.SYNCED).length,trade_streams_seen:[...states.values()].filter(s=>s.lastTradeAt>0).length,candle_streams_seen:[...states.values()].filter(s=>s.lastCandle!==null).length,mark_streams_seen:[...states.values()].filter(s=>s.derivatives?.markReceivedAt>0).length,open_interest_seen:[...states.values()].filter(s=>s.derivatives?.openInterestReceivedAt>0).length,queue:queue.size,buffer_dropped_rows:bufferDrops,queue_cap:PERSIST_QUEUE_CAP,ws_gaps:wsGaps,coverage_refreshes:coverageRefreshes,rest_failures:restFailures,resync_successes:resyncSuccesses,resync_failures:resyncFailures,rss_bytes:process.memoryUsage().rss,last_bucket_at:iso(Date.now()),order_calls:0,llm_calls:0}};
    pending.metrics.live_contexts=Object.fromEntries([...states].map(([symbol,s])=>[symbol,summarizeCapture(s.ring,Date.now())]));
    pending.metrics.watch_roles=Object.fromEntries([...states].map(([symbol,s])=>[symbol,s.roles??[]]));
    pending.metrics.unavailable_symbols=unavailableSymbols;
    // Persistence is continuous whenever production_enabled is true, even while a clock
    // window is present. The previous telemetry incorrectly reported false in that case.
    pending.metrics.production_continuous=production;
    pending.metrics.clock_window_active=!!clockWindow;
    pending.metrics.entry_window=clockWindow;
    pending.metrics.rest_weight_limit=currentRestLimit();
    pending.metrics.exchange_weight_limit=exchangeWeightLimit;
    pending.metrics.rest_weight_used_60s=budget.used.filter(x=>x[0]>Date.now()-60000).reduce((sum,x)=>sum+x[1],0);
    pending.metrics.depth_snapshots=Object.fromEntries([...states].map(([symbol,s])=>[symbol,s.depthSnapshots??0]));
    pending.metrics.book_states=Object.fromEntries([...states].map(([symbol,s])=>[symbol,s.book.state]));
    pending.metrics.book_resync=Object.fromEntries([...states].filter(([,s])=>s.lastResyncTelemetry).map(([symbol,s])=>[symbol,s.lastResyncTelemetry]));
    for(const [k] of selected)queue.delete(k);
  }
  const out=await api('ingest',pending);lastControl=Date.now();pending=null;
  log('HEARTBEAT',{watched:states.size,synced:[...states.values()].filter(s=>s.book.ready).length,queue:queue.size,inserted:out.inserted||0,bytes:out.bytes_reserved});
}
process.on('SIGTERM',()=>{signalled=true;stop=true;});process.on('SIGINT',()=>{signalled=true;stop=true;});
// A rolling release waits for the previous worker's DB lease; it never steals it. An Edge outage
// at startup used to end the process here after two minutes, which with `--restart no --rm`
// destroyed the machine. Wait indefinitely instead, with the same jittered backoff.
for(let attempt=1;!signalled&&!deadline;attempt++){
  try{await watch();}catch(e){log('CONTROL_ERROR',{reason:e.message,phase:'START'});}
  if(deadline||signalled)break;
  await new Promise(r=>setTimeout(r,Math.max(5000,controlBackoffMs(Math.min(attempt,16)))));
}
let watchTask=null,flushTask=null,bucketFlushDue=false;
log('STARTED',{worker_id,protocol_sha256:expected,deadline:iso(deadline)});
const timer=setInterval(()=>{
  const now=Date.now();
  // A lost control plane is a DEGRADED state, not a death sentence: the 90-second exit here,
  // with `--restart no --rm` on the machine, is what turned a brief Edge outage into hours of
  // blindness. Only a signal, a crash or the resource cap ends the process now.
  const decided=controlDisposition({stopped:now-lastControl>90000,signalled,crashed,disabled,
    pastDeadline:deadline>0&&now>=deadline,
    overResourceCap:process.memoryUsage().rss>230000000||(!production&&now-boot>14*86400000)});
  if(decided.action==='exit'){
    clearInterval(timer);for(const s of states.values()){s.socket?.close();s.marketSocket?.close();}
    // Normal release must not leave the replacement worker blind behind the 90s
    // crash-recovery lease. Ownership is checked server-side; a stale worker cannot
    // release another collector's lease.
    void api('release').then(x=>log('LEASE_RELEASED',{released:x.released===true}))
      .catch(e=>log('LEASE_RELEASE_FAILED',{reason:e.message}));
    log('STOPPED',{reason:decided.reason});setTimeout(()=>process.exit(decided.code),1500);return;}
  if(decided.action==='idle'){
    // Hold no streams and persist nothing, but keep asking: authority can come back.
    if(!idleSince){idleSince=now;for(const [symbol,st] of states){st.socket?.close();st.marketSocket?.close();states.delete(symbol);}
      queue.clear();pending=null;log('IDLE',{reason:decided.reason});}
    if(!watchTask&&now>=controlRetryAt&&now-lastWatch>=5000){
      lastWatch=now;watchTask=watch().catch(e=>log('CONTROL_ERROR',{reason:e.message,phase:'IDLE'})).finally(()=>{watchTask=null;});}
    return;}
  if(idleSince){log('RESUMED',{idle_ms:now-idleSince});idleSince=0;}
  try{
    if(bucket(now))bucketFlushDue=true;
    // Disconnect candidate streams locally at the boundary; do not wait for the next watch poll.
    for(const [symbol,s] of states)if(!captureDisposition(s.roles,clockWindow,now).connect){
      s.socket?.close();s.marketSocket?.close();states.delete(symbol);
    }
    for(const s of states.values())if((!s.socket && now>=s.bookReconnectAt)||(!s.marketSocket && now>=s.marketReconnectAt))openSocket(s);
    void recover();
    if(!watchTask&&now>=controlRetryAt&&now-lastWatch>=15000){lastWatch=now;watchTask=watch().catch(e=>log('CONTROL_ERROR',{reason:e.message})).finally(()=>{watchTask=null;});}
    // Keep one in-flight ingest; a newly closed bucket must not wait for an unrelated timer phase.
    if(!flushTask&&now>=controlRetryAt&&((production&&bucketFlushDue)||now-lastFlush>=(production?5000:15000))){bucketFlushDue=false;lastFlush=now;flushTask=flush().catch(e=>log('CONTROL_ERROR',{reason:e.message})).finally(()=>{flushTask=null;});}
  }catch(e){log('FATAL',{reason:e.message});crashed=true;}
},200);
