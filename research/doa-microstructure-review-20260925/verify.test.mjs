import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url)));
test('historical linkage is unique and missing labels are not counted as non-DOA',()=>{
 const h=read('historical.json'),d=read('snapshot.json'),r=read('results.json');
 assert.equal(h.length,68);assert.equal(new Set(h.map(x=>x.signal_id)).size,68);
 assert.equal(new Set(d.candidates.map(x=>x.signal_id)).size,d.candidates.length);
 assert.equal(r.claim1.replayBUY68.doa,9);assert.equal(r.claim1.allStoredInitial.labelled,81);
 assert.equal(r.claim1.allStoredInitial.rows,103);assert.equal(r.claim1.v17OrderSnapshots.labelled,511);
});
test('trade fee and quantity accounting independently reconciles closed positions',()=>{
 const r=read('results.json');assert.equal(r.claim3.n,83);assert.equal(r.claim3.quantityMismatches,0);
 assert.equal(r.claim3.missingFees,0);assert.ok(r.claim3.maxNetDifference<.00005);
 assert.ok(Math.abs(r.claim3.grossFromFills-r.claim3.entryFee-r.claim3.exitFee-r.claim3.netFromFills)<1e-9);
 assert.equal(r.claim2.all.orderAsk.n,15);assert.equal(r.claim2.all.reference.n,83);
});
test('multiple-comparison outputs and unknown market evidence preserve limits',()=>{
 const r=read('results.json');for(const c of Object.values(r.claim1))for(const t of c.tests??[]){if(t.p!==undefined){assert.ok(t.p>0&&t.p<=1);assert.ok(t.holm>=t.p&&t.holm<=1);}}
 assert.equal(r.claim4.initialToPreDispatch.exactAtCompletion,0);
 assert.equal(r.metadata.scope,'DEV_ONLY');assert.ok(r.claim4.initialToPreDispatch.afterApiCompletedMs.min>0);
});
test('draft schema rejects future labels, nonempty authority and unauthorized table access',async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);const db=new PGlite();
 try{
 await db.exec('create role anon; create role authenticated;');
 await db.exec(fs.readFileSync(new URL('capture-schema.draft.sql',import.meta.url),'utf8'));
 const id='00000000-0000-0000-0000-000000000001',signal='00000000-0000-0000-0000-000000000002';
 await db.query("insert into doa_research.runs(id,protocol_sha256,starts_at,ends_at) values($1,repeat('a',64),'2026-10-01','2026-10-15')",[id]);
 const access=await db.query("select has_table_privilege('anon','doa_research.micro_buckets','SELECT') anon_read,has_table_privilege('doa_capture_writer','doa_research.labels','SELECT') future_read,has_table_privilege('doa_capture_writer','doa_research.runs','UPDATE') control_write");
 assert.deepEqual(access.rows[0],{anon_read:false,future_read:false,control_write:false});
 await db.query("insert into doa_research.candidates values($1,$2,'BTCUSDT','2026-10-01','2026-10-01',null,null,'patch','hash','DEV','PENDING','source')",[id,signal]);
 await assert.rejects(db.query("insert into doa_research.labels(run_id,signal_id,horizon_minutes,anchor_kind,anchor_at,anchor_price,evaluated_at,coverage_complete,label_version,source_hash) values($1,$2,60,'DECISION_ASK','2026-10-01',1,'2026-10-01 00:59Z',true,'v1','hash')",[id,signal]));
 await assert.rejects(db.query("insert into doa_research.shadow_decisions(run_id,signal_id,arm,task,packet_hash,prompt_hash,model_version,input_available_at,started_at,deadline_at,valid,authority) values($1,$2,'E','ENTRY','p','h','m','2026-10-01','2026-10-01','2026-10-01 00:01Z',true,'[\"BUY\"]')",[id,signal]));
 const tables=await db.query("select tablename,rowsecurity from pg_tables where schemaname='doa_research'");assert.equal(tables.rows.length,6);assert.ok(tables.rows.every(x=>x.rowsecurity));
 }finally{await db.close();}
});
