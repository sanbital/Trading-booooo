import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {COLLECTOR_BASELINE,COLLECTOR_APP,assertCollectorRepairState,collectorReplacement} from '../ops/deterministic/collector-repair-policy.mjs';
const source='5ccc46fa3ccc88aaeddb41602eb401efbc6f48c4',postmaster='2026-10-03T12:16:55.400305Z';
const ready=()=>({paused:true,enabled:true,generation:2,source,gpt_off:true,batch_off:true,open_positions:0,unresolved_orders:0,incidents:0,circuit_open:false,protection_health:'FLAT',recovery_complete:true,recovered_postmaster:postmaster,postmaster,capture_enabled:true,capture_production:true});
test('collector replacement refuses changed financial truth, permissions and restart recovery',()=>{
 assert.doesNotThrow(()=>assertCollectorRepairState(ready(),source,postmaster));
 for(const change of [{paused:false},{open_positions:1},{unresolved_orders:1},{incidents:1},{gpt_off:false},{batch_off:false},{recovery_complete:false},{recovered_postmaster:'changed'},{postmaster:'changed'},{source:'different'},{capture_production:false}])assert.throws(()=>assertCollectorRepairState({...ready(),...change},source,postmaster));
});
test('replacement preserves private configuration and changes only the exact collector image',()=>{
 const protocol='a'.repeat(64),sha='b'.repeat(40),cfg={image:`registry.fly.io/${COLLECTOR_APP}:${COLLECTOR_BASELINE}`,env:{CAPTURE_ENDPOINT:'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest',PROTOCOL_SHA256:protocol,CAPTURE_TOKEN:'test-only-opaque-value'},guest:{cpus:4,memory_mb:1024},restart:{policy:'always'},auto_destroy:false};
 const machine={state:'started',instance_id:'v1',config:cfg},replacement=collectorReplacement(machine,sha,protocol);
 assert.deepEqual({...replacement,image:cfg.image},cfg);assert.equal(replacement.env,cfg.env);assert.equal(machine.config.image,cfg.image);
 for(const change of [{image:'foreign'},{auto_destroy:true},{services:[{}]},{mounts:[{}]},{env:{...cfg.env,SOURCE_COMMIT:COLLECTOR_BASELINE}}])assert.throws(()=>collectorReplacement({...machine,config:{...cfg,...change}},sha,protocol));
});
test('repair CLI rejects branch and commit drift before touching credentials or production',()=>{
 const sha='b'.repeat(40),env={GITHUB_REPOSITORY:'sanbital/Trading-booooo',GITHUB_SHA:sha,EXPECTED_COMMIT:sha,GITHUB_REF:'refs/heads/main'};
 for(const change of [{GITHUB_REF:'refs/heads/foreign'},{EXPECTED_COMMIT:'c'.repeat(40)}]){
  const result=spawnSync(process.execPath,[new URL('../ops/deterministic/collector-repair.mjs',import.meta.url).pathname],{env:{...env,...change},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/COLLECTOR_REPAIR_EXACT_MAIN/);assert.equal(result.stdout,'');
 }
});
