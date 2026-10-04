import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {scenario} from './fixtures.mjs';
import {classifyMarket,revalidateEntry} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
import {entryEvidence,cancellationCategory} from '../../supabase/functions/_shared/deterministic/entry-evidence.mjs';
test('exchange dependency failures remain distinct from healthy market cancellations',()=>{
 for(const reason of ['GW_429:Too many requests','GW_418:IP banned','GW_503:exchange unavailable','GW_504:timed out','The signal has been aborted','GW_400:This operation was aborted'])assert.equal(cancellationCategory(reason,{decision:'WAIT',gates:{data:true}}),'DATA_UNAVAILABLE');
 assert.equal(cancellationCategory('ANALYSIS_HEARTBEAT_FAILED'),'AUTHORITY_OR_STATE');
 assert.equal(cancellationCategory('GW_503:WRITER_FENCED'),'AUTHORITY_OR_STATE');
 assert.equal(cancellationCategory('CURRENT_MARKET_THESIS_CANCELLED',{decision:'WAIT',gates:{data:true}}),'MARKET_CANCEL');
});
const sql=fs.readFileSync(new URL('../../supabase/migrations/20261003232458_deterministic_submission_boundary.sql',import.meta.url),'utf8');
const owner='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const pg=new PGlite();await pg.exec(fs.readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
 await pg.exec(fs.readFileSync(new URL('capacity-baseline.sql',import.meta.url),'utf8'));
 await pg.exec(fs.readFileSync(new URL('../../supabase/migrations/20261002102500_deterministic_dynamic_state.sql',import.meta.url),'utf8'));
 await pg.exec('alter table v11_long_regime_positions add column signal_id uuid;alter table v11_long_regime_signals add column reject_reason text');
 await pg.exec('create table v17_analysis_lease(singleton boolean,owner uuid,expires_at timestamptz,postmaster_started_at timestamptz)');await pg.exec(sql);await pg.exec(fs.readFileSync(new URL('../../supabase/migrations/20261003235512_deterministic_terminal_claim_cleanup.sql',import.meta.url),'utf8'));
 await pg.exec(fs.readFileSync(new URL('../../supabase/migrations/20261004002152_deterministic_submit_refusal_evidence.sql',import.meta.url),'utf8'));
 await pg.exec('update deterministic_control set enabled=true');
 const publish=async(symbol='TESTUSDT')=>{const t=Date.now(),members=Array.from({length:20},(_,i)=>({symbol:i===0?symbol:'S'+i+'USDT',rank:i+1,price_change_percent:20-i,quote_volume:1e8}));return (await pg.query('select deterministic_publish_universe($1,$2) r',[{members,requested_at:new Date(t).toISOString(),observed_at:new Date(t).toISOString(),next_refresh_at:new Date(t+60000).toISOString()},'a'.repeat(64)])).rows[0].r;};
 await publish();const t=Date.now(),state={version:'DETERMINISTIC_DYNAMIC_STATE_1',decision:'BUY',setup:'PASS',confirmation:'PASS',trigger:'BREAKOUT',at:t,capture_end_ms:t};
 const sig=(await pg.query("select deterministic_candidate('TESTUSDT',$1,$2) r",[t,{deterministic:{version:state.version,generation:1,decision:state}}])).rows[0].r.id;
 await pg.query("insert into v17_execution_lease values(true,$1,1,clock_timestamp()+interval '150 seconds',pg_postmaster_start_time())",[owner]);
 const command={exchange:'binance_futures',action:'create_order',leverage:3,order:{market:'TESTUSDT',side:'BUY',type:'LIMIT',price:100,quantity:4.5,identifier:'same-order',position_effect:'OPEN',position_side:'LONG',time_in_force:'IOC'}};
 const order=(await pg.query("insert into v11_long_regime_orders(symbol,state,signal_id,intent,client_order_id,requested_quantity,request_payload) values('TESTUSDT','PLANNED',$1,'OPEN_LONG','same-order',4.5,$2) returning id",[sig,{...command,deterministic:{version:state.version},entry_ioc_attempt:1}])).rows[0].id;
 await pg.query("insert into leader20_entry_reservations(symbol,signal_id,state,expires_at) values('TESTUSDT',$1,'RESERVED',clock_timestamp()+interval '2 minutes')",[sig]);
 const submit=async()=> (await pg.query('select deterministic_begin_submit($1,$2,$3) r',[order,owner,{...state,at:Date.now(),capture_end_ms:Date.now()}])).rows[0].r;
 let proof=await submit();
 const auth=async(c=command,o=owner,fence=1,key=proof.proof.execution_key)=>(await pg.query('select v17_gateway_authorize_evidence($1,$2,$3,$4,$5) r',[key,'binance_futures:futures',o,fence,c])).rows[0].r;
 return {pg,sig,order,command,publish,submit,auth,setProof:p=>proof=p};
}
test('exact BUY payload, canonical hash, owner/fence and database restart are fenced',async()=>{
 const f=await fixture();try{
  assert.equal((await f.auth()).allowed,true);
  const reordered={order:f.command.order,leverage:3,action:'create_order',exchange:'binance_futures'};assert.equal((await f.auth(reordered)).allowed,true);
  assert.equal((await f.auth({...f.command,order:{...f.command.order,price:101}})).reason,'ORDER_PAYLOAD_MISMATCH');
  assert.equal((await f.auth(f.command,owner,2)).reason,'WRITER_OWNER_OR_FENCE_MISMATCH');
  assert.equal((await f.auth(f.command,owner,1,'a'.repeat(64))).reason,'SUBMISSION_PAYLOAD_HASH_MISMATCH');
  await f.pg.exec("update v17_execution_lease set postmaster_started_at=pg_postmaster_start_time()-interval '1 minute'");assert.equal((await f.auth()).reason,'WRITER_RESTART_FENCED');
  await f.pg.exec('update v17_execution_lease set postmaster_started_at=pg_postmaster_start_time(),fence=2');
  assert.equal((await f.auth(f.command,owner,2)).reason,'SUBMISSION_OWNER_OR_GENERATION_MISMATCH');
  f.setProof(await f.submit());assert.equal((await f.auth(f.command,owner,2)).allowed,true);
  assert.equal((await f.pg.query('select v17_release_writer($1,1) r',[owner])).rows[0].r,false,'old cleanup cannot release the new fence');
 }finally{await f.pg.close();}
});
test('expired submission is refused, refreshed same identity is allowed, capture/generation/membership stay strict',async()=>{
 const f=await fixture();try{
  await f.pg.query("update v11_long_regime_orders set response_payload=jsonb_set(response_payload,'{deterministic_submission,submitted_at}',to_jsonb(clock_timestamp()-interval '4 seconds')) where id=$1",[f.order]);
  assert.equal((await f.auth()).reason,'SUBMISSION_EVIDENCE_EXPIRED');f.setProof(await f.submit());assert.equal((await f.auth()).allowed,true);
  await f.publish();assert.equal((await f.auth()).allowed,true,'continuing member survives atomic epoch replacement');
  await f.publish('LEFTUSDT');assert.equal((await f.auth()).reason,'TOP20_LEFT_UNIVERSE');
  await f.pg.exec("update leader20_epochs set next_refresh_at=clock_timestamp()-interval '1 second'");assert.equal((await f.auth()).reason,'TOP20_REFRESH_DELAY');
  await f.publish();await f.pg.exec('update deterministic_control set generation=2');assert.equal((await f.auth()).reason,'ENGINE_GENERATION_MISMATCH');
 }finally{await f.pg.close();}
});
test('orphan CLAIMED recovery releases only unsent claims and never uncertain orders or live workers',async()=>{
 const f=await fixture();try{
  await f.pg.query("update v11_long_regime_signals set status='CLAIMED',updated_at=clock_timestamp()-interval '10 minutes' where id=$1",[f.sig]);
  assert.deepEqual((await f.pg.query('select deterministic_recover_claims() r')).rows[0].r.recovered,[],'durable intent requires existing-order reconciliation');
  await f.pg.query('delete from v11_long_regime_orders where id=$1',[f.order]);
  await f.pg.query("update v11_long_regime_signals set features=jsonb_set(features,'{executionClaim}',jsonb_build_object('analysis_owner',$2::text)) where id=$1",[f.sig,owner]);
  await f.pg.query("insert into v17_analysis_lease values(true,$1,clock_timestamp()+interval '150 seconds',pg_postmaster_start_time())",[owner]);
  assert.deepEqual((await f.pg.query('select deterministic_recover_claims() r')).rows[0].r.recovered,[]);
  await f.pg.exec('delete from v17_analysis_lease');assert.deepEqual((await f.pg.query('select deterministic_recover_claims() r')).rows[0].r.recovered,[f.sig]);
  assert.equal((await f.pg.query('select state from leader20_entry_reservations')).rows[0].state,'RELEASED');
 }finally{await f.pg.close();}
});
test('unchanged operational model cancels weakening and incomplete data with distinct compact evidence',()=>{
 const input=scenario(),initial=classifyMarket(input);assert.equal(initial.decision,'BUY');
 const absent={...input,capture:{status:'UNAVAILABLE',reason:'MISSING_BUCKETS'}};
 const invalid=revalidateEntry(initial,absent);assert.equal(invalid.reason,'CURRENT_DATA_INCOMPLETE_OR_STALE');
 const weak={...input,facts:{...input.facts,values:{...input.facts.values,market_shock:true}}};
 const cancelled=revalidateEntry(initial,weak);assert.equal(cancelled.reason,'CURRENT_MARKET_THESIS_CANCELLED');
 const signal={id:'s',symbol:'TESTUSDT',features:{deterministic:{decision:initial}}};
 const e=entryEvidence(signal,{check:{...invalid,input:absent},reason:invalid.reason,orderId:'o'});assert.equal(e.category,'DATA_UNAVAILABLE');assert.equal(e.order_id,'o');assert.equal(e.latest.gates.data,false);assert.equal(e.trajectory,undefined);
});

