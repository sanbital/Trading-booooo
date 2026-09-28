import test from 'node:test';import assert from 'node:assert/strict';import {entryQueueWithLateReviews} from './entry-late-review.mjs';
test('late completed BUY joins serial queue once; existing order and dedup retained',async()=>{
 const queue=[{id:'first'},{id:'second'}],seen=[];let reads=0,completed=false;
 for await(const [i,s]of entryQueueWithLateReviews(queue,{mayDiscover:()=>true,discover:async()=>{reads++;assert.equal(completed,true);return[{id:'second'},{id:'late'},{id:'late'}];}})){seen.push([i,s.id]);if(s.id==='second')completed=true;}
 assert.deepEqual(seen,[[0,'first'],[1,'second'],[2,'late']]);assert.equal(reads,1);assert.equal(queue.length,3);
});
test('account stop during first candidate prevents even a late review read',async()=>{
 let reads=0;for await(const row of entryQueueWithLateReviews([{id:'first'}],{mayDiscover:()=>true,discover:async()=>{reads++;return[{id:'late'}];}})){assert.equal(row[1].id,'first');break;}assert.equal(reads,0);
});
test('remaining time or call reserve denial prevents discovery',async()=>{
 let allowed=true,reads=0;for await(const row of entryQueueWithLateReviews([{id:'first'}],{mayDiscover:()=>allowed,discover:async()=>{reads++;return[{id:'late'}];}})){allowed=false;}assert.equal(reads,0);
});
test('no initial approved BUY does not add a polling pass',async()=>{
 let reads=0;for await(const row of entryQueueWithLateReviews([],{mayDiscover:()=>true,discover:async()=>{reads++;return[{id:'late'}];}})){assert.fail('unexpected');}assert.equal(reads,0);
});
test('pending, WAIT and rejected reviews produce no queue entry and no polling loop',async()=>{
 let reads=0;const seen=[];for await(const row of entryQueueWithLateReviews([{id:'first'}],{mayDiscover:()=>true,discover:async()=>{reads++;return[];}}))seen.push(row[1].id);assert.deepEqual(seen,['first']);assert.equal(reads,1);
});
test('discovery read failure propagates closed; no late candidate is yielded',async()=>{
 const seen=[];await assert.rejects(async()=>{for await(const row of entryQueueWithLateReviews([{id:'first'}],{mayDiscover:()=>true,discover:async()=>{throw Error('JOURNAL_READ');}}))seen.push(row[1].id);},/JOURNAL_READ/);assert.deepEqual(seen,['first']);
});

