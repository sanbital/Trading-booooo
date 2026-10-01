import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assertCurrentEntry,createWriterRepository,writerTurn} from '../supabase/functions/_shared/account-order-writer.mjs';

const account='binance_futures:futures';
const valid={authority:true,freshness:true,buckets:true,capacity:true,circuitClosed:true,
  recoveryComplete:true,sameOrderAbsent:true};
const request=(overrides={})=>({execution_key:crypto.randomUUID(),account_key:account,
  decision_id:crypto.randomUUID(),correlation_id:crypto.randomUUID(),symbol:'TESTUSDT',side:'BUY',kind:'ENTRY',
  deadline:new Date(Date.now()+30000).toISOString(),authority_version:'existing-final-authority',
  strategy_version:'unchanged-production-strategy',client_order_id:crypto.randomUUID().replaceAll('-',''),
  payload:{action:'create_order',exchange:'binance_futures',order:{market:'TESTUSDT',quantity:1}},...overrides});

async function fixture(t) {
  assert.ok(process.env.PGLITE_MODULE,'PGLITE_MODULE required');
  const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec('create role anon; create role authenticated; create role service_role;');
  await pg.exec(await readFile(new URL('../supabase/migrations/20261001233000_account_writer_expand.sql',import.meta.url),'utf8'));
  await pg.query(`insert into trading_writer_control(account_key,enabled,lease_ttl_ms,network_bound_ms,
    critical_p99_ms,measurement_ref,recovery_required,recovered_generation,recovered_postmaster_at)
    values($1,true,3000,1000,200,'ISOLATED_FIXTURE_NOT_PRODUCTION',false,0,pg_postmaster_start_time())`,[account]);
  const db={rpc:async(name,args)=>{
    const fields=Object.keys(args),values=Object.values(args);
    try {
      const r=await pg.query(`select ${name}(${fields.map((f,i)=>`${f} => $${i+1}`).join(',')}) r`,values);
      return {data:r.rows[0].r,error:null};
    } catch(error) { return {data:null,error:{message:error.message}}; }
  }};
  const repo=createWriterRepository(db);
  const row=key=>pg.query('select * from trading_execution_outbox where execution_key=$1',[key]).then(r=>r.rows[0]);
  const lease=()=>repo.acquire(account,crypto.randomUUID());
  const timers={setInterval:()=>0,clearInterval:()=>{}};
  let submits=0;
  const orders=new Map();
  const exchange={
    submitFenced:async(r,{verify})=>{
      await verify();submits++;
      assert.equal(orders.has(r.client_order_id),false,'duplicate submission');
      const receipt={orderId:r.client_order_id,complete:true,found:true,quantity:1,status:'FILLED'};
      orders.set(r.client_order_id,receipt);return receipt;
    },
    lookup:async(r)=>orders.get(r.client_order_id)??{complete:true,found:false,neverPlaced:false},
  };
  const settle=async(r,receipt)=>({state:receipt.status==='PARTIALLY_FILLED'?'PARTIALLY_FILLED':'FILLED',
    reason:receipt.status==='PARTIALLY_FILLED'?null:'EXCHANGE_FILLED',evidence:{quantity:receipt.quantity}});
  const turn=(options={})=>writerTurn({account,owner:crypto.randomUUID(),repository:repo,exchange,
    validate:async()=>valid,settle,timers,...options});
  return {pg,repo,row,lease,turn,exchange,orders,timers,submits:()=>submits};
}

test('logged durable outbox and immutable execution key / unique submit identity',async t=>{
  const f=await fixture(t),r=request();
  await f.repo.enqueue(r);await f.repo.enqueue(r);
  assert.equal((await f.pg.query('select count(*) n from trading_execution_outbox')).rows[0].n,1);
  await assert.rejects(f.repo.enqueue({...r,symbol:'OTHERUSDT'}),/EXECUTION_KEY_CONFLICT/);
  await assert.rejects(f.repo.enqueue({...r,execution_key:crypto.randomUUID()}),/duplicate key/);
  const persistence=await f.pg.query("select relpersistence from pg_class where relname='trading_execution_outbox'");
  assert.equal(persistence.rows[0].relpersistence,'p');
});

