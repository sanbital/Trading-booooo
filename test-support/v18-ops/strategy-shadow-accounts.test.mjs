import test from 'node:test';
import assert from 'node:assert/strict';
import {replayAccounts,observationFrame} from '../../research/20260911_trade_audit/paper-accounts.mjs';
import {paperMarket} from '../../supabase/functions/_shared/leader-paper-market.mjs';
const t=Date.parse('2026-09-11T12:00:00Z');
const config={initialBalance:100,marginUsdt:40,leverage:3,maxSlots:10};
const rule={step:.001,tick:.01,minNotional:5,trading:true};
const quote=(symbol,price,at,extra={})=>({symbol,bid:price,ask:price,bidQty:100,askQty:100,at,...extra});
const signal=(symbol,at,price=100,extra={})=>({id:`${symbol}:${at}`,features:{symbol,strategy:'LEADER_MOMENTUM_V17',
  signal5Close:at,referenceClose:price,stopPct:.025,return5m:.01,rank:1,...extra}});
const frame=(i,quotes,signals=[],extra={})=>({id:String(i),at:t+i*60000,marketComplete:true,entryDataComplete:true,
  quotes:quotes.map(q=>quote(q[0],q[1],t+i*60000,q[2])),signals,rules:{AUSDT:rule,BUSDT:rule,CUSDT:rule},...extra});
const run=(frames,c={})=>replayAccounts(frames,{...config,...c});

