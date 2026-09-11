// Isolated PostgreSQL/PostgREST integration. This script refuses remote DB/API URLs.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const DB='postgresql://postgres:local_gate_only@127.0.0.1:55432/postgres';
const API='http://127.0.0.1:53000';
const sql=s=>execFileSync('psql',[DB,'-X','-v','ON_ERROR_STOP=1','-At'],{input:s,encoding:'utf8'}).trim();
const read=n=>readFileSync(new URL(n,import.meta.url),'utf8');
const q=s=>'"'+s.replaceAll('"','""')+'"';
if(process.argv[2]==='setup'){
  const schema=JSON.parse(read('./schema-columns.json'));
  const security=JSON.parse(read('./production-security.json'));
  const triggers=JSON.parse(read('./production-triggers.json'));
  let s="create role anon;create role authenticated;create role service_role bypassrls;create role authenticator login noinherit password 'local_auth_only';grant anon,authenticated,service_role to authenticator;grant usage on schema public to anon,authenticated,service_role;set check_function_bodies=off;";
  for(const t of schema)s+=`create table public.${q(t.table_name)} (${t.columns.map(c=>q(c.name)+' '+c.type.replace('_text','text[]')).join(',')});`;
  s+=`alter table v17_execution_lease add primary key(singleton);alter table v11_long_regime_runtime add primary key(singleton);alter table v11_long_regime_positions add primary key(id);alter table v11_long_regime_orders add primary key(id);`;
  for(const t of security.tables)if(t.rls)s+=`alter table ${q(t.name)} enable row level security;`;
  assert.equal(security.policies.length,0,'Production policy fixture changed; review explicit policies');
  for(const g of security.grants)s+=`grant ${g.privilege_type} on ${q(g.table_name)} to ${q(g.grantee)};`;
  for(const t of triggers)s+=t.function_definition+';'+t.definition+';';
  s+=read('./lease-rpcs.sql');
  s+=`insert into v17_execution_lease values(true,null,'-infinity');insert into v11_long_regime_runtime(singleton,revision,live_enabled,circuit_open) values(true,'V11-LONG-REGIME-1.0.1',true,false);insert into v17_operator_control(singleton,entry_enabled,legacy_entries_retired) values(true,true,true);insert into trading_settings(id,mode,pause_new_entries,withdrawal_mode,manual_intervention_required,scalp_kill_switch,emergency_liquidation) values(1,'LIVE_LIMITED',false,false,false,false,false);`;
  sql(s);
  const migration=read('../../supabase/migrations/20260911000759_v18_ops_isolation.sql');
  sql(migration);sql(migration);
  console.log('PASS PostgreSQL migration twice with captured production trigger definitions, RLS and table grants');
  process.exit(0);
}
const key=process.env.V18_TEST_JWT_SECRET;
if(!key||key.length<32)throw Error('LOCAL_JWT_REQUIRED');
const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt(role){const p=b({alg:'HS256',typ:'JWT'})+'.'+b({role,exp:Math.floor(Date.now()/1000)+300});return p+'.'+crypto.createHmac('sha256',key).update(p).digest('base64url');}
async function call(path,body,owner,method='POST',role='service_role'){
  const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt(role),Prefer:'return=representation',...(owner?{'x-v18-execution-owner':owner}:{})},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
const a=crypto.randomUUID(),bowner=crypto.randomUUID();
let r=await call('/rpc/v17_acquire_execution_lease',{p_owner:a});assert.equal(r.body,true,JSON.stringify(r));
r=await call('/v11_long_regime_runtime?singleton=eq.true',{entry_block_reason:'LOCAL_ACK'},a,'PATCH');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.length,1);
console.log('PASS actual PostgREST authenticated header reaches DB fence; current owner writes');
sql("update v17_execution_lease set expires_at=clock_timestamp()-interval '1 second'");
r=await call('/v11_long_regime_runtime?singleton=eq.true',{entry_block_reason:'STALE_WRITE'},a,'PATCH');assert.match(JSON.stringify(r),/V18_EXECUTION_FENCED/);assert.equal(sql('select entry_block_reason from v11_long_regime_runtime'),'LOCAL_ACK');
console.log('PASS expired owner write rejected with zero row change');
const results=await Promise.all([a,bowner].map(p_owner=>call('/rpc/v17_acquire_execution_lease',{p_owner})));
assert.equal(results.filter(x=>x.body===true).length,1,JSON.stringify(results));
const winner=results[0].body===true?a:bowner,loser=winner===a?bowner:a;
r=await call('/v11_long_regime_runtime?singleton=eq.true',{entry_block_reason:'LOSER'},loser,'PATCH');assert.match(JSON.stringify(r),/V18_EXECUTION_FENCED/);
console.log('PASS competing real HTTP connections acquire exactly one lease; loser fenced');
r=await call('/rpc/v18_record_incident',{p_owner:winner,p_kind:'KNOWN_EXIT_PENDING_RECONCILIATION',p_reason:'LOCAL_TAC_RACE',p_evidence:{}},winner);assert.equal(r.status,200,JSON.stringify(r));const incident=r.body;
const t=Date.now();r=await call('/rpc/v18_recovery_observation',{p_owner:winner,p_incident_id:incident,p_generation:1,p_evidence:{positions:[],ordersObservedAt:t,observation:{id:crypto.randomUUID(),source:'BINANCE_ACCOUNT_REST',requested_at_ms:t,received_at_ms:t}}},winner);assert.equal(r.body.checks,1,JSON.stringify(r));assert.equal(sql('select circuit_open from v11_long_regime_runtime'),'t');
console.log('PASS invoker incident/recovery RPC with production grants; one observation keeps circuit open');
for(const role of ['anon','authenticated']){r=await call('/rpc/v18_record_incident',{p_owner:winner,p_kind:'KNOWN_EXIT_PENDING_RECONCILIATION',p_reason:'DENIED',p_evidence:{}},null,'POST',role);assert.ok(r.status>=400,JSON.stringify(r));}
console.log('PASS anon/authenticated cannot invoke incident mutation');
r=await call('/rpc/v17_release_execution_lease',{p_owner:winner});assert.ok(r.status<300,JSON.stringify(r));
console.log('PASS PostgreSQL/PostgREST deployment gate (no production connection or order)');