test('claim requires current account lease, successor fence rejects prior holder and heartbeat',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  const first=await f.lease();assert.ok(first);
  assert.equal(await f.lease(),null);
  await f.pg.query("update trading_writer_leases set expires_at=clock_timestamp()-interval '1 second'");
  assert.equal(await f.repo.heartbeat(first),false,'expired owner cannot revive itself');
  const next=await f.lease();assert.equal(next.fence,first.fence+1);
  await assert.rejects(f.repo.claim(first),/WRITER_FENCED/);
  assert.equal(await f.repo.verify(first),false);
  assert.equal(await f.repo.release(first),false,'stale release cannot unlock successor');
  assert.equal((await f.repo.claim(next)).execution_key,r.execution_key);
});

test('dead writer before submit is taken over; submit crash becomes UNKNOWN rather than retry',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  const a=await f.lease(),claimed=await f.repo.claim(a);
  await f.repo.transition(claimed,a,'VALIDATING');
  await f.repo.transition(claimed,a,'SUBMITTING');
  f.orders.set(r.client_order_id,{complete:true,found:true,orderId:r.client_order_id,quantity:1,status:'FILLED'});
  await f.pg.query("update trading_writer_leases set expires_at='-infinity'");
  assert.equal((await f.turn()).status,'FILLED');
  assert.equal(f.submits(),0,'successor must query existing exchange identity');
  assert.equal((await f.row(r.execution_key)).terminal_reason,'EXCHANGE_FILLED');
});

test('deadline expiration produces one exact terminal reason, without submit',async t=>{
  const f=await fixture(t),r=request({deadline:new Date(Date.now()-1000).toISOString()});await f.repo.enqueue(r);
  assert.equal((await f.turn()).status,'IDLE');assert.equal(f.submits(),0);
  const row=await f.row(r.execution_key);assert.equal(row.state,'EXPIRED');assert.equal(row.terminal_reason,'DEADLINE_EXPIRED');
});
for (const [field,code] of [['authority','AUTHORITY_EXPIRED'],['freshness','MARKET_DATA_STALE'],
  ['buckets','CAPTURE_VALIDATION_FAILED'],['capacity','CAPACITY_REJECTED'],['circuitClosed','CIRCUIT_OPEN'],
  ['recoveryComplete','RECOVERY_INCOMPLETE'],['sameOrderAbsent','ORDER_IDENTITY_UNRESOLVED']]) {
  test(`existing entry guard ${field} remains fail closed with reason ${code}`,()=>{
    assert.throws(()=>assertCurrentEntry(request(),Date.now(),{...valid,[field]:false}),{code});
  });
}

test('validation authority rejection is durable and has no exchange side effect',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  await f.turn({validate:async()=>({...valid,authority:false})});
  const row=await f.row(r.execution_key);
  assert.equal(row.state,'REJECTED');assert.equal(row.terminal_reason,'AUTHORITY_EXPIRED');assert.equal(f.submits(),0);
});

test('exchange timeout after acceptance reconciles same ID with zero duplicate submit',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  const submit=f.exchange.submitFenced;
  f.exchange.submitFenced=async(...args)=>{await submit(...args);throw new Error('exchange timeout');};
  assert.equal((await f.turn()).status,'UNKNOWN');
  assert.equal((await f.row(r.execution_key)).state,'UNKNOWN');
  assert.equal((await f.turn()).status,'FILLED');assert.equal(f.submits(),1);
});

test('exchange lookup no order without conclusive never-placed evidence stays UNKNOWN',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  f.exchange.submitFenced=async()=>{throw new Error('exchange timeout');};
  await f.turn();await f.turn();
  assert.equal((await f.row(r.execution_key)).state,'UNKNOWN');assert.equal(f.submits(),0);
  f.exchange.lookup=async()=>({complete:true,found:false,neverPlaced:true,evidence:{source:'CONFIRMED_NEVER_PLACED'}});
  assert.equal((await f.turn()).status,'RECONCILED');
  assert.equal((await f.row(r.execution_key)).terminal_reason,'ORDER_NEVER_PLACED_CONFIRMED');
  await f.turn();assert.equal(f.submits(),0,'conclusive no-order does not replay an old BUY');
});

