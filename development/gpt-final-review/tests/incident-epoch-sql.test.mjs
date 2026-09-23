// External-writer escalation trigger on PGlite: the lease-owning executor's own
// last_error update is recorded but not escalated; everything else escalates as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const dependency=process.env.PGLITE_MODULE;
if(!dependency)throw Error('Set PGLITE_MODULE to the installed @electric-sql/pglite/dist/index.js');
const {PGlite}=await import(pathToFileURL(dependency).href);
const fix=readFileSync(new URL('../sql/v18_external_incident_epoch_executor_owner.sql',import.meta.url),'utf8');
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
async function setup(){
  const pg=new PGlite();
  await pg.exec(`create table public.v17_execution_lease(singleton boolean primary key,owner uuid,expires_at timestamptz);
    insert into public.v17_execution_lease values(true,'${OWNER}',clock_timestamp()+interval '5 minutes');
    create table public.v18_ops_incidents(id uuid primary key,generation bigint,kind text,reason text,evidence jsonb);
    create table public.v11_long_regime_runtime(singleton boolean primary key,circuit_open boolean,circuit_reason text,last_error text,
      incident_id uuid,incident_generation bigint,incident_kind text,incident_opened_at timestamptz,incident_resolved_at timestamptz);
    insert into public.v11_long_regime_runtime values(true,true,'ACCOUNT_ENTRY_HOLD:X','ACCOUNT_ENTRY_HOLD:X','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',10,'INCOMPLETE_OR_STALE_SNAPSHOT',now(),null);
`);
  await pg.exec('begin;'+fix+'commit;');
  await pg.exec(`create trigger v18_external_incident_epoch before update on public.v11_long_regime_runtime for each row execute function public.v18_external_incident_epoch();`);
  return pg;
}
const hdr=o=>`select set_config('request.headers','${JSON.stringify(o?{'x-v18-execution-owner':o}:{})}',false)`;
const rt=async pg=>{const r=(await pg.query('select incident_kind,incident_generation,last_error from public.v11_long_regime_runtime')).rows[0];return {...r,incident_generation:Number(r.incident_generation)};};
const incidents=async pg=>(await pg.query('select count(*)::int n from public.v18_ops_incidents')).rows[0].n;
test('lease owner cycle error is recorded in last_error without escalation',async()=>{const pg=await setup();await pg.exec(hdr(OWNER));
  await pg.exec(`update public.v11_long_regime_runtime set last_error='RECOVERY_CAS:lock timeout'`);
  assert.deepEqual(await rt(pg),{incident_kind:'INCOMPLETE_OR_STALE_SNAPSHOT',incident_generation:10,last_error:'RECOVERY_CAS:lock timeout'});assert.equal(await incidents(pg),0);});
test('writer without header still escalates',async()=>{const pg=await setup();await pg.exec(hdr(null));
  await pg.exec(`update public.v11_long_regime_runtime set last_error='X2'`);const r=await rt(pg);
  assert.equal(r.incident_kind,'MANUAL_REVIEW_REQUIRED');assert.equal(r.incident_generation,11);assert.equal(await incidents(pg),1);});
test('non-owner or expired lease still escalates',async()=>{const pg=await setup();await pg.exec(hdr(OTHER));
  await pg.exec(`update public.v11_long_regime_runtime set last_error='X2'`);assert.equal((await rt(pg)).incident_kind,'MANUAL_REVIEW_REQUIRED');
  const pg2=await setup();await pg2.exec(`update public.v17_execution_lease set expires_at=clock_timestamp()-interval '1 second'`);await pg2.exec(hdr(OWNER));
  await pg2.exec(`update public.v11_long_regime_runtime set last_error='X2'`);assert.equal((await rt(pg2)).incident_kind,'MANUAL_REVIEW_REQUIRED');});
test('circuit_reason change or circuit opening escalates even for the owner',async()=>{const pg=await setup();await pg.exec(hdr(OWNER));
  await pg.exec(`update public.v11_long_regime_runtime set circuit_reason='OTHER'`);assert.equal((await rt(pg)).incident_kind,'MANUAL_REVIEW_REQUIRED');
  const pg2=await setup();await pg2.exec(`update public.v11_long_regime_runtime set circuit_open=false`);await pg2.exec(hdr(OWNER));
  await pg2.exec(`update public.v11_long_regime_runtime set circuit_open=true,last_error='E'`);assert.equal((await rt(pg2)).incident_kind,'MANUAL_REVIEW_REQUIRED');});
test('malformed header does not bypass escalation',async()=>{const pg=await setup();await pg.exec(`select set_config('request.headers','not json',false)`);
  await pg.exec(`update public.v11_long_regime_runtime set last_error='X2'`);assert.equal((await rt(pg)).incident_kind,'MANUAL_REVIEW_REQUIRED');});
