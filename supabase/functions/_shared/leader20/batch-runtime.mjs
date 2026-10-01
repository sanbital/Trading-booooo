import {clockDecisionWindow,DECISION_RESERVE_MS,EXECUTION_MS} from './clock.mjs';
import {buildBatch,callBatch} from './batch.mjs';
import {paidTransport} from './paid-transport.mjs';
import {hash} from '../gpt-final-decision/snapshot-hash.mjs';

// Production cron/edge jitter can deliver a funded slot after the historical +40s
// reserve boundary. Do not widen the immutable +120s authority: only allow a late
// batch to start when at least this much wall time still remains for capture, model
// review and order safety. 55s admits the observed +52..59s wakes while retaining a
// hard 55s completion budget.
export const CLOCK_BATCH_MIN_REMAINING_MS=55000;
export const CLOCK_BATCH_ADMISSION_MS=EXECUTION_MS-CLOCK_BATCH_MIN_REMAINING_MS;
export function clockBatchAdmissionDeadline(window){
 if(!window)return Infinity;
 const configured=Number(window.decision_reserve_ms);
 const required=Math.min(Number.isFinite(configured)&&configured>0?configured:DECISION_RESERVE_MS,CLOCK_BATCH_MIN_REMAINING_MS);
 return window.decision_deadline_ms-required;
}
const sleepDefault=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function batchOutcome(result,window,extra={}){
 const reason=result.reason??(result.created?'CREATED':'NOT_DUE');
 return {...result,batch_created:result.created===true,batch_reason:result.created?'CREATED':
  reason==='CLOCK_CAPTURE_NOT_READY'?'CAPTURE_NOT_READY':reason==='NO_ENTRY_CAPACITY'?'CAPACITY_ZERO':reason,
  ...(window?{slot_at:new Date(window.slot_ms).toISOString(),capture_start:new Date(window.capture_start_ms).toISOString(),
   capture_end:new Date(window.capture_end_ms).toISOString(),decision_deadline:new Date(window.decision_deadline_ms).toISOString(),
   latest_batch_start:new Date(window.latest_batch_start_ms).toISOString(),batch_admission_deadline:new Date(clockBatchAdmissionDeadline(window)).toISOString(),decision_reserve_ms:window.decision_reserve_ms}:{}),
  capture_ready_count:0,capture_blocked_count:0,available_slots:null,...extra};
}
const pendingCapture=c=>!c||/CAPTURE_READ|INCOMPLETE|MISSING|NOT_READY|INGEST_PENDING|STALE_BUCKET/.test(c.reason??'');
// Why each watched symbol is not READY, so a blocked slot can be diagnosed from its own row.
export function blockedReasons(rows,held=[]){
 const tally={};
 for(const r of rows??[]){
  if(r.capture?.status==='AVAILABLE')continue;
  const key=held?.includes(r.symbol)?'ALREADY_HELD':r.capture?.reason??'CAPTURE_UNAVAILABLE';
  tally[key]=(tally[key]??0)+1;
 }
 return tally;
}

// Closed one-minute candles supply current 1m/5m momentum. The source close
// timestamp travels with the evidence; missing candles remain explicitly unknown.
export async function batchMomentum(symbol,at,fetchFn=fetch){
 try{
  const end=Math.floor(at/60000)*60000-1;
  const r=await fetchFn('https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'6',endTime:String(end)}),
   {signal:AbortSignal.timeout(2000)});
  if(!r.ok)throw Error('HTTP');const rows=await r.json();
  if(!Array.isArray(rows)||rows.length!==6||rows.some((x,i)=>!Number.isFinite(Number(x[4]))||Number(x[4])<=0||
   !Number.isSafeInteger(x[6])||x[6]>at||i>0&&x[6]-rows[i-1][6]!==60000)||at-rows[5][6]>90000)throw Error('CAUSAL_CANDLES');
  return {status:'AVAILABLE',closed_at_ms:rows[5][6],return_1m:Number(rows[5][4])/Number(rows[4][4])-1,
   return_5m:Number(rows[5][4])/Number(rows[0][4])-1};
 }catch{return {status:'UNAVAILABLE',reason:'MOMENTUM_SOURCE_UNAVAILABLE'};}
}