test('terminal no-fill claim is recovered only with final venue exposure proof',async()=>{
 const f=await fixture();try{
  await f.pg.query("update v11_long_regime_signals set status='CLAIMED',updated_at=clock_timestamp()-interval '10 minutes' where id=$1",[f.sig]);
  await f.pg.query("update v11_long_regime_orders set state='EXPIRED',response_payload='{}' where id=$1",[f.order]);
  assert.deepEqual((await f.pg.query('select deterministic_recover_claims() r')).rows[0].r.recovered,[]);
  await f.pg.query("update v11_long_regime_orders set response_payload=$2 where id=$1",[f.order,{v18ExposureFinal:true,orderStateEvidence:{executedQty:0},positionReconciliation:{actualPositionQty:0,positionsComplete:true}}]);
  assert.deepEqual((await f.pg.query('select deterministic_recover_claims() r')).rows[0].r.recovered,[f.sig]);
  assert.equal((await f.pg.query('select state from leader20_entry_reservations')).rows[0].state,'RELEASED');
 }finally{await f.pg.close();}
});

test('Top20 refusal at the submit boundary retains the exact authority snapshot and validation instant',async()=>{
 const f=await fixture();try{
  await f.publish('LEFTUSDT');const refused=await f.submit();
  assert.equal(refused.updated,false);assert.equal(refused.reason,'TOP20_LEFT_UNIVERSE');
  assert.equal(refused.authority.member,null);assert.ok(refused.authority.epoch_id);assert.ok(refused.authority.validated_at);
 }finally{await f.pg.close();}
});
