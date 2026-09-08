import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextExit,POLICY,portfolioMatches} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {EXIT_REVIEW_CANDIDATE as C,nextExitReviewed,costBreakeven,exitAttemptId,protectiveStopSpec,classifyExitResponse} from '../../supabase/functions/_shared/leader-exit-review.mjs';
const pos={entryPrice:100,entryAt:0,peakPrice:100,stopPrice:97.5,lastHighAt:0,entryFee:.05,quantity:1};
const step=(p,b,t,c=C)=>nextExitReviewed(p,b,t,c);
const carry=(p,s)=>({...p,peakPrice:s.peakPrice,stopPrice:s.stopPrice,lastHighAt:s.lastHighAt});

test('candidate disabled preserves every observed V17 decision',()=>{
 const ps=JSON.parse(readFileSync(new URL('./evidence/positions.json',import.meta.url)));
 const ds=JSON.parse(readFileSync(new URL('./evidence/decisions.json',import.meta.url)));
 for(const p of ps){let state={entryPrice:+p.entry_price,entryAt:Date.parse(p.entry_at),peakPrice:+p.entry_price,stopPrice:+p.entry_price*.975,lastHighAt:Date.parse(p.entry_at)};
  for(const d of ds.filter(x=>x.position_id===p.id)){
   const now=Date.parse(d.decided_at),bid=d.details.bid,a=nextExit(state,bid,now,POLICY),b=nextExitReviewed(state,bid,now);
   assert.deepEqual(b,a);assert.equal(a.action,d.details.action);assert.equal(a.reason,d.details.reason);
   assert.ok(Math.abs(a.stopPrice-d.details.stopPrice)<1e-10);state=carry(state,a);
  }
 }
});
test('initial adverse move retains original hard stop',()=>{
 const s=step(pos,98.2,60000);assert.equal(s.action,'HOLD');assert.equal(s.stopPrice,97.5);
});
test('cost breakeven includes both fees and assumed exit slippage',()=>{
 const trigger=costBreakeven(100,.05,1,.0005,.001),fill=trigger*(1-.001);
 assert.ok(Math.abs((fill-100)-.05-fill*.0005)<1e-10);
});
test('profit below 3 percent receives protection after a favorable move',()=>{
 const a=step(pos,101.2,60000);assert.equal(a.protectionStage,'COST_BREAKEVEN');
 const b=step(carry(pos,a),100,120000);assert.equal(b.action,'CLOSE');assert.ok(b.stopPrice>100);
});
test('2 percent profit starts monotone capture without partial selling',()=>{
 const a=step(pos,102.2,60000);assert.equal(a.protectionStage,'PROFIT_LOCK');assert.ok(Math.abs(a.stopPrice-101.1)<1e-10);
 const b=step(carry(pos,a),101,120000);assert.equal(b.action,'CLOSE');assert.ok(b.stopPrice>=a.stopPrice);
});
test('3 percent and above retains the legacy winner trailing stop',()=>{
 const a=step(pos,110,60000);assert.equal(a.stopPrice,108.35);
 const b=step(carry(pos,a),109,120000);assert.equal(b.action,'HOLD');assert.equal(b.stopPrice,108.35);
});
test('gapped quote exits at observed quote, not at a fabricated stop fill',()=>{
 const a=step(pos,101.2,60000),b=step(carry(pos,a),98.5,120000);
 assert.equal(b.action,'CLOSE');assert.equal(b.priceReturn,98.5/100-1);assert.ok(b.stopPrice>100);
});
test('invalid costs, future state and malformed thresholds reject',()=>{
 assert.throws(()=>step({...pos,entryFee:NaN},101,1000));
 assert.throws(()=>step({...pos,entryAt:1001},101,1000));
 assert.throws(()=>step(pos,101,1000,{...C,profitLockCapture:1}));
});
test('protective stop never loosens across deterministic quote sequences',()=>{
 let p=pos;for(let i=1;i<100;i++){const s=step(p,100+i*.15+Math.sin(i)*.05,i*1000);assert.ok(s.stopPrice>=p.stopPrice);p=carry(p,s);}
});
test('exit identifier survives position prefix truncation and is stable per attempt',async()=>{
 const p='b9501639-d5b1-4d4d-8478-d432f8f862ca';
 assert.equal(await exitAttemptId(p,'A'),await exitAttemptId(p,'A'));
 assert.notEqual(await exitAttemptId(p,'A'),await exitAttemptId(p,'B'));
 assert.ok((await exitAttemptId(p,'A')).length<=36);
});
test('partial and ambiguous fills cannot be marked fully closed',()=>{
 assert.deepEqual(classifyExitResponse(10,4,'EXPIRED',1),{state:'PARTIALLY_FILLED',remaining:6,closed:false});
 assert.equal(classifyExitResponse(10,10,'FILLED',1).closed,true);
 assert.equal(classifyExitResponse(10,0,'UNKNOWN',1).state,'RECONCILIATION_FAILED');
 assert.throws(()=>classifyExitResponse(10,11,'FILLED',1));
});
const args={symbol:'FORMUSDT',positionId:'example',ownedQuantity:309,exchangeQuantity:309,positionMode:'ONE_WAY',stopPrice:.37894365,priceTick:.0001,quantityStep:.1,clientAlgoId:'tb-stop-example',manualSymbols:['MAGMAUSDT']};
test('native stop specification uses Algo API and owned reduce-only quantity',()=>{
 const s=protectiveStopSpec(args);assert.equal(s.path,'/fapi/v1/algoOrder');assert.equal(s.params.reduceOnly,'true');
 assert.equal(s.params.triggerPrice,.379);assert.equal(s.params.quantity,309);assert.equal(s.executionEnabled,false);
 assert.ok(!Object.hasOwn(s.params,'closePosition'));
});
test('manual symbol, position mismatch, hedge mode and residual quantity reject',()=>{
 assert.throws(()=>protectiveStopSpec({...args,symbol:'MAGMAUSDT'}));
 assert.throws(()=>protectiveStopSpec({...args,exchangeQuantity:310}));
 assert.throws(()=>protectiveStopSpec({...args,positionMode:'HEDGE'}));
 assert.throws(()=>protectiveStopSpec({...args,ownedQuantity:309.05,exchangeQuantity:309.05}));
});
