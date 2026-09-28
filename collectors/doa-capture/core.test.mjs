import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Book,Flow,WeightBudget,vwap,inWindow,streamURLs,transportFresh,retireBookCapture,retireMarketCapture,snapshotStillCurrent,completeCaptureInterval,captureBucketDue} from './core.mjs';
test('Binance public book and market trade/kline routes are separated',()=>{const u=streamURLs('BTCUSDT');assert.equal(new URL(u.book).pathname,'/public/stream');assert.equal(new URL(u.market).pathname,'/market/stream');assert.equal(new URL(u.market).searchParams.get('streams'),'btcusdt@aggTrade/btcusdt@kline_1m/btcusdt@forceOrder');});
test('bounded pre-snapshot buffer discards old events without declaring continuity',()=>{const b=new Book();for(let i=1;i<=300;i++)b.event({U:i,u:i,pu:i-1,b:[],a:[],E:i},i);assert.equal(b.buffer.length,200);assert.equal(b.ready,false);assert.throws(()=>b.snapshot(snap),/GAP/);});
const snap={lastUpdateId:10,bids:[[99,10],[98,10]],asks:[[101,10],[102,10]]};
const event=(u,pu=10)=>({U:u,u,pu,b:[],a:[],E:1000});

test('production timer jitter waits for the unchanged minimum and conserves trades across the deferred tick',()=>{
 const end=Date.parse('2026-09-28T02:29:00.638Z'),early=Date.parse('2026-09-28T02:29:05.040Z'),next=early+200;
 const s={lastBucket:end,started:end-10000,book:{syncAt:end-10000},marketResetAt:end-10000,marketSequenceVerified:true};
 const flow=new Flow();flow.event({a:1,T:end-1,E:end-1,p:100,q:1,m:false},end-1);flow.reset();
 flow.event({a:2,T:early-10,E:early-10,p:100,q:2,m:false},early-10);
 assert.equal(completeCaptureInterval(s,early,true),false,'the observed 4402ms interval remains invalid');
 assert.equal(captureBucketDue(s.lastBucket,early),false,'do not emit or clear accumulated trades yet');
 flow.event({a:3,T:next-10,E:next-10,p:100,q:3,m:true},next-10);
 assert.equal(captureBucketDue(s.lastBucket,next),true);
 assert.equal(completeCaptureInterval(s,next,true),true,'4602ms is within the original 4500..5500 bounds');
 assert.equal(Math.floor(next/5000),Math.floor(early/5000),'same five-second grid cell');
 const m=flow.metrics(next);assert.equal(m.buy_quote_5s,200);assert.equal(m.sell_quote_5s,300);assert.equal(m.trade_count,2);assert.equal(m.flow_causal,true);
 s.lastBucket=next;flow.reset();
 assert.equal(captureBucketDue(s.lastBucket,next+200),false,'one row per grid cell');
 assert.equal(flow.metrics(next+200).trade_count,0);
});

test('bucket admission keeps delayed clocks, stream gaps and new-symbol warmup fail-closed',()=>{
 const s={lastBucket:10000,started:0,book:{syncAt:0},marketResetAt:0,marketSequenceVerified:true};
 assert.equal(captureBucketDue(s.lastBucket,17000),true,'persist an actual overdue interval, never synthesize missing rows');
 assert.equal(completeCaptureInterval(s,17000,true),false);
 assert.equal(captureBucketDue(s.lastBucket,9000),false,'clock reversal cannot emit a future observation');
 assert.equal(captureBucketDue(s.lastBucket,15000),true);
 assert.equal(completeCaptureInterval({...s,marketSequenceVerified:false},15000,true),false);
 assert.equal(completeCaptureInterval({...s,book:{syncAt:11000}},15000,true),false);
 assert.equal(completeCaptureInterval(s,15000,false),false);
 assert.equal(captureBucketDue(14900,15000),false,'new-symbol warmup does not advance other symbol clocks');
 assert.equal(captureBucketDue(s.lastBucket,15000),true);
});
test('snapshot is unusable until bridging event; loss of sequence rejects',()=>{const b=new Book();b.snapshot(snap);assert.equal(b.metrics(1000).book_complete,false);b.event({...event(11),U:10},1000);assert.equal(b.metrics(1000).book_complete,true);assert.throws(()=>b.event(event(14,12),1100),/GAP/);});
test('synthetic USD-M snapshot boundary: first diff U=lastUpdateId+1 bridges without resync',()=>{
 const b=new Book();b.event({U:11,u:12,pu:10,E:1000,b:[],a:[]},1000);
 b.snapshot(snap,900);
 assert.equal(b.last,12);assert.equal(b.ready,true);
 b.event({U:13,u:14,pu:12,E:1100,b:[],a:[]},1100);
 assert.equal(b.last,14);
});
test('synthetic USD-M duplicate and genuine gap stay distinct',()=>{
 const b=new Book();b.snapshot(snap,900);
 b.event({U:11,u:12,pu:10,E:1000,b:[],a:[]},1000);
 b.event({U:11,u:12,pu:10,E:1000,b:[],a:[]},1001);
 assert.equal(b.last,12);
 assert.throws(()=>b.event({U:15,u:16,pu:14,E:1100,b:[],a:[]},1100),/DEPTH_GAP/);
});
test('synthetic depth-only recovery preserves trade state and bucket clock',()=>{
 const s={book:new Book(),flow:new Flow(),bookGeneration:1,started:0,lastBucket:5000,marketResetAt:0,marketSequenceVerified:true};
 s.book.snapshot(snap,0);s.book.event({U:11,u:11,pu:10,E:1000,b:[],a:[]},1000);
 s.flow.event({a:1,T:1000,E:1000,p:100,q:1,m:false},1000);s.flow.reset();
 s.flow.event({a:2,T:6000,E:6000,p:100,q:1,m:false},6000);
 retireBookCapture(s,7000);
 assert.equal(s.lastBucket,5000);assert.equal(s.flow.last,2);assert.equal(s.flow.count,1);
 assert.equal(completeCaptureInterval(s,10000,true),false,'broken book stays invalid');
 s.book.snapshot({lastUpdateId:20,bids:[[99,10]],asks:[[101,10]]},7100);
 s.book.event({U:21,u:21,pu:20,E:7200,b:[],a:[]},7200);
 assert.equal(completeCaptureInterval(s,10000,true),false,'bucket spanning book recovery stays invalid');
 s.lastBucket=10000;
 assert.equal(completeCaptureInterval(s,15000,true),true,'next uninterrupted interval is eligible');
 retireMarketCapture(s,12000);
 assert.equal(completeCaptureInterval(s,15000,true),false,'market interruption fails closed');
 assert.equal(s.lastBucket,10000);
});
test('synthetic delayed snapshot cannot overwrite a newer socket generation',()=>{
 const oldSocket={},newSocket={},s={book:new Book(),bookGeneration:1,socket:oldSocket};
 assert.equal(snapshotStillCurrent(s,1,oldSocket),true);
 retireBookCapture(s,1000);s.socket=newSocket;
 assert.equal(snapshotStillCurrent(s,1,oldSocket),false);
 assert.equal(s.book.ready,false);
});
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
