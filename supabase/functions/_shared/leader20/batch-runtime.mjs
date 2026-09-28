import {buildBatch,callBatch} from './batch.mjs';
import {paidTransport} from './paid-transport.mjs';
import {hash} from '../gpt-final-decision/snapshot-hash.mjs';

export async function batchControl(db){
 const r=await db.from('leader20_batch_control').select('*').eq('singleton',true).maybeSingle();
 if(['42P01','PGRST205'].includes(r.error?.code))return {enabled:false};
 if(r.error||!r.data)throw Error('BATCH_CONTROL_UNAVAILABLE');return r.data;
}
export async function runEntryBatch(db,ctl,{now=Date.now,fetchFn=fetch,apiKey=globalThis.Deno?.env?.get('deepseek api')}={}){
 const capacity=await db.rpc('leader20_batch_capacity');
 if(capacity.error)throw Error('BATCH_CAPACITY_UNAVAILABLE');
 if(capacity.data.available<1){
  const marked=await db.rpc('leader20_batch_note_full');if(marked.error)throw Error('BATCH_CAPACITY_NOTE');
  return {created:false,reason:capacity.data.reason};
 }
 const members=await db.from('leader20_members').select('symbol,rank').eq('epoch_id',ctl.epoch_id).lte('rank',10).order('rank');
 if(members.error)throw Error('BATCH_MEMBERSHIP_READ');
 const at=now();
 const rows=await Promise.all(members.data.map(async m=>{
  try{
   const r=await db.rpc('doa_context_for_role_v1',{p_symbol:m.symbol,p_as_of:new Date(at).toISOString(),p_role:'TRADE_CANDIDATE',p_position_id:null});
   if(r.error)throw Error('CAPTURE_READ');return {...m,capture:r.data};
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
 const done=await db.rpc('leader20_batch_finish',{p_id:batch.id,p_owner:batch.owner,p_result:result});
 if(done.error)throw Error('BATCH_FINISH:'+done.error.message);
 return {...done.data,created:true,batch_id:batch.id};
}
