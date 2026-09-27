import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {fetchB06133Inputs} from '../supabase/functions/_shared/leader-b06133-entry.mjs';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const dir=new URL('../supabase/migrations/',import.meta.url),read=f=>readFileSync(new URL(f,dir),'utf8');
const fixture=JSON.parse(readFileSync(new URL('./fixtures/usdt-symbol-contract.json',import.meta.url)));
fixture.push({symbol:'A'.repeat(60)+'USDT',valid:true},{symbol:'A'.repeat(61)+'USDT',valid:false});
const pg=new PGlite();
await pg.exec(`create role anon;create role authenticated;create role service_role;
 create table v11_long_regime_signals(id uuid primary key);
 create table v11_long_regime_positions(id uuid primary key,signal_id uuid,entry_at timestamptz,entry_price numeric);`);
await pg.exec(read('20260920114124_cec0040_operational_state.sql'));
await pg.exec(read('20260924041645_cec0040_tables_accept_v30_branch.sql'));
await pg.exec(readFileSync(new URL('./fixtures/cec0040-production-before.sql',import.meta.url),'utf8'));
const migration=readdirSync(dir).find(f=>f.endsWith('_wusdt_symbol_lifecycle.sql'));
if(migration)await pg.exec(read(migration));
await pg.exec(`update v11_cec0040_state set bootstrap_complete=true,enforcement_enabled=true;`);
const at='2026-09-27T03:07:00Z',id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const decide=(n,symbol,branch='R62',time=at)=>pg.query('select v11_cec0040_decide($1,$2,$3,$4) as d',[id(n),time,symbol,branch]);
let seq=1;
for(const f of fixture)test('Postgres actual CEC and JS agree '+JSON.stringify(f.symbol),async()=>{
 const n=seq++;await pg.query('insert into v11_long_regime_signals values($1)',[id(n)]);
 let js=true;try{await fetchB06133Inputs(f.symbol,1790478420000,async()=>Response.json([]))}catch{js=false}
 let sql=true;try{await decide(n,f.symbol)}catch(e){sql=false;assert.match(e.message,/CEC0040_DECISION_INPUT_INVALID|invalid byte sequence.*0x00/)}
 assert.equal(sql,f.valid);assert.equal(js,sql);
});
test('W idempotency, branch, time and state identity protections',async()=>{
 await pg.query('insert into v11_long_regime_signals values($1),($2)',[id(200),id(201)]);
 const first=(await decide(200,'WUSDT','V30_SCORE')).rows[0].d;
 assert.equal(first.ready,true);const state=(await pg.query('select * from v11_cec0040_state')).rows[0];
 assert.equal((await decide(200,'WUSDT','V30_SCORE')).rows[0].d.idempotent,true);
 assert.deepEqual((await pg.query('select * from v11_cec0040_state')).rows[0],state);
 assert.equal((await pg.query('select count(*)::int n from v11_cec0040_decisions where signal_id=$1',[id(200)])).rows[0].n,1);
 await assert.rejects(()=>decide(200,'TUSDT','V30_SCORE'),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(()=>decide(201,'WUSDT','BAD'),/INPUT_INVALID/);
 await assert.rejects(()=>decide(201,'WUSDT',null),/INPUT_INVALID/);
 await assert.rejects(()=>decide(201,'WUSDT','R62',null),/INPUT_INVALID/);
 await assert.rejects(()=>decide(201,'WUSDT','R62','2026-09-27T03:06:00Z'),/TIME_REGRESSION/);
 await pg.exec("update v11_cec0040_state set config_hash='wrong'");
 await assert.rejects(()=>decide(201,'WUSDT'),/STATE_IDENTITY_INVALID/);
 await pg.query('update v11_cec0040_state set config_hash=$1',[state.config_hash]);
});
test('W target recovery, registration, observation and causal EWMA stay idempotent',async()=>{
 await pg.query('insert into v11_long_regime_positions values($1,$2,$3,0.0137)',[id(300),id(200),at]);
 assert.equal((await pg.query('select * from v11_cec0040_missing_targets()')).rows[0].symbol,'WUSDT');
 const register=()=>pg.query('select v11_cec0040_register_target($1,$2,$3,$4,$5,$6)',[id(300),id(200),'WUSDT','V30_SCORE',at,.0137]);
 await register();await register();assert.equal((await pg.query('select count(*)::int n from v11_cec0040_targets')).rows[0].n,1);
 const lag=(await decide(201,'WUSDT','R62','2026-09-27T03:08:00Z')).rows[0].d;
 assert.equal(lag.ready,false);assert.equal(lag.reason,'CEC0040_TARGET_OBSERVATION_LAG');
 const observe=()=>pg.query("select v11_cec0040_observe_target($1,'RESOLVED',$2,$2,2,'{}')",[id(300),'2026-09-27T03:07:30Z']);
 await observe();await observe();const before=(await pg.query('select training_count,ewma_usdt from v11_cec0040_state')).rows[0];
 await decide(201,'WUSDT','R62','2026-09-27T03:08:00Z');const after=(await pg.query('select training_count,ewma_usdt from v11_cec0040_state')).rows[0];
 assert.equal(after.training_count,before.training_count+1);assert.ok(Math.abs(Number(after.ewma_usdt)-(.05*2+.95*Number(before.ewma_usdt)))<1e-12);
 await decide(201,'WUSDT','R62','2026-09-27T03:08:00Z');assert.deepEqual((await pg.query('select training_count,ewma_usdt from v11_cec0040_state')).rows[0],after);
});
test.after(()=>pg.close());