test('independent earlier exit frees a slot/cash for a replacement opportunity',()=>{
  const r=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',101.6]]),
    frame(2,[['AUSDT',100.7],['BUSDT',100]],[signal('BUSDT',t+120000)]),
    frame(3,[['AUSDT',97],['BUSDT',102]])],{initialBalance:41,maxSlots:1});
  assert.equal(r.accounts.BASELINE.closed.length,1);
  assert.equal(r.accounts.BASELINE.positions.length,0);
  assert.equal(r.accounts.LOCK_1P5.closed.length,1);
  assert.equal(r.accounts.LOCK_1P5.positions[0].symbol,'BUSDT');
  assert.ok(r.accounts.LOCK_1P5.summary.markedNet>r.accounts.BASELINE.summary.markedNet);
});
test('fees debit wallet, leveraged unrealized loss and occupied margin reduce free cash',()=>{
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',99]])]).accounts.BASELINE;
  const p=a.positions[0],last=a.curve.at(-1);
  assert.ok(Math.abs(last.wallet-(100-p.entryFee))<1e-9);
  assert.ok(Math.abs(last.equity-(last.wallet-p.quantity))<1e-9);
  assert.ok(Math.abs(last.free-(last.equity-p.quantity*100/3))<1e-9);
  assert.ok(a.summary.markedNet<0);assert.equal(a.summary.closed,0);
});
test('IOC entry uses visible quantity; does not invent a full requested fill',()=>{
  const a=run([frame(0,[['AUSDT',100,{askQty:.25}]],[signal('AUSDT',t)])]).accounts.BASELINE;
  assert.equal(a.positions[0].quantity,.25);assert.ok(a.events.find(e=>e.type==='ENTRY_FILL').requested>1);
});
test('partial exit remains open and repeated unchanged L1 data is not fresh liquidity',()=>{
  const frames=[frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',97,{bidQty:.5}]]),
    frame(2,[['AUSDT',97,{bidQty:.5,at:t+60000}]]),frame(3,[['AUSDT',96]])];
  const interim=run(frames.slice(0,3)).accounts.BASELINE;
  assert.equal(interim.closed.length,0);assert.equal(interim.positions[0].exitFills.length,1);
  const a=run(frames).accounts.BASELINE;
  assert.equal(a.closed.length,1);assert.equal(a.closed[0].exitFills.length,2);
  assert.ok(Math.abs(a.wallet-(100+a.closed[0].net))<1e-9);
});
test('latency waits for next available quote; a rebound never cancels triggered exit',()=>{
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',100]]),
    frame(2,[['AUSDT',97]]),frame(3,[['AUSDT',99]])],{latencyMs:60000}).accounts.BASELINE;
  assert.equal(a.closed[0].entryAt,t+60000);assert.equal(a.closed[0].closedAt,t+180000);
  assert.equal(a.closed[0].exitFills[0].price,99);assert.equal(a.closed[0].exitFills[0].signalDelayMs,60000);
});
test('pending entry reserves slot/cash and duplicate signal cannot submit twice',()=>{
  const s=signal('AUSDT',t);
  const a=run([frame(0,[['AUSDT',100]],[s]),frame(1,[['AUSDT',100]],[s])],{latencyMs:60000}).accounts.BASELINE;
  assert.ok(a.curve[0].reserved>40);assert.equal(a.events.filter(e=>e.type==='ENTRY_INTENT').length,1);
  assert.equal(a.positions.length,1);
});
test('delayed IOC above its original limit expires without fabricated execution',()=>{
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',100.5]])],{latencyMs:60000}).accounts.BASELINE;
  assert.equal(a.positions.length,0);assert.equal(a.wallet,100);assert.equal(a.pendingEntries.length,0);
});
test('same signal can be reconsidered after insufficient cash is released',()=>{
  const b=signal('BUSDT',t+60000);
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',101],['BUSDT',100]],[b]),
    frame(2,[['AUSDT',103],['BUSDT',100]],[b]),frame(3,[['AUSDT',101.4],['BUSDT',100]],[b])],{initialBalance:41}).accounts.BASELINE;
  assert.equal(a.positions[0].symbol,'BUSDT');assert.equal(a.summary.opportunities,2);
});
test('missing one quote does not stop another position protection; MTM becomes unknown',()=>{
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',100],['BUSDT',100]],[signal('BUSDT',t+60000)]),
    frame(2,[['BUSDT',97]],[],{entryDataComplete:false})]).accounts.BASELINE;
  assert.equal(a.closed[0].symbol,'BUSDT');assert.equal(a.positions[0].symbol,'AUSDT');
  assert.equal(a.summary.markedNet,null);assert.equal(a.summary.completeDrawdown,null);
});
test('future and stale quotes cannot fill or mark a position',()=>{
  for(const at of [t+1,t-90001]){
    const a=run([frame(0,[['AUSDT',100,{at}]],[signal('AUSDT',t)])]).accounts.BASELINE;
    assert.equal(a.positions.length,0);
  }
});
test('replaying after restart is deterministic; exact duplicate idempotent, conflicting/reversed frames rejected',()=>{
  const a=frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),b=frame(1,[['AUSDT',99]]);
  assert.deepEqual(run([a,a,b]),run([a,b]));assert.deepEqual(run([a,b]),run(JSON.parse(JSON.stringify([a,b]))));
  assert.throws(()=>run([a,{...a,entryDataComplete:false}]),/CONFLICTING/);
  assert.throws(()=>run([b,a]),/OUT_OF_ORDER/);
});
test('observation gaps are retained as incomplete drawdown, never interpolated away',()=>{
  const a=run([frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(3,[['AUSDT',99]])]).accounts.BASELINE;
  assert.equal(a.summary.completeDrawdown,null);assert.ok(a.summary.maxObservedDrawdown>0);
});
test('repeat-stop variant uses its own simulated settlements, never actual trade history',()=>{
  const f=[];
  for(let i=0;i<3;i++){f.push(frame(i*2,[['AUSDT',100]],[signal('AUSDT',t+i*120000)]));f.push(frame(i*2+1,[['AUSDT',97]]));}
  const r=run(f);
  assert.equal(r.accounts.BASELINE.closed.length,3);assert.equal(r.accounts.REPEAT_STOP_2.closed.length,2);
});
test('higher fees and adverse exit impact cannot manufacture a better same-path outcome',()=>{
  const f=[frame(0,[['AUSDT',100]],[signal('AUSDT',t)]),frame(1,[['AUSDT',97]])];
  const normal=run(f).accounts.BASELINE.summary,stress=run(f,{feeRate:.001,slippageBps:2}).accounts.BASELINE.summary;
  assert.ok(stress.markedNet<normal.markedNet);assert.ok(stress.fees>normal.fees);
});
test('old observer data without books is unavailable rather than entry-close-price filled',()=>{
  const f=observationFrame({payload:{version:'old',asOf:new Date(t).toISOString(),evaluationState:'EVALUATED',
    source:{confirmations:[{feature:signal('AUSDT',t).features}]}}});
  const r=run([f]);assert.equal(r.accounts.BASELINE.positions.length,0);assert.equal(r.accounts.BASELINE.summary.incompleteFrames,1);
});
test('public collector retains books for de-ranked symbols and only recorded candidate rules',()=>{
  const raw=['AUSDT','BUSDT'].map(symbol=>({symbol,bidPrice:'1',askPrice:'1.001',bidQty:'10',askQty:'2',time:t}));
  const info={symbols:[{symbol:'AUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',underlyingType:'COIN',
    filters:[{filterType:'LOT_SIZE',stepSize:'1'},{filterType:'PRICE_FILTER',tickSize:'.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]};
  const m=paperMarket(raw,info,['AUSDT'],t);assert.equal(m.quotes.length,2);assert.equal(m.rules.AUSDT.step,1);
  assert.throws(()=>paperMarket([raw[0],raw[0]],info,['AUSDT'],t),/DUPLICATE/);
});