test('partial fill is not FILLED and stays available for identity reconciliation',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  f.exchange.submitFenced=async(row)=>({orderId:row.client_order_id,status:'PARTIALLY_FILLED',quantity:.2});
  assert.equal((await f.turn()).status,'PARTIALLY_FILLED');
  const row=await f.row(r.execution_key);assert.equal(row.state,'PARTIALLY_FILLED');assert.equal(row.terminal_at,null);
});

test('reconciliation / protection / exit precede entry; expired submitted orders still reconcile',async t=>{
  const f=await fixture(t);
  for(const kind of ['ENTRY','EXIT','PROTECTION','RECONCILE']) await f.repo.enqueue(request({kind}));
  const l=await f.lease();
  let row=await f.repo.claim(l);assert.equal(row.kind,'RECONCILE');
  await f.repo.transition(row,l,'REJECTED','FIXTURE_DONE');
  row=await f.repo.claim(l);assert.equal(row.kind,'EXIT');
  await f.repo.transition(row,l,'REJECTED','FIXTURE_DONE');
  row=await f.repo.claim(l);assert.equal(row.kind,'PROTECTION');
  await f.repo.transition(row,l,'REJECTED','FIXTURE_DONE');
  row=await f.repo.claim(l);assert.equal(row.kind,'ENTRY');
});

test('DB recovery freeze survives process restart and requires complete ordered evidence',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  await f.pg.query("update trading_writer_control set recovered_postmaster_at='2000-01-01'");
  assert.equal((await f.turn()).status,'IDLE');assert.equal(f.submits(),0);
  const l=await f.lease();
  const evidence={db_ready:true,open_orders_complete:true,positions_complete:true,unknown_reconciled:true,
    fills_attributed:true,protection_complete:true,capacity_recalculated:true};
  await assert.rejects(f.pg.query('select trading_writer_recovery_complete($1,$2,$3,0,$4)',
    [account,l.owner,l.fence,{...evidence,protection_complete:false}]),/RECOVERY_EVIDENCE_INCOMPLETE/);
  assert.equal((await f.pg.query('select trading_writer_recovery_complete($1,$2,$3,0,$4) ok',
    [account,l.owner,l.fence,evidence])).rows[0].ok,true);
  await f.repo.release(l);
  assert.equal((await f.turn()).status,'FILLED');assert.equal(f.submits(),1);
});

test('heartbeat failure aborts before exchange submission and successor retains durable request',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);let heartbeat;
  const timers={setInterval:fn=>{heartbeat=fn;return 1;},clearInterval:()=>{}};
  const repository={...f.repo,heartbeat:async()=>{throw new Error('DB connection reset');}};
  assert.equal((await f.turn({repository,timers,validate:async()=>{await heartbeat();return valid;}})).status,'LEASE_FENCED');
  assert.equal(f.submits(),0);
  assert.equal((await f.turn()).status,'FILLED');assert.equal(f.submits(),1);
});

test('isolated analysis held open does not acquire writer ownership or lose durable BUY',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);
  let complete;const unrelatedAnalysis=new Promise(resolve=>{complete=resolve;});
  assert.equal((await f.turn()).status,'FILLED');complete();await unrelatedAnalysis;
  assert.equal(f.submits(),1);
});

test('gateway authorization binds account fence and exact payload; stale holder cannot submit',async t=>{
  const f=await fixture(t),r=request();await f.repo.enqueue(r);const l=await f.lease(),row=await f.repo.claim(l);
  await f.repo.transition(row,l,'VALIDATING');await f.repo.transition(row,l,'SUBMITTING');
  const authorized=payload=>f.pg.query('select trading_gateway_authorize($1,$2,$3,$4,$5) ok',
    [r.execution_key,account,l.owner,l.fence,payload]).then(x=>x.rows[0].ok);
  assert.equal(await authorized(r.payload),true);
  assert.equal(await authorized({...r.payload,order:{quantity:999}}),false);
  await f.repo.release(l);assert.equal(await authorized(r.payload),false);
});
