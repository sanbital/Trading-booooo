import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

test('real external-incident trigger survives telemetry and still fences legacy circuit changes',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(`create table v11_long_regime_runtime(singleton boolean,circuit_open boolean,circuit_reason text,last_error text,incident_id uuid,incident_generation bigint,incident_kind text,incident_opened_at timestamptz,incident_resolved_at timestamptz,last_cycle_completed_at text,last_success_at text);
 create table v18_ops_incidents(id uuid,generation bigint,kind text,reason text,evidence jsonb);
 insert into v11_long_regime_runtime values(true,true,'ACCOUNT_ENTRY_HOLD:ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE','OWNED','00000000-0000-0000-0000-000000000145',145,'INCOMPLETE_OR_STALE_SNAPSHOT',now(),null,null,'old');`);
 const sql=readFileSync(new URL('../supabase/migrations/20260911000759_v18_ops_isolation.sql',import.meta.url),'utf8');
 await db.exec(sql.slice(sql.indexOf('create or replace function public.v18_external_incident_epoch()'),sql.indexOf('drop trigger if exists v18_external_incident_epoch')));
 await db.exec('create trigger v18_external_incident_epoch before update on v11_long_regime_runtime for each row execute function v18_external_incident_epoch()');
 await db.exec("update v11_long_regime_runtime set last_cycle_completed_at='tick' where singleton;update v11_long_regime_runtime set last_error=null,last_success_at='tick' where singleton and circuit_open=false");
 let r=(await db.query('select * from v11_long_regime_runtime')).rows[0];assert.equal(r.incident_generation,145);assert.equal(r.last_error,'OWNED');assert.equal(r.last_success_at,'old');
 await db.exec("update v11_long_regime_runtime set circuit_open=false;update v11_long_regime_runtime set last_cycle_completed_at='next';update v11_long_regime_runtime set circuit_open=true,circuit_reason='NEW_CAUSE',last_error='NEW_CAUSE';update v11_long_regime_runtime set last_error=null,last_success_at='next' where singleton and circuit_open=false");
 r=(await db.query('select * from v11_long_regime_runtime')).rows[0];assert.equal(r.incident_generation,146);assert.equal(r.incident_kind,'MANUAL_REVIEW_REQUIRED');assert.equal(r.last_error,'NEW_CAUSE');assert.equal(r.last_success_at,'old');
 assert.equal((await db.query('select count(*)::int n from v18_ops_incidents')).rows[0].n,1);
 await db.exec("update v11_long_regime_runtime set last_error='LEGACY_EXTERNAL_CHANGE'");
 assert.equal((await db.query('select incident_generation from v11_long_regime_runtime')).rows[0].incident_generation,147);
});
