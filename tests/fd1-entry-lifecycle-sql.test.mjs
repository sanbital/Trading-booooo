// Migration 20260925003050 (entry lifecycle journal) on a real Postgres (PGlite), applied on
// top of the two journal migrations it extends, and pinned to the executor's JS classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {TERMINAL_RULES,terminalClassOf} from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';

const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const read=f=>readFileSync(new URL('../supabase/migrations/'+f,import.meta.url),'utf8');
const original=read('20260924090000_fd1_execution_retry_missed_journal.sql');
const accounting=read('20260924143851_fd1_retry_journal_accounting.sql');
const lifecycle=read('20260925003050_fd1_entry_lifecycle_journal.sql');
const MIN=60000;
// The columns 20260924143851 adds to the journal (its functions need production-only objects).
const accountingColumns=accounting.slice(accounting.indexOf('alter table public.missed_opportunity_journal'),
  accounting.indexOf(';',accounting.indexOf('alter table public.missed_opportunity_journal'))+1);
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;

async function setup(){
  const pg=new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema cron;
    create table cron.jobs(name text primary key,schedule text,command text);
    create function cron.schedule(p_name text,p_schedule text,p_command text) returns integer
      language plpgsql as $$ begin insert into cron.jobs values(p_name,p_schedule,p_command)
        on conflict(name) do update set schedule=excluded.schedule,command=excluded.command; return 1; end $$;
    create function public.http_set_curlopt(p_option text,p_value text) returns void language plpgsql as $$ begin return; end $$;
    create function public.http_get(p_url text) returns table(status integer,content text)
      language sql as $$ select 200,'[]' $$;
    create table public.fd1_final_recheck_log(signal_id text,created_at timestamptz default now(),
      pre_dispatch_snapshot jsonb,recheck_triggered boolean,recheck_reasons text[],deltas jsonb,
      final_gpt_decision text,final_gpt_at timestamptz,final_error text);
    create table public.v11_long_regime_signals(id uuid primary key,symbol text,created_at timestamptz,
      updated_at timestamptz,entry_bar_at timestamptz,features jsonb,status text,reject_reason text);
    create table public.gpt_final_entry_reviews(signal_id text,purpose text,decision text,
      completed_at timestamptz,snapshot_at timestamptz,record jsonb,created_at timestamptz);
    create table public.v11_long_regime_orders(id uuid,signal_id uuid,intent text,created_at timestamptz,
      request_payload jsonb,response_payload jsonb,client_order_id text,exchange_order_id text,
      requested_quantity numeric,state text,reject_reason text);
    create table public.v11_long_regime_positions(id uuid,signal_id uuid,entry_at timestamptz,
      original_quantity numeric,entry_price numeric,realized_pnl_usdt numeric,state text);`);
  return pg;
}
const sig=(pg,n,{status='REJECTED',reason=null,setup={},minutesAgo=120}={})=>pg.query(
  `insert into public.v11_long_regime_signals values($1,$2,now()-make_interval(mins=>$3),now(),now()-make_interval(mins=>$3),$4,$5,$6)`,
  [id(n),'SYM'+n+'USDT',minutesAgo,{referenceClose:100,targetMarginUsdt:150,leverage:3,exitPolicy:{stopPct:.025},v17Setup:setup},status,reason]);
const review=(pg,n,decision,{task='ENTRY',minutesAgo=119,answer={}}={})=>pg.query(
  `insert into public.gpt_final_entry_reviews values($1,'PRODUCTION',$2,now()-make_interval(mins=>$3),now()-make_interval(mins=>$3),$4,now()-make_interval(mins=>$3))`,
  [id(n),decision,minutesAgo,{packet:{task},result:{answer}}]);
const row=async(pg,n)=>(await pg.query(`select * from public.missed_opportunity_journal where signal_id=$1`,[id(n)])).rows[0];

test('entry_terminal_class mirrors the executor classes exactly',async()=>{
  for(const [,src] of TERMINAL_RULES)if(src!=='.')assert.ok(lifecycle.includes(`'${src}'`),'SQL carries rule '+src);
  const pg=await setup();try{
    await pg.exec(original);await pg.exec(accountingColumns);await pg.exec(lifecycle);
    const samples=['','IOC_NO_FILL:EXPIRED','IOC_RETRY_EXHAUSTED','PARTIAL_FILL_ABORT:IOC_RETRY_EXHAUSTED','V11_SLOT_FULL',
      'SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:V11_SLOT_FULL','GPT_SKIP:EV_UNFAVORABLE','GPT_ABSTAIN:DATA_INSUFFICIENT','GPT_TIMEOUT',
      'GPT_FINAL_RECHECK_SKIP','GPT_FINAL_RECHECK_ABSTAIN:API_TIMEOUT','V17_SETUP_EXPIRED','V17_CHASE_EXPIRED:DEAD:VOLUME_FADING',
      'V30_FRONT_REJECT:volumeTails','STALE:TRIGGER_WINDOW_CLOSED','GPT_BUY_NOT_EXECUTED:V17_SETUP_EXPIRED','GPT_REVIEW_EXPIRED',
      'UNKNOWN:E1_QUOTE_UNKNOWN','EXECUTION_SAFETY_REJECT:STALE_QUOTE','EXECUTION_SAFETY_REJECT:INSUFFICIENT_MARGIN',
      'RC_POST_SPREAD_CATASTROPHIC','ENTRY_SPREAD:412','SETUP_WRITE:boom','CLAIM:timeout','V17_RUNTIME_BLOCKED','ORDER_INTENT:dup',
      'E1_SIGNAL_TERMINAL_WRITE','BOO_ENTRY_GATE:RISK','ENTRY_CONTROL:ACCOUNT:X','SUPERSEDED_BY_FRESHER_SIGNAL:ABCUSDT',
      'MAX_SLOTS_REACHED:10/10','INSUFFICIENT_MARGIN:149.50<152.13','PENDING_CAPITAL_RESERVED:PENDING_ORDER_IDENTITY:1',
      'EXECUTION_SAFETY_REJECT:CYCLE_BUDGET_RESERVE','ACCOUNT_SAFETY_BLOCK:CAPACITY_REFRESH_FAILED:X','IOC_RETRY_EXHAUSTED:CYCLE_BUDGET_RESERVE',
      'STALE:GPT_BUY_NOT_EXECUTED:EXECUTION_SAFETY_REJECT:CYCLE_BUDGET_RESERVE'];
    for(const r of samples){
      const sql=(await pg.query('select public.entry_terminal_class($1,false,false) c',[r])).rows[0].c;
      assert.equal(sql,terminalClassOf(r),r);
    }
    assert.equal((await pg.query(`select public.entry_terminal_class('X',true,false) c`)).rows[0].c,'FILLED');
    assert.equal((await pg.query(`select public.entry_terminal_class('X',true,true) c`)).rows[0].c,'PARTIAL_FILLED');
  }finally{await pg.close();}
});

test('journal: ENTRY-only initial decision, BUY orphan relabel, chase re-anchor, attempt evidence, classes',async()=>{
  const pg=await setup();try{
    const chaseOpen=Math.floor((Date.now()-100*MIN)/MIN)*MIN;
    // 1 filled entry whose position later got HOLD/EXIT reviews.
    await sig(pg,1,{status:'CLOSED',setup:{state:'ENTERED',triggerAt:chaseOpen,triggerClose:100}});
    await review(pg,1,'BUY',{minutesAgo:119});await review(pg,1,'EXIT',{task:'HOLD',minutesAgo:90});
    await pg.query(`insert into public.v11_long_regime_positions values('aaaaaaaa-1111-4111-8111-111111111111',$1,now()-interval '118 minutes',4.5,100,-3,'CLOSED')`,[id(1)]);
    await pg.query(`insert into public.v11_long_regime_orders values('bbbbbbbb-1111-4111-8111-111111111111',$1,'OPEN_LONG',now()-interval '118 minutes',
      $2,$3,'c1','e1',4.5,'FILLED',null)`,[id(1),{entry_ioc_attempt:1,order:{price:100.03},ioc_attempt_evidence:{offsetBps:3,quoteAgeMs:420,executableQtyAtLimit:9,bestAsk:100}},
      {order:{executed_volume:'4.5',status:'FILLED'},v22EntryFinality:{latencyMs:180}}]);
    // 2 GPT BUY orphan that the setup TTL later mislabelled.
    await sig(pg,2,{reason:'V17_SETUP_EXPIRED',setup:{state:'EXPIRED_NO_REACCEL',triggerAt:chaseOpen,triggerClose:100}});
    await review(pg,2,'BUY',{answer:{abstain_reason:'NONE',expected_value_bias:'POSITIVE'}});
    // 3 a chase: tracked first under the old signal-reference anchor.
    await sig(pg,3,{reason:'V17_CHASE_EXPIRED:DEAD:VOLUME_FADING',setup:{state:'CHASE_EXPIRED',lastClose:101.5,lastCandleOpenTime:chaseOpen,
      chase:{state:'DEAD',reasons:['VOLUME_FADING']}}});
    // 4 the executor's new terminal reasons, and 5 a still-open candidate.
    await sig(pg,4,{reason:'GPT_SKIP:EV_UNFAVORABLE',setup:{state:'TRIGGERED',triggerAt:chaseOpen,triggerClose:100,
      triggerMode:'LIVE_MOMENTUM_CHASE',chase:{state:'LIVE'}}});
    await review(pg,4,'SKIP',{answer:{abstain_reason:'NONE',expected_value_bias:'NEGATIVE'}});
    await sig(pg,5,{status:'NEW',setup:{state:'TRIGGERED',triggerAt:chaseOpen,triggerClose:100},minutesAgo:2});
    await sig(pg,6,{reason:'SLOT_UNAVAILABLE:GPT_BUY_NOT_EXECUTED:V11_SLOT_FULL',setup:{state:'TRIGGERED',triggerAt:chaseOpen,triggerClose:100}});
    await review(pg,6,'BUY');
    await sig(pg,7,{status:'REJECTED',reason:'GPT_ABSTAIN:EV_UNDETERMINABLE',setup:{state:'TRIGGERED',triggerAt:chaseOpen,triggerClose:100}});
    await review(pg,7,'ABSTAIN',{answer:{abstain_reason:'EV_UNDETERMINABLE',expected_value_bias:'UNDETERMINED'}});

    await pg.exec(original);await pg.exec(accountingColumns);
    // Before: the HOLD/EXIT review was read as the entry decision; the chase was anchored at 100.
    assert.equal((await row(pg,1)).initial_gpt_decision,'EXIT');
    assert.equal(Number((await row(pg,3)).reference_price),100);
    await pg.query(`update public.missed_opportunity_journal set outcome_tracked_at=now(),reconstructed_net_30m=7,
      reconstructed_net_usdt=9,mfe_60=.03,close_60m=103 where signal_id=$1`,[id(3)]);

    await pg.exec(lifecycle);
    const r1=await row(pg,1),r2=await row(pg,2),r3=await row(pg,3),r4=await row(pg,4),r5=await row(pg,5),r6=await row(pg,6),r7=await row(pg,7);
    assert.equal(r1.initial_gpt_decision,'BUY','the HOLD/EXIT review is not the entry decision');
    assert.equal(r1.terminal_class,'FILLED');
    const a=r1.execution_attempts[0];
    assert.equal(Number(a.offset_bps),3);assert.equal(Number(a.quote_age_ms),420);assert.equal(Number(a.latency_ms),180);
    assert.equal(Number(a.executed_quantity),4.5);assert.equal(Number(a.executable_qty_at_limit),9);assert.equal(a.exchange_status,'FILLED');
    assert.equal(r2.reject_reason,'GPT_BUY_NOT_EXECUTED:V17_SETUP_EXPIRED');assert.equal(r2.terminal_class,'STALE');
    assert.equal(r2.gpt_expected_value_bias,'POSITIVE');
    assert.equal(Number(r3.reference_price),101.5,'a chase is measured from the chase bar close');
    assert.equal(new Date(r3.candidate_at).getTime(),chaseOpen+MIN);assert.equal(r3.anchor_basis,'CHASE_CLOSE');
    assert.equal(r3.outcome_tracked_at,null,'the old-anchor outcome is cleared for re-tracking');
    assert.equal(r3.reconstructed_net_usdt,null);assert.equal(r3.close_60m,null);
    assert.equal(Number(r3.legacy_anchor.reference_price),100);assert.equal(Number(r3.legacy_anchor.reconstructed_net_usdt),9);
    assert.equal(r3.terminal_class,'STRATEGY_REJECTED');assert.equal(r3.chase_state,'DEAD');
    assert.equal(r4.reject_reason,'GPT_SKIP:EV_UNFAVORABLE','the executor reason is kept, not flattened');
    assert.equal(r4.terminal_class,'GPT_REJECTED');assert.equal(r4.entry_path,'LIVE_MOMENTUM_CHASE');assert.equal(r4.chase_state,'LIVE');
    assert.equal(r5.terminal_class,null,'an open candidate has no terminal class yet');
    assert.equal(r6.terminal_class,'SLOT_UNAVAILABLE');
    assert.equal(r7.reject_reason,'GPT_ABSTAIN:EV_UNDETERMINABLE');assert.equal(r7.gpt_abstain_reason,'EV_UNDETERMINABLE');
    // Idempotent: a second sync changes nothing and does not reset anything again.
    await pg.query(`update public.missed_opportunity_journal set outcome_tracked_at=now(),reconstructed_net_usdt=1 where signal_id=$1`,[id(3)]);
    await pg.query('select public.missed_opportunity_sync(10000)');
    assert.equal(Number((await row(pg,3)).reconstructed_net_usdt),1);
    assert.equal(Number((await row(pg,3)).legacy_anchor.reference_price),100);
    const byClass=(await pg.query(`select terminal_class,gpt_buy_without_attempt::int n from public.missed_opportunity_by_class where terminal_class='STALE'`)).rows;
    assert.deepEqual(byClass,[{terminal_class:'STALE',n:1}]);
    const byReason=(await pg.query(`select reason from public.missed_opportunity_by_reason order by 1`)).rows.map(x=>x.reason);
    for(const r of ['GPT_BUY_NOT_EXECUTED','V17_CHASE_EXPIRED:DEAD','SLOT_UNAVAILABLE','GPT_SKIP','GPT_ABSTAIN'])assert.ok(byReason.includes(r),r);
    await pg.exec('set role anon');
    await assert.rejects(pg.query('select * from public.missed_opportunity_by_class'),/permission denied/);
    await pg.exec('reset role');
  }finally{await pg.close();}
});

test('R181 UNAPPLIED journal patch: provider failures are not GPT ABSTAIN judgments; valid ABSTAIN and timeout unchanged',async()=>{
  const pg=await setup();
  const patch=readFileSync(new URL('../ops/r181/missed_opportunity_sync_decision_source.UNAPPLIED.sql',import.meta.url),'utf8');
  try{
    await pg.exec(original);await pg.exec(accountingColumns);await pg.exec(lifecycle);await pg.exec(patch);
    const cases=[[901,{origin:'OPENAI_API',valid:false,error:'HTTP_429'},'STALE:GPT_REVIEW_PENDING','GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429'],
      [902,{origin:'OPENAI_API',valid:false,error:'FD_BUY_WITH_REASON'},'STALE:GPT_REVIEW_PENDING','GPT_NO_VALID_API_RESPONSE:SAFETY_FALLBACK:FD_BUY_WITH_REASON'],
      [903,{origin:'OPENAI_API',valid:false,error:'HTTP_429'},'GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429','GPT_NO_VALID_API_RESPONSE:PROVIDER_ERROR:HTTP_429'],
      [904,{origin:'OPENAI_API',valid:true,answer:{decision:'ABSTAIN',abstain_reason:'EV_UNDETERMINABLE'}},'STALE:GPT_REVIEW_PENDING','GPT_ABSTAIN'],
      [905,{origin:'OPENAI_API',valid:false,error:'API_TIMEOUT'},'STALE:GPT_REVIEW_PENDING','GPT_TIMEOUT']];
    for(const [n,result,reason] of cases){
      await sig(pg,n,{reason});
      await pg.query(`insert into public.gpt_final_entry_reviews values($1,'PRODUCTION','ABSTAIN',now()-interval '119 minutes',now()-interval '119 minutes',$2,now()-interval '119 minutes')`,
        [id(n),{packet:{task:'ENTRY'},result}]);
    }
    await pg.query('select public.missed_opportunity_sync(10000)');
    for(const [n,,,expect] of cases){const r=await row(pg,n);assert.equal(r.reject_reason,expect,String(n));assert.equal(r.terminal_class,'GPT_REJECTED');}
  }finally{await pg.close();}
});