export async function batchControl(db){
 const r=await db.from('leader20_batch_control').select('*').eq('singleton',true).maybeSingle();
 if(['42P01','PGRST205'].includes(r.error?.code))return {enabled:false};
 if(r.error||!r.data)throw Error('BATCH_CONTROL_UNAVAILABLE');return r.data;
}
// Only completion is retried: the paid model call remains outside this loop.
// SQL preserves the first result, owner, original expiry and a 30-second wait cap.
export async function finishEntryBatch(db,batch,result,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let attempt=0;attempt<32;attempt++){
  const done=await db.rpc('leader20_batch_finish',{p_id:batch.id,p_owner:batch.owner,p_result:result});
  if(done.error)throw Error('BATCH_FINISH:'+done.error.message);
  if(done.data?.pending!==true)return done.data;
  if(done.data.reason!=='ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE')throw Error('BATCH_FINISH_UNEXPECTED_PENDING');
  if(attempt===31)return {...done.data,reason:'BATCH_FINISH_RETRY_LIMIT'};
  await sleep(1000);
 }
}
export async function runEntryBatch(db,ctl,{now=Date.now,fetchFn=fetch,sleep=sleepDefault,apiKey=globalThis.Deno?.env?.get('deepseek api')}={}){
 const requested=now();let window=ctl.clock_capture_enabled?clockDecisionWindow(requested):null;
 let stats={capture_ready_count:0,capture_blocked_count:0,available_slots:null,retry_count:0};
 const outcome=r=>batchOutcome(r,window,stats);
 const note=async(data)=>{
  if(!window)return;
  const r=await db.rpc('leader20_clock_note',{p_slot_at:new Date(window.slot_ms).toISOString(),p_data:data});
  if(r.error)throw Error('CLOCK_TELEMETRY:'+r.error.message);
 };
 if(window){
  if(requested>=window.decision_deadline_ms)return outcome({created:false,reason:'DECISION_WINDOW_EXPIRED'});
  const current=await batchControl(db);
  window=clockDecisionWindow(requested,current.decision_reserve_ms??DECISION_RESERVE_MS);
  if(Date.parse(current.last_periodic_slot)>=window.slot_ms)return outcome({created:false,reason:'NOT_DUE'});
  await note({batch_requested_at:new Date(requested).toISOString(),slot_status:'BATCH_WAITING',decision_reserve_ms:window.decision_reserve_ms});
  if(now()>=clockBatchAdmissionDeadline(window)){
   await note({batch_reason:'DECISION_WINDOW_INSUFFICIENT',slot_status:'EXPIRED'});
   return outcome({created:false,reason:'DECISION_WINDOW_INSUFFICIENT'});
  }
 }
 const capacity=await db.rpc('leader20_batch_capacity');
 if(capacity.error)throw Error('BATCH_CAPACITY_UNAVAILABLE');
 const cap=capacity.data??{};
 // `available` is the ACCOUNT's capture/review admission bound; `available_for_new_entry` is how
 // many MORE positions may be opened right now (open positions, live entry orders and slot
 // reservations already taken off). Holding one position never closes the other slots, so the
 // Top10 entry capture is admitted on `available` and only the ORDER count uses the narrower bound.
 const remaining=cap.available_for_new_entry??cap.available;
 Object.assign(stats,{available_slots:remaining,available_slots_before:remaining,
  open_position_count:cap.open_positions??null,reserved_slots:cap.reserved_slots??0,
  futures_available_margin:cap.futures_available_margin??cap.available_quote??null,
  target_margin_per_slot:cap.target_margin_per_slot??null,
  tracked_positions:cap.open_symbols??cap.held??[]});
 if(cap.available<1){
  const marked=await db.rpc('leader20_batch_note_full');if(marked.error)throw Error('BATCH_CAPACITY_NOTE');
  await note({...stats,batch_reason:cap.reason==='NO_ENTRY_CAPACITY'?'CAPACITY_ZERO':cap.reason,slot_status:'BATCH_WAITING'});
  return outcome({created:false,reason:cap.reason});
 }
 // A dead collector and a late capture look identical from here -- ready=0, blocked=10 -- which is
 // how the 2026-09-29 04:33 KST collector outage read as ordinary flakiness for four hours while
 // the retry loop below burned every decision window against streams that did not exist. Ask the
 // transport directly: when it is gone, say so once and stop, instead of retrying up to 160 times.
 const health=await db.rpc('leader20_collector_health');
 if(!health.error&&health.data&&health.data.live!==true){
  stats.collector_reason=health.data.reason??'COLLECTOR_DOWN';
  stats.collector_heartbeat_age_ms=health.data.heartbeat_age_ms??null;
  await note({...stats,batch_reason:stats.collector_reason,slot_status:'EXPIRED'});
  return outcome({created:false,reason:stats.collector_reason});
 }
 const members=await db.from('leader20_members').select('symbol,rank').eq('epoch_id',ctl.epoch_id).lte('rank',Math.min(Number(ctl.watch_limit)||10,10)).order('rank');
 if(members.error)throw Error('BATCH_MEMBERSHIP_READ');
 stats.watch_count=members.data.length;
 let rows,packet;
 for(let attempt=0;attempt<160;attempt++){
  if(window&&now()>=clockBatchAdmissionDeadline(window)){
   await note({...stats,batch_reason:'DECISION_WINDOW_INSUFFICIENT',slot_status:'EXPIRED'});
   return outcome({created:false,reason:'DECISION_WINDOW_INSUFFICIENT'});
  }
  const at=now();
  rows=await Promise.all(members.data.map(async m=>{
  try{
   const r=await db.rpc('doa_context_for_role_v1',{p_symbol:m.symbol,p_as_of:new Date(at).toISOString(),p_role:'TRADE_CANDIDATE',p_position_id:null});
   if(r.error)throw Error('CAPTURE_READ');return {...m,capture:r.data};
  }catch{return {...m,capture:{status:'UNAVAILABLE',reason:'CAPTURE_READ'}};}
  }));
  packet=await buildBatch(rows,{asOf:now(),epochId:ctl.epoch_id,generation:ctl.generation,held:cap.held});
  stats.capture_ready_count=packet.symbols.filter(s=>s.state==='READY').length;
  stats.capture_blocked_count=packet.symbols.length-stats.capture_ready_count;
  stats.blocked_reasons=blockedReasons(rows,cap.held);
  if(!window||stats.capture_ready_count>0&&!rows.some(r=>!cap.held?.includes(r.symbol)&&pendingCapture(r.capture)))break;
  await note({...stats,batch_reason:'CAPTURE_NOT_READY',slot_status:'BATCH_WAITING'});
  const delay=Math.min(1000,250*2**Math.min(attempt,2),clockBatchAdmissionDeadline(window)-now());
  if(delay<=0)continue;
  const before=now();await sleep(delay);stats.retry_count++;
  // A non-advancing injected/test clock cannot create an unbounded live loop.
  if(now()<=before)return outcome({created:false,reason:'CLOCK_CAPTURE_NOT_READY'});
  const current=await batchControl(db);
  if(Date.parse(current.last_periodic_slot)>=window.slot_ms)return outcome({created:false,reason:'NOT_DUE'});
 }
 if(window&&(!stats.capture_ready_count||now()>=clockBatchAdmissionDeadline(window))){
  await note({...stats,batch_reason:'DECISION_WINDOW_INSUFFICIENT',slot_status:'EXPIRED'});
  return outcome({created:false,reason:'DECISION_WINDOW_INSUFFICIENT'});
 }
 const readyAt=now();
 // Momentum is also bounded by T, not shifted to a later minute during retries.
 rows=await Promise.all(rows.map(async r=>({...r,market_context:await batchMomentum(r.symbol,window?.slot_ms??now(),fetchFn)})));
 packet=await buildBatch(rows,{asOf:now(),epochId:ctl.epoch_id,generation:ctl.generation,held:cap.held});
 if(window&&(now()>=clockBatchAdmissionDeadline(window)||packet.symbols.some(s=>s.state==='READY'&&s.entry_window?.slot_ms!==window.slot_ms))){
  await note({...stats,batch_reason:'DECISION_WINDOW_INSUFFICIENT',slot_status:'EXPIRED'});
  return outcome({created:false,reason:'DECISION_WINDOW_INSUFFICIENT'});
 }
 await note({...stats,capture_ready_at:new Date(readyAt).toISOString(),slot_status:'CAPTURE_COMPLETE'});
 const evidence=rows.map(r=>{
  const p=r.capture.trajectory?.slice(-3)??[];
  return [r.symbol,p.at(-1)?.mid??null,p.reduce((n,x)=>n+x.aggressive_buy-x.aggressive_sell,0),p.at(-1)?.imbalance??null];
 });
 // DB compares the evidence; no inference pass-rate or confidence threshold is used.
 const claim=await db.rpc('leader20_batch_claim',{p_packet:{...packet,evidence},p_evidence_key:await hash(evidence),p_strong_change:true});
 if(claim.error)throw Error('BATCH_CLAIM:'+claim.error.message);
 if(!claim.data.created){await note({...stats,batch_reason:claim.data.reason});return outcome(claim.data);}
 const batch=claim.data.row, transport=paidTransport(db,{parentKey:'batch:'+batch.id,purpose:'ENTRY',fetchFn,now});
 const started=await db.rpc('leader20_batch_start',{p_id:batch.id,p_owner:batch.owner});
 if(started.error||!started.data.allowed)return outcome({created:true,batch_id:batch.id,reason:started.data?.reason??'BATCH_DISPATCH_REFUSED'});
 const result=await callBatch(packet,{apiKey,fetchFn:transport,now,
  ...(window?{timeoutMs:Math.max(1,Math.min(20000,window.decision_deadline_ms-now()-15000))}:{})});
 const done=await finishEntryBatch(db,batch,result,{sleep});
 return outcome({...done,created:true,batch_id:batch.id});
}
