import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {qv3Entry,qv3Exit,qv3Stamp,qv3Scope,qv3AuditEvidence,QV3_ACTIVATION_BASIS,QV3_LIVE_CUTOVER,QV3_INPUT_EVIDENCE_VERSION} from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';
import {entryGate,exitSignal} from '../../supabase/functions/_shared/leader-qv3-rules.mjs';
const b=(t,o,h,l,c)=>[t,o,h,l,c,1,t+59999];
const xs=[b(0,100,101,99,100.5),b(60000,100.5,100.6,100,100.4),b(120000,100.4,100.5,100,100.3)];
const p={id:'p1',entryAt:0,entryPrice:100,ownership:'AUTO',side:'LONG',state:'OPEN'};
test('operator override has one immutable cutover and audit basis',()=>{
 assert.equal(QV3_LIVE_CUTOVER,Date.parse('2026-09-11T15:20:00.000Z'));
 assert.equal(QV3_ACTIVATION_BASIS,'OPERATOR_OVERRIDE_PROTOCOL_DEFER_20260911');
});
test('only exact chosen entry condition; unfinished/future bars ignored',()=>{
 assert.equal(qv3Entry(xs,180000).wouldBlock,true);assert.equal(qv3Entry(xs,179999).available,false);
 assert.deepEqual(qv3Entry([...xs,b(180000,200,220,150,210)],180000),qv3Entry(xs,180000));
});
test('duplicate, missing, null price, invalid OHLC, timestamp fail closed',()=>{
 for(const bars of [[...xs,xs[1]],xs.slice(1),xs.map((v,i)=>i===1?b(60000,null,100.6,100,100.4):v),xs.map((v,i)=>i===1?b(60000,100.5,99,100,100.4):v),xs.map((v,i)=>i===1?b(60001,100.5,100.6,100,100.4):v)]){
  const out=qv3Entry(bars,180000);assert.equal(out.available,false);assert.equal(out.wouldBlock,true);
 }
});
test('reverse response order sorts completed bars without changing result',()=>assert.deepEqual(qv3Entry([...xs].reverse(),180000),qv3Entry(xs,180000)));
test('high-only and equal +0.2 percent do not arm; strictly higher close does',()=>{
 const low=[b(0,100,110,99,100.2),b(60000,100.2,101,99,100.1),b(120000,100.1,101,99,100)];
 assert.equal(qv3Exit(p,low,180000).wouldClose,false);assert.equal(qv3Exit(p,xs,180000).wouldClose,true);
});
test('entry overlapping minute cannot arm; second bearish must have completed',()=>{
 assert.equal(qv3Exit({...p,entryAt:1},[xs[0],b(60000,100.2,101,99,100.1),b(120000,100.1,101,99,100)],180000).wouldClose,false);
 assert.equal(qv3Exit(p,xs,120000).wouldClose,false);assert.equal(qv3Exit(p,xs,180000).wouldClose,true);
});
test('persisted favorable completed close restores after process restart',()=>{
 const state=JSON.parse(JSON.stringify(qv3Exit(p,xs.slice(0,1),60000).state));
 assert.equal(qv3Exit(p,xs.slice(1),180000,state).wouldClose,true);
 assert.equal(qv3Exit({...p,id:'different'},xs.slice(1),180000,state).available,false);
 assert.equal(qv3Exit(p,xs.slice(1),180000,{...state,observedAt:180001}).available,false);
});
test('missing history does not invent a favorable excursion',()=>assert.equal(qv3Exit(p,xs.slice(1),180000).available,false));
test('manual external unknown and closed positions never create QV3 exit',()=>{
 for(const ownership of ['MANUAL','EXTERNAL','UNKNOWN',undefined])assert.equal(qv3Exit({...p,ownership},xs,180000).wouldClose,false);
 assert.equal(qv3Exit({...p,state:'CLOSED'},xs,180000).wouldClose,false);
});
test('activation stamp is per position and cannot admit pre-cutover positions',()=>{
 assert.equal(qv3Stamp(60000,0),null);assert.equal(qv3Scope(p,0),false);
 const stamp=qv3Stamp(0,0);assert.equal(stamp.basis,QV3_ACTIVATION_BASIS);
 assert.equal(qv3Scope({...p,qv3:stamp},0),true);
 assert.equal(qv3Scope({...p,qv3:{...stamp,basis:'UNVERIFIED'}},0),false);
 assert.equal(qv3Scope({...p,qv3:qv3Stamp(0,0)},1),false);
});
test('assessment never mutates peak, stop, partial status or remaining quantity',()=>{
 const state={...p,peakPrice:110,stopPrice:105,t1_completed:true,remaining_quantity:.3};
 const before=structuredClone(state);qv3Exit(state,xs,180000);assert.deepEqual(state,before);
});
test('audit evidence captures only the exact last two completed response candles and cannot affect state',()=>{
 const forming=b(180000,100.3,100.4,100.2,100.35),input=[forming,...xs].reverse(),before=structuredClone(input);
 const evidence=qv3AuditEvidence(input,180000,179999,179900);
 assert.equal(evidence.version,QV3_INPUT_EVIDENCE_VERSION);assert.equal(evidence.status,'CAPTURED');
 assert.deepEqual(evidence.tail.map(row=>row.openTimeMs),[60000,120000]);
 assert.deepEqual(input,before);assert.equal(evidence.responseRows,4);assert.equal(evidence.validCompletedRows,3);
 assert.equal(evidence.requestToEvaluationMs,100);
 assert.deepEqual(qv3AuditEvidence(null,180000).tail,[]);
});
test('research and runtime chosen rules match on deterministic complete histories',()=>{
 let seed=321,count=0;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let n=0;n<1000;n++){
  let close=100;const bars=Array.from({length:10},(_,i)=>{const open=close;close=open*(1+(random()-.5)*.01);return b(i*60000,open,Math.max(open,close)+.01,Math.min(open,close)-.01,close);});
  assert.equal(qv3Entry(bars,600000).wouldBlock,entryGate(bars,600000,'ENTRY_EXIT_TWO').reject);
  assert.equal(qv3Exit(p,bars,600000).wouldClose,exitSignal(p,bars,600000,'ENTRY_EXIT_TWO'));count++;
 }
 assert.equal(count,1000);
});
