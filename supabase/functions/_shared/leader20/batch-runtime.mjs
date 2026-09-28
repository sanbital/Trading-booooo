import {slotFloor} from './clock.mjs';
import {buildBatch,callBatch} from './batch.mjs';
import {paidTransport} from './paid-transport.mjs';
import {hash} from '../gpt-final-decision/snapshot-hash.mjs';

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
export async function runEntryBatch(db,ctl,{now=Date.now,fetchFn=fetch,apiKey=globalThis.Deno?.env?.get('deepseek api')}={}){
 if(ctl.clock_capture_enabled){
  const phase=now()-slotFloor(now());
  if(phase<1000||phase>=30000)return {created:false,reason:'CLOCK_BATCH_NOT_DUE'};
  const current=await batchControl(db);
  if(Date.parse(current.last_periodic_slot)>=slotFloor(now()))return {created:false,reason:'NOT_DUE'};
 }
 const capacity=await db.rpc('leader20_batch_capacity');
 if(capacity.error)throw Error('BATCH_CAPACITY_UNAVAILABLE');
 if(capacity.data.available<1){
  const marked=await db.rpc('leader20_batch_note_full');if(marked.error)throw Error('BATCH_CAPACITY_NOTE');
  return {created:false,reason:capacity.data.reason};
 }
 const members=await db.from('leader20_members').select('symbol,rank').eq('epoch_id',ctl.epoch_id).lte('rank',ctl.clock_capture_enabled?20:10).order('rank');
 if(members.error)throw Error('BATCH_MEMBERSHIP_READ');
 const at=now();
 const rows=await Promise.all(members.data.map(async m=>{
  try{
   const r=await db.rpc('doa_context_for_role_v1',{p_symbol:m.symbol,p_as_of:new Date(at).toISOString(),p_role:'TRADE_CANDIDATE',p_position_id:null});
   if(r.error)throw Error('CAPTURE_READ');return {...m,capture:r.data,market_context:await batchMomentum(m.symbol,at,fetchFn)};
  }catch{return {...m,capture:{status:'UNAVAILABLE',reason:'CAPTURE_READ'}};}
 }));
 const packet=await buildBatch(rows,{asOf:at,epochId:ctl.epoch_id,generation:ctl.generation,held:capacity.data.held});
 const evidence=rows.map(r=>{
  const p=r.capture.trajectory?.slice(-3)??[];
  return [r.symbol,p.at(-1)?.mid??null,p.reduce((n,x)=>n+x.aggressive_buy-x.aggressive_sell,0),p.at(-1)?.imbalance??null];
 });
 // DB compares the evidence; no inference pass-rate or confidence threshold is used.
 const claim=await db.rpc('leader20_batch_claim',{p_packet:{...packet,evidence},p_evidence_key:await hash(evidence),p_strong_change:true});
 if(claim.error)throw Error('BATCH_CLAIM:'+claim.error.message);
 if(!claim.data.created)return claim.data;
 const batch=claim.data.row, transport=paidTransport(db,{parentKey:'batch:'+batch.id,purpose:'ENTRY',fetchFn,now});
 const started=await db.rpc('leader20_batch_start',{p_id:batch.id,p_owner:batch.owner});
 if(started.error||!started.data.allowed)return {created:true,reason:started.data?.reason??'BATCH_DISPATCH_REFUSED'};
 const result=await callBatch(packet,{apiKey,fetchFn:transport,now});
 const done=await finishEntryBatch(db,batch,result);
 return {...done,created:true,batch_id:batch.id};
}
