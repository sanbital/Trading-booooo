import test from 'node:test';
import assert from 'node:assert/strict';
import {exchangeMinuteWeight,restWeightLimit,recoveryOrder} from './bootstrap.mjs';
import {WeightBudget,Book,completeCaptureInterval} from './core.mjs';
const slot=1800000,window={version:'TOP20_CLOCK_CAPTURE_1',slot_ms:slot};
const candidates=Array.from({length:20},(_,i)=>({symbol:`C${i}USDT`,roles:['SCANNER_LEADER'],book:new Book()}));
test('clock REST capacity admits all twenty real depth snapshots without relaxing book or interval checks',()=>{
 const budget=new WeightBudget(),at=slot-150000,limit=restWeightLimit(window,candidates,at,2400);
 assert.equal(limit,600);
 for(const [i,s] of candidates.entries()){
  assert.equal(budget.claim(20,at+i*200,limit),true);
  s.book.snapshot({lastUpdateId:100,bids:[[99,5]],asks:[[101,5]]},at+i*200);
  assert.equal(s.book.ready,false,'a snapshot alone still does not prove a continuous book');
  s.book.event({U:101,u:102,pu:100,E:at+5000,b:[],a:[]},at+5000);
  assert.equal(completeCaptureInterval({...s,started:at,lastBucket:slot-120000,marketResetAt:at,marketSequenceVerified:true},slot-115000,true),true);
 }
 assert.equal(budget.used.reduce((n,x)=>n+x[1],0),400);
 for(let i=0;i<10;i++)assert.equal(budget.claim(20,at+5000+i,limit),true);
 assert.equal(budget.claim(1,at+6000,limit),false);
 assert.equal(budget.claim(1,at+7000,100),false,'returning to steady mode cannot erase burst history');
 assert.equal(budget.claim(20,at+66000,100),true);
});
test('elevated public weight is limited by live exchange metadata, admitted candidates and clock boundaries',()=>{
 assert.equal(exchangeMinuteWeight({rateLimits:[{rateLimitType:'REQUEST_WEIGHT',interval:'MINUTE',intervalNum:1,limit:2400}]}),2400);
 assert.equal(exchangeMinuteWeight({rateLimits:[]}),null);
 assert.equal(restWeightLimit(window,candidates,slot-150000,1200),300);
 assert.equal(restWeightLimit(window,candidates,slot-150000,null),100);
 for(const at of [slot-180001,slot+1000])assert.equal(restWeightLimit(window,candidates,at,2400),100);
 for(const states of [[],[{roles:['MARKET_SENSOR']}],[{roles:['OPEN_POSITION','SCANNER_LEADER']}]])assert.equal(restWeightLimit(window,states,slot-150000,2400),100);
 assert.equal(restWeightLimit(null,candidates,slot-150000,2400),100);
});
test('a repeatedly failing first candidate cannot starve the rest of the cohort; held recovery stays first',()=>{
 const states=candidates.map(s=>({...s,lastRestAttemptAt:0})),seen=[];
 for(let i=0;i<20;i++){const next=recoveryOrder(states)[0];seen.push(next.symbol);next.lastRestAttemptAt=1000+i;}
 assert.equal(new Set(seen).size,20);
 const held={symbol:'HELDUSDT',roles:['OPEN_POSITION'],lastRestAttemptAt:99999};
 assert.equal(recoveryOrder([...states,held])[0].symbol,'HELDUSDT');
});
