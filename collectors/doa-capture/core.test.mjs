import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Book,Flow,WeightBudget,vwap,inWindow,streamURLs,transportFresh} from './core.mjs';
test('Binance public book and market trade/kline routes are separated',()=>{const u=streamURLs('BTCUSDT');assert.equal(new URL(u.book).pathname,'/public/stream');assert.equal(new URL(u.market).pathname,'/market/stream');assert.equal(new URL(u.market).searchParams.get('streams'),'btcusdt@aggTrade/btcusdt@kline_1m/btcusdt@forceOrder');});
test('bounded pre-snapshot buffer discards old events without declaring continuity',()=>{const b=new Book();for(let i=1;i<=300;i++)b.event({U:i,u:i,pu:i-1,b:[],a:[],E:i},i);assert.equal(b.buffer.length,200);assert.equal(b.ready,false);assert.throws(()=>b.snapshot(snap),/GAP/);});
const snap={lastUpdateId:10,bids:[[99,10],[98,10]],asks:[[101,10],[102,10]]};
const event=(u,pu=10)=>({U:u,u,pu,b:[],a:[],E:1000});
test('snapshot is unusable until bridging event; loss of sequence rejects',()=>{const b=new Book();b.snapshot(snap);assert.equal(b.metrics(1000).book_complete,false);b.event({...event(11),U:10},1000);assert.equal(b.metrics(1000).book_complete,true);assert.throws(()=>b.event(event(14,12),1100),/GAP/);});
test('buffer applies in order and stale snapshot cannot silently skip data',()=>{const b=new Book();b.event({...event(11),U:10},1000);b.snapshot(snap);assert.equal(b.last,11);assert.throws(()=>{const c=new Book();c.event(event(20),1000);c.snapshot(snap);},/GAP/);});
test('depth bands incomplete stay flagged; stale book rejected',()=>{const b=new Book();b.snapshot({lastUpdateId:10,bids:[[99.99,10]],asks:[[100.01,10]]});b.event({...event(11),U:10},1000);assert.equal(b.metrics(1000).coverage_50,false);assert.equal(b.metrics(5000).book_complete,false);});
test('displayed additions/removals measure gross updates, not snapshot net',()=>{const b=new Book();b.snapshot(snap);b.event({...event(11),U:10},1000);b.event({...event(12,11),a:[[101,15]]},1100);b.event({...event(13,12),a:[[101,10]]},1200);assert.equal(b.add,505);assert.equal(b.remove,505);});
test('VWAP conserves quote, unavailable liquidity returns null',()=>{assert.equal(vwap([[100,1],[110,1]],210),105);assert.equal(vwap([[100,1]],101),null);});
test('trade gap marks incomplete; duplicate ignored; next full bucket recovers',()=>{const f=new Flow();f.event({a:1,p:100,q:2,T:1000,m:true});f.event({a:1,p:100,q:2,T:1000,m:true});assert.equal(f.sell,200);assert.equal(f.complete,false);f.reset();f.event({a:2,p:100,q:1,T:2000,m:false});assert.equal(f.complete,true);f.event({a:4,p:100,q:1,T:2000,m:true});assert.equal(f.complete,false);});
test('rolling REST cap has no minute-boundary burst',()=>{const b=new WeightBudget();for(let i=0;i<5;i++)assert.equal(b.claim(20,i),true);assert.equal(b.claim(2,59000),false);assert.equal(b.claim(20,60001),true);});
test('window includes actual prehistory and rejects unrelated symbols',()=>{const w=[{symbol:'BTCUSDT',at:new Date(100000).toISOString()}];assert.equal(inWindow(40000,w,'BTCUSDT'),true);assert.equal(inWindow(220000,w,'BTCUSDT'),true);assert.equal(inWindow(220001,w,'BTCUSDT'),false);assert.equal(inWindow(40000,w,'ETHUSDT'),false);});

test('coverage drift resyncs the existing book; intrinsic shallow coverage does not cause REST loops',()=>{
 const b=new Book();
 b.snapshot({lastUpdateId:10,bids:[[100,1],[99,1]],asks:[[100.1,1],[101,1]]},0);
 b.event({U:10,u:11,pu:10,E:1,b:[],a:[]},1);
 assert.equal(b.needsCoverageRefresh(1),false);
 // Move both sides past the finite old snapshot boundary without breaking sequence.
 b.event({U:12,u:12,pu:11,E:61000,b:[[100,0],[99,0],[103,1],[102,1]],a:[[100.1,0],[101,0],[103.1,1],[104,1]]},61000);
 assert.equal(b.needsCoverageRefresh(61000),true);
 const shallow=new Book();
 shallow.snapshot({lastUpdateId:10,bids:[[100,1],[99.99,1]],asks:[[100.01,1],[100.02,1]]},0);
 shallow.event({U:10,u:11,pu:10,E:61000,b:[],a:[]},61000);
 assert.equal(shallow.metrics(61000).coverage_25,false);assert.equal(shallow.needsCoverageRefresh(61000),false);
});

test('trade flow preserves event/receipt causality and rejects a future observation without fabricating data',()=>{
 const f=new Flow();f.event({a:1,T:900,E:950,p:1,q:2,m:false},1000);f.reset();
 f.event({a:2,T:5100,E:5100,p:1,q:2,m:false},4900);
 assert.equal(f.metrics(5000).flow_causal,false);
 assert.equal(f.metrics(5000).buy_quote_5s,2);
 f.reset();assert.equal(f.metrics(10000).flow_causal,true);assert.equal(f.metrics(10000).trade_event_at,null);
});

test('recovery coverage checks do not invoke full metrics sorting and are limited to once per 5 seconds',()=>{
 const b=new Book();b.snapshot({lastUpdateId:10,bids:[[100,1],[99,1]],asks:[[100.1,1],[101,1]]},0);
 b.event({U:10,u:11,pu:10,E:61000,b:[],a:[]},61000);
 b.metrics=()=>{throw Error('FULL_SORT_FORBIDDEN_IN_RECOVERY');};
 assert.equal(b.needsCoverageRefresh(61000),false);
 b.bids.keys=()=>{throw Error('REPEATED_SCAN_FORBIDDEN');};
 for(let now=61200;now<66000;now+=200)assert.equal(b.needsCoverageRefresh(now),false);
});
test('fresh receipts cannot disguise a delayed Binance transport backlog',()=>{
 assert.equal(transportFresh({E:1000},11000),true);
 assert.equal(transportFresh({E:1000},11001),false);
 assert.equal(transportFresh({E:13000},11000),false);
 const b=new Book();b.snapshot(snap,1000);b.event({...event(11),U:10},12000);
 assert.equal(b.metrics(12000).book_complete,false);
 const f=new Flow();f.event({a:1,T:1000,E:1000,p:1,q:2,m:false},12000);
 assert.equal(f.metrics(12000).flow_causal,false);
});
