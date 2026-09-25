import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {temporalInputs,compareTemporal} from '../supabase/functions/_shared/gpt-final-decision/temporal.mjs';
import {callCounter,MODEL_CANDIDATES} from '../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
const raw=JSON.parse(await readFile(new URL('../research/deepseek-counter-20260925/inputs.json',import.meta.url),'utf8')).find(x=>x.packet.task==='HOLD');
const row={packet:raw.packet,as_of_ms:raw.snapshot_at_ms,group_key:'position-a'};
const old=(delta=60000)=>({...structuredClone(row),as_of_ms:row.as_of_ms-delta,
  packet:{...structuredClone(row.packet),facts:{...structuredClone(row.packet.facts),quality:{...row.packet.facts.quality,last_close_at_ms:row.as_of_ms-delta-1}}}});
test('history excludes future, same-time, stale and different-position data; copies only facts',async()=>{
  const valid=old();valid.result={secret:'FUTURE_OUTCOME'};valid.packet.facts.values.return_5m=.123;
  const {A,B,history_count}=await temporalInputs(row,[old(-1),old(0),old(3600001),{...old(),group_key:'another'},valid]);
  assert.equal(history_count,1);assert.equal(B.market_input.temporal.history[0].facts.return_5m,.123);
  assert.equal(B.market_input.temporal.change_from_latest.return_5m,row.packet.facts.values.return_5m-.123);
  assert.ok(!JSON.stringify(B).includes('FUTURE_OUTCOME'));assert.ok(!A.market_input.temporal);
  assert.notEqual(A.snapshot_hash,B.snapshot_hash);
});
test('history capped and deduplicated in time order; missing history does not invent deltas',async()=>{
  const b=(await temporalInputs(row,[old(60000),old(60000),old(120000),old(180000),old(240000)])).B;
  assert.deepEqual(b.market_input.temporal.history.map(x=>x.age_ms),[180000,120000,60000]);
  const empty=(await temporalInputs(row)).B.market_input.temporal;
  assert.equal(empty.history.length,0);assert.ok(Object.values(empty.change_from_latest).every(x=>x===null));
});
test('unpublished candles rejected in current and history',async()=>{
  const bad=structuredClone(row);bad.packet.facts.quality.last_close_at_ms=row.as_of_ms;
  await assert.rejects(temporalInputs(bad),/FUTURE_CANDLE/);
  const h=old();h.packet.facts.quality.last_close_at_ms=h.as_of_ms;
  await assert.rejects(temporalInputs(row,[h]),/FUTURE_CANDLE/);
});
test('both ablation calls overlap and provider failure never grants authority',async()=>{
  let n=0,release;const barrier=new Promise(r=>release=r);
  const r=await compareTemporal(row,[],{call:async()=>{if(++n===2)release();await barrier;if(n===2)throw Error('private-key');}});
  assert.equal(n,2);assert.deepEqual(r.authority,[]);assert.equal(r.arms.A.error,'PROVIDER_ERROR');
  assert.ok(!JSON.stringify(r).includes('private-key'));
});
test('oversized provider body rejected before any API charge',async()=>{
  const {A}=await temporalInputs(row);
  const r=await callCounter({...A,market_input:{text:'x'.repeat(50000)}},{...MODEL_CANDIDATES[0],apiKey:'test',fetchFn:()=>assert.fail('network')});
  assert.equal(r.error,'COUNTER_REQUEST_SIZE');assert.equal(r.attempted,false);
});
test('research queue is service-only, one-time claimed, finite and ignores caller-supplied budgets',async()=>{
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db=new PGlite();
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.gpt_final_entry_reviews(job_key text,record jsonb,state text,purpose text,created_at timestamptz);
      create table public.v11_long_regime_positions(id uuid,entry_at timestamptz);`);
    await db.exec(await readFile(new URL('../supabase/migrations/20260925093000_deepseek_temporal_shadow.sql',import.meta.url),'utf8'));
    await db.exec(`insert into deepseek_temporal_jobs(id,source,partition,group_key,as_of_ms,packet) values
      ('one','HISTORICAL_DEVELOPMENT','DEVELOPMENT','g',1,'{}'),('two','HISTORICAL_DEVELOPMENT','DEVELOPMENT','h',2,'{}');`);
    assert.equal((await db.query('select * from deepseek_temporal_claim()')).rows.length,0);
    await db.exec('update deepseek_temporal_control set enabled=true,max_pairs=1');
    const [a,b]=await Promise.all([db.query('select * from deepseek_temporal_claim()'),db.query('select * from deepseek_temporal_claim()')]);
    assert.equal(a.rows.length+b.rows.length,1);
    assert.equal((await db.query('select claimed_pairs from deepseek_temporal_control')).rows[0].claimed_pairs,1);
    await db.exec('update deepseek_temporal_control set max_pairs=2,expires_at=now()-interval \'1 second\'');
    assert.equal((await db.query('select * from deepseek_temporal_claim()')).rows.length,0);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from deepseek_temporal_jobs'),/permission denied/);
    await assert.rejects(db.query('select * from deepseek_temporal_claim()'),/permission denied/);
    await db.exec('reset role');
  }finally{await db.close();}
});
