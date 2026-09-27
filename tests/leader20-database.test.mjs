import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {selectEpoch} from '../supabase/functions/_shared/leader20/universe.mjs';
import {rawCapture} from '../test-support/dynamic-fixtures.mjs';

// Real PostgreSQL (WASM), synthetic source rows. No production DB or exchange.
test('Leader20 migration and transactional campaign lifecycle',async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.v11_long_regime_signals(id uuid primary key default gen_random_uuid(),revision text,lane text,symbol text,side text,
      signal_bar_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,reject_reason text,updated_at timestamptz);
    create table public.v11_long_regime_positions(id uuid primary key default gen_random_uuid(),symbol text,state text,remaining_quantity numeric,
      closed_at timestamptz,metadata jsonb default '{}',entry_atr numeric not null default 1);
    create schema doa_capture;
    create table doa_capture.live_micro(symbol text,at timestamptz,received_at timestamptz,payload jsonb);
    create table public.gpt_final_entry_reviews(job_key text primary key,state text,record jsonb);
    create table public.test_context(symbol text primary key,payload jsonb);
    create function public.doa_context_for_role_v1(text,timestamptz,text,uuid) returns jsonb language sql as
      'select payload from public.test_context where symbol=$1';
    create function public.doa_capture_rpc(text,jsonb default '{}') returns jsonb language sql as
      'select jsonb_build_object(''enabled'',true,''watch'',jsonb_build_array(jsonb_build_object(''symbol'',''OLDUSDT'',''roles'',jsonb_build_array(''TRADE_CANDIDATE''))))';`);
  await db.exec(await readFile(new URL('../supabase/migrations/20260927121708_leader20_campaigns.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260927131311_leader20_unicode_symbols.sql',import.meta.url),'utf8'));
  await db.exec(`create table gpt_final_review_control(singleton boolean,monthly_cap_usd numeric constraint gpt_final_review_control_monthly_cap_usd_check check(monthly_cap_usd<=40),approval_ref text,updated_at timestamptz);
   insert into gpt_final_review_control(singleton,monthly_cap_usd) values(true,40);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20260927151635_leader20_defer_and_budget_allocation.sql',import.meta.url),'utf8'));
  const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const rpc=async(name,args=[]) => (await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args))[0].result;
  const makeEpoch=async(prefix='C')=>{
    const at=Date.now()-100,symbols=Array.from({length:25},(_,i)=>({symbol:`${prefix}${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
    return selectEpoch({exchangeInfo:{symbols},tickers:symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i-30),quoteVolume:'100',openTime:at-86400000,closeTime:at})),requestedAt:at,observedAt:at});
  };
  let epoch,event,signal;
  await t.test('migration is disabled and preserves the installed capture implementation',async()=>{
    assert.equal((await q('select * from leader20_control'))[0].active_strategy,'LEGACY');
    assert.equal((await rpc('doa_capture_rpc',['watch',{}])).watch[0].symbol,'OLDUSDT');
    await assert.rejects(rpc('leader20_publish_epoch',[await makeEpoch(),null]),/OBSERVATION_DISABLED/);
    assert.equal((await q("select count(*)::int n from pg_class where relname like 'leader20_%' and relkind='r' and relrowsecurity"))[0].n,6);
  });
  await t.test('real Binance Unicode names satisfy campaign and member constraints',async()=>{
    await db.exec("begin");
    try {
      await db.exec("insert into leader20_campaigns(symbol) values ('哈基米USDT')");
      assert.equal((await q("select symbol from leader20_campaigns where symbol='哈基米USDT'"))[0].symbol,'哈基米USDT');
      await assert.rejects(q("insert into leader20_campaigns(symbol) values ('BAD/USDT')"),/check constraint/);
    } finally { await db.exec("rollback"); }
  });
  await t.test('epoch publication is complete, atomic and compare-and-swap fenced',async()=>{
    await db.exec('update leader20_control set observation_enabled=true');
    const snapshot=await makeEpoch();
    const bad=structuredClone(snapshot);bad.members[1].rank=bad.members[0].rank;
    await assert.rejects(rpc('leader20_publish_epoch',[bad,null]),/unique/);
    assert.equal((await q('select count(*)::int n from leader20_epochs'))[0].n,0);
    epoch=(await rpc('leader20_publish_epoch',[snapshot,null])).epoch_id;
    assert.equal((await q('select count(*)::int n from leader20_members'))[0].n,20);
    assert.equal((await rpc('leader20_publish_epoch',[snapshot,null])).reason,'EPOCH_RACE');
    const watches=(await rpc('doa_capture_rpc',['watch',{}])).watch;
    assert.ok(watches.some(x=>x.symbol==='OLDUSDT'),'legacy capture survives prewarming');
    await db.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity) values('OUTUSDT','OPEN',1),('DUSTUSDT','CLOSED',0.00000000000001)");
    await db.exec("update leader20_control set active_strategy='LEADER20_DYNAMIC_1',archive_max_bytes=10000000,archive_state='READY'");
    const active=(await rpc('doa_capture_rpc',['watch',{}])).watch;
    assert.ok(active.some(x=>x.symbol==='OUTUSDT'&&x.roles.includes('OPEN_POSITION')));
    assert.equal(active.some(x=>x.symbol==='OLDUSDT'),false);
    assert.equal(active.some(x=>x.symbol==='DUSTUSDT'),false,'closed floating-point residue is not an open holding');
  });
  await t.test('24 buckets request review without a bullish filter, 23 do not; duplicate work coalesces',async()=>{
    const c=rawCapture(Date.now());
    for(const p of c.trajectory){p.aggressive_buy=0;p.aggressive_sell=1000;}
    await q('insert into test_context values ($1,$2),($3,$4)',['C24USDT',c,'C23USDT',{...c,buckets:23,trajectory:c.trajectory.slice(1)}]);
    assert.equal((await rpc('leader20_schedule')).requests,1);
    assert.equal((await rpc('leader20_schedule')).requests,0);
    event=(await q('select * from leader20_review_events'))[0];
    assert.equal(event.symbol,'C24USDT');
    assert.equal((await q('select count(*)::int n from v11_long_regime_signals'))[0].n,0,'scheduler has no order or signal authority');
  });
  await t.test('materialization is one-shot; generation and epoch own the approval',async()=>{
    const f={strategy:'LEADER_MOMENTUM_V17',referenceClose:1,atr:null};
    signal=(await rpc('leader20_materialize_event',[event.id,f])).signal_id;
    assert.equal((await rpc('leader20_materialize_event',[event.id,f])).created,false);
    assert.equal((await rpc('leader20_entry_authority',[signal])).allowed,true);
    await db.exec('update leader20_control set generation=generation+1');
    assert.equal((await rpc('leader20_entry_authority',[signal])).allowed,false);
    await db.exec('update leader20_control set generation=generation-1');
    await q("update leader20_epochs set scheduled_at=scheduled_at-interval '1 hour',observed_at=observed_at-interval '1 hour',effective_at=effective_at-interval '1 hour',next_refresh_at=clock_timestamp()-interval '1 second' where id=$1",[epoch]);
    assert.equal((await rpc('leader20_entry_authority',[signal])).allowed,false);
    await q("update leader20_epochs set next_refresh_at=clock_timestamp()+interval '1 hour' where id=$1",[epoch]);
  });
  await t.test('durable review audit retains DEFER reasoning without granting an order',async()=>{
    const marker=(await q('select features from v11_long_regime_signals where id=$1',[signal]))[0].features.leader20;
    const record={identity:{signal_id:signal},packet:{task:'ENTRY',leader20:marker,snapshot_hash:'frozen'},result:{valid:true,answer:{action:'DEFER',pressure_state:'MIXED',decision_reason:'Insufficient fresh demand',counter_evidence:[],thesis_invalidation:'Demand weakens',next_review_conditions:'Fresh book replenishment'}}};
    await q("insert into gpt_final_entry_reviews values('synthetic','RUNNING',$1)",[record]);
    await db.exec("update gpt_final_entry_reviews set state='DONE' where job_key='synthetic'");
    assert.equal((await q('select result from leader20_review_events where id=$1',[event.id]))[0].result.next_review_conditions,'Fresh book replenishment');
    assert.equal((await rpc('leader20_status')).members.length,20);
    assert.equal((await q('select status from v11_long_regime_signals where id=$1',[signal]))[0].status,'NEW');
    assert.equal((await q('select state from leader20_review_events where id=$1',[event.id]))[0].state,'DEFERRED');
    assert.equal((await rpc('leader20_entry_authority',[signal])).allowed,false,'old WAIT cannot buy a second review or an order');
    assert.equal(Number((await q('select monthly_cap_usd from gpt_final_review_control'))[0].monthly_cap_usd),45);
    await assert.rejects(db.exec('update gpt_final_review_control set monthly_cap_usd=46'),/monthly_cap_usd_check/);
  });
  await t.test('SKIP ends the review event and retains its watch campaign for new evidence',async()=>{
    await q("update v11_long_regime_signals set status='REJECTED',reject_reason='GPT_SKIP' where id=$1",[signal]);
    await rpc('leader20_schedule');
    assert.equal((await q('select state from leader20_review_events where id=$1',[event.id]))[0].state,'DEFERRED');
    assert.notEqual((await q("select state from leader20_campaigns where symbol='C24USDT'"))[0].state,'RETIRED');
    await db.exec("update leader20_campaigns set last_requested_at=clock_timestamp()-interval '121 seconds' where symbol='C24USDT'");
    const c=rawCapture(Date.now());c.trajectory[23].mid+=0.01;
    await q("update test_context set payload=$1 where symbol='C24USDT'",[c]);
    assert.equal((await rpc('leader20_schedule')).requests,1);
  });
  await t.test('settlement invalidates old approvals and requires a fully new 120s window',async()=>{
    const next=(await q("select id from leader20_review_events where state='REQUESTED'"))[0].id;
    const id=(await rpc('leader20_materialize_event',[next,{referenceClose:1}])).signal_id;
    await db.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity,closed_at) values('C24USDT','CLOSED',0,clock_timestamp())");
    assert.equal((await rpc('leader20_entry_authority',[id])).reason,'POST_SETTLEMENT_APPROVAL_REQUIRED');
    await q("update v11_long_regime_signals set status='REJECTED' where id=$1",[id]);
    assert.equal((await rpc('leader20_schedule')).requests,0);
    assert.equal((await q("select reason from leader20_campaigns where symbol='C24USDT'"))[0].reason,'POST_SETTLEMENT_EVIDENCE_PENDING');
  });
  await t.test('archive deduplication and private access preserve raw observations',async()=>{
    const at=new Date().toISOString(),payload={aggressive_buy:0,aggressive_sell:13};
    await q('insert into doa_capture.live_micro values($1,$2,$2,$3)',['C24USDT',at,payload]);
    const body={rows:[{kind:'micro',symbol:'C24USDT',at}]};
    await rpc('doa_capture_rpc',['ingest',body]);await rpc('doa_capture_rpc',['ingest',body]);
    assert.equal((await q('select count(*)::int n from leader20_micro_archive'))[0].n,1);
    assert.deepEqual((await q('select payload from leader20_micro_archive'))[0].payload,payload);
    assert.equal((await q("select has_table_privilege('anon','leader20_micro_archive','select') as allowed"))[0].allowed,false);
  });

  await t.test('rotation retires old review authority, retains outside holdings and revives rejoined campaigns',async()=>{
    await db.exec("insert into v11_long_regime_positions(symbol,state,remaining_quantity) values('C22USDT','OPEN',1)");
    await q("insert into leader20_review_events(epoch_id,symbol,generation,snapshot_end_ms,snapshot_hash,reason,priority) values($1,'C23USDT',1,1,'rotation','TEST',3)",[epoch]);
    await q("insert into leader20_campaigns(symbol,epoch_id,state) values('N19USDT',$1,'RETIRED')",[epoch]);
    await q("update leader20_epochs set next_refresh_at=clock_timestamp()-interval '1 second' where id=$1",[epoch]);
    const rotated=await rpc('leader20_publish_epoch',[await makeEpoch('N'),epoch]);
    assert.equal(rotated.published,true);
    assert.equal((await q("select state from leader20_review_events where snapshot_hash='rotation'"))[0].state,'RETIRED');
    assert.equal((await q("select state from leader20_campaigns where symbol='C22USDT'"))[0].state,'MANAGE_ONLY');
    assert.equal((await q("select state from leader20_campaigns where symbol='N19USDT'"))[0].state,'WARMING_UP');
    assert.equal((await rpc('leader20_status')).members.length,20);
    const watch=(await rpc('doa_capture_rpc',['watch',{}])).watch;
    assert.ok(watch.some(x=>x.symbol==='C22USDT'&&x.roles.includes('OPEN_POSITION')));
    assert.equal((await rpc('leader20_entry_authority',[signal])).allowed,false);
  });
  await t.test('an exhausted archive pauses only new strategy entry and preserves capture and positions',async()=>{
    await db.exec("update leader20_control set archive_max_bytes=1");
    const before=(await q('select generation from leader20_control'))[0].generation;
    const r=await rpc('doa_capture_rpc',['ingest',{rows:[]}]);
    assert.equal(r.enabled,true);
    assert.equal(r.leader20_archive,'BUDGET_OR_CAP_BLOCKED');
    const ctl=(await q('select * from leader20_control'))[0];
    assert.equal(ctl.active_strategy,'PAUSED');assert.equal(Number(ctl.generation),Number(before)+1);
    assert.equal((await q("select remaining_quantity from v11_long_regime_positions where symbol='OUTUSDT'"))[0].remaining_quantity,'1');
    assert.ok((await rpc('doa_capture_rpc',['watch',{}])).watch.some(x=>x.symbol==='OUTUSDT'));
  });

});
