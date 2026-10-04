import test from 'node:test';import assert from 'node:assert/strict';
import {createAccountContinuity,conservativeStreamAccount,startAccountStream} from './futures-account-stream.mjs';
import {createExecutionMarkets,startExecutionStreams} from './futures-market-stream.mjs';
import {createVenueReadCache} from './venue-read-cache.mjs';
import {freshPortfolio} from '../supabase/functions/_shared/leader-ops-isolation.mjs';
import {freshAccountEvidence,freshOpenOrderEvidence} from '../supabase/functions/_shared/leader-entry-control.mjs';
import {normalizeEntryBook} from '../supabase/functions/_shared/deterministic/book.mjs';
import {cancellationCategory} from '../supabase/functions/_shared/deterministic/entry-evidence.mjs';
import {EventEmitter} from 'node:events';
const T=1791078000000;
const flat=()=>({account:{positions:[],assets:[{asset:'USDT',walletBalance:'231.81'}],availableBalance:'231.81',totalWalletBalance:'231.81'},orders:[],algos:[]});
const portfolio=s=>({exchange:'binance_futures',account_scope:'futures',positions_complete:true,positions:[],observation:s.observation});
function hub(loader=async()=>flat()){let now=T,calls=0;const h=createAccountContinuity({now:()=>now,readSnapshot:async()=>{calls++;return loader();}}),g=h.open();h.pong(g);
 return {h,g,calls:()=>calls,time:n=>{now=n;h.pong(g);},now:()=>now};}

test('20 candidate/account/order consumers share one bootstrap with preserved REST reference and new stream validation',async()=>{
 const c=hub();const rows=await Promise.all(Array.from({length:20},()=>c.h.read()));assert.equal(c.calls(),1);
 c.time(T+60000);const next=await c.h.read();assert.equal(c.calls(),1);assert.equal(next.received_at_ms,T);
 assert.equal(next.observation.continuity.snapshot_received_at_ms,T);assert.equal(next.observation.received_at_ms,T+60000);
 assert.ok(freshPortfolio(portfolio(next),T+60000));assert.ok(freshAccountEvidence(portfolio(next),T+60000));
 assert.ok(freshOpenOrderEvidence({complete:true,orders:[],algos:[],observation:next.observation,observed_at_ms:T+60000},T+60000));
 rows[0].orders.push({});assert.equal(rows[1].orders.length,0);
});
for(const type of ['ACCOUNT_UPDATE','ORDER_TRADE_UPDATE','ALGO_UPDATE','ACCOUNT_CONFIG_UPDATE'])test(`${type} invalidates account AND ordinary/algo snapshot before reuse`,async()=>{
 const c=hub();const old=await c.h.read();c.time(T+10);c.h.event(c.g,{e:type,E:T+10,T:T+10});
 assert.equal(c.h.status().synchronized,false);const next=await c.h.read();assert.equal(c.calls(),2);assert.notEqual(next.id,old.id);
 assert.ok(next.observation.continuity.revision>old.observation.continuity.revision);
});
test('quiet stream proves continuity by bounded pong; no pong is data failure and never re-stamps stale REST',async()=>{
 let now=T;const h=createAccountContinuity({now:()=>now,readSnapshot:async()=>flat()}),g=h.open();h.pong(g);const s=await h.read();now+=3001;
 await assert.rejects(h.read(),/DISCONNECTED_OR_STALE/);assert.equal(freshPortfolio(portfolio(s),now),false);
 h.close(g);await assert.rejects(h.read(),/DISCONNECTED_OR_STALE/);
 assert.equal(cancellationCategory('GW_503:ACCOUNT_STREAM_DISCONNECTED_OR_STALE'),'DATA_UNAVAILABLE');
});
test('reconnection cannot retain previous authority; old-generation pong/event cannot revive it',async()=>{
 const c=hub();const first=await c.h.read();c.h.close(c.g);const g2=c.h.open();c.h.pong(c.g);
 await assert.rejects(c.h.read(),/DISCONNECTED_OR_STALE/);c.h.pong(g2);const s=await c.h.read();assert.equal(c.calls(),2);
 assert.notEqual(s.generation,first.generation);c.h.event(c.g,{e:'ACCOUNT_UPDATE',E:T});assert.equal(c.h.status().synchronized,true);
});
test('an event during concurrent REST bootstrap forces a second complete snapshot, never an ambiguous merge',async()=>{
 let c;let n=0;c=hub(async()=>{if(++n===1)c.h.event(c.g,{e:'ACCOUNT_UPDATE',E:T});return flat();});
 const s=await c.h.read();assert.equal(c.calls(),2);assert.equal(s.revision,c.h.status().revision);
});
test('continuous venue changes exhaust bounded recovery and remain DATA_UNAVAILABLE',async()=>{
 let c;c=hub(async()=>{c.h.event(c.g,{e:'ACCOUNT_UPDATE',E:T});return flat();});
 await assert.rejects(c.h.read(),/CHANGED_DURING_RECOVERY/);await assert.rejects(c.h.read(),/CHANGED_DURING_RECOVERY/);assert.equal(c.calls(),2);
});
test('local order request blocks reads until completion, then forces exactly one finality snapshot',async()=>{
 const c=hub();await c.h.read();const finish=c.h.beginMutation();await assert.rejects(c.h.read(),/MUTATION_IN_FLIGHT/);
 finish();finish();await Promise.all([c.h.read(),c.h.read()]);assert.equal(c.calls(),2);assert.equal(c.h.status().writes,0);
});
test('submission accepts exact current account generation/revision and fences a change before network dispatch',async()=>{
 const c=hub();const s=await c.h.read();assert.equal(c.h.assertSubmission(s.observation),true);
 c.h.event(c.g,{e:'ORDER_TRADE_UPDATE',E:T});assert.throws(()=>c.h.assertSubmission(s.observation),e=>e.submissionPhase==='PRE_SEND'&&e.exchangeSubmissionAttempted===false);
 const updated=await c.h.read();assert.equal(c.h.assertSubmission(updated.observation),true);
 c.time(T+3001);assert.throws(()=>c.h.assertSubmission(updated.observation),/CHANGED_BEFORE_SUBMIT/);
 assert.throws(()=>c.h.assertSubmission({...updated.observation,source:'BINANCE_ACCOUNT_REST'}),/CHANGED_BEFORE_SUBMIT/);
});
for(const event of [{e:'ACCOUNT_UPDATE',E:T-10001},{e:'ACCOUNT_UPDATE',E:T+1001},{e:'listenKeyExpired'},{}])test('invalid/expired private event fails closed '+JSON.stringify(event),async()=>{
 const c=hub();await c.h.read();c.h.event(c.g,event);await assert.rejects(c.h.read(),/DISCONNECTED_OR_STALE/);
});
test('incomplete snapshot cannot assert complete positions/orders',async()=>{
 const c=hub(async()=>({...flat(),algos:null}));await assert.rejects(c.h.read(),/SNAPSHOT_INCOMPLETE/);
});
test('stream margin cannot create spending authority from a favorable mark, and adverse mark reduces it',()=>{
 const s=flat();s.account.positions=[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'1',entryPrice:'100',leverage:'3',initialMargin:'33.333333333333336',unrealizedProfit:'0'}];
 const mark=price=>()=>({price,event_at_ms:T,received_at_ms:T});
 const favorable=conservativeStreamAccount(s,mark(103),T);assert.ok(Number(favorable.availableBalance)<=231.81);
 const adverse=conservativeStreamAccount(s,mark(97),T);assert.equal(Number(adverse.availableBalance),228.81);
 assert.throws(()=>conservativeStreamAccount(s,()=>null,T),/MARK_OR_MODE_UNVERIFIED/);
 assert.equal(s.account.positions[0].unrealizedProfit,'0');
});
test('metadata reuse does not renew authenticated mode timestamps; invalidation rejects old in-flight result',async()=>{
 let now=T,calls=0;const cache=createVenueReadCache({now:()=>now}),read=async()=>({at:now,n:++calls});
 const a=await cache.read('mode',2500,read);now+=2000;assert.deepEqual(await cache.read('mode',2500,read),a);assert.equal(calls,1);
 now+=501;await cache.read('mode',2500,read);assert.equal(calls,2);
 let resolve;const old=cache.read('account',1000,()=>new Promise(r=>resolve=r));await Promise.resolve();cache.invalidate('account');
 resolve({old:true});await assert.rejects(old,/INVALIDATED/);assert.deepEqual(await cache.read('account',1000,async()=>({fresh:true})),{fresh:true});
});
function market(){let now=T,depth=0;const m=createExecutionMarkets({now:()=>now,fetchDepth:async()=>{depth++;return {lastUpdateId:10,bids:[['99','10'],['98','10']],asks:[['101','10'],['102','10']]};}});
 m.setSymbols(['BTCUSDT']);return {m,time:t=>now=t,depth:()=>depth};}
const event=(u=10,pu=9)=>({e:'depthUpdate',s:'BTCUSDT',E:T,U:u,u,pu,b:[['99','10']],a:[['101','10']]});
class MarketSocket extends EventEmitter{
 static instances=[];
 constructor(url){super();this.url=url;this.readyState=0;this.sent=[];MarketSocket.instances.push(this);}
 send(raw){this.sent.push(JSON.parse(raw));}
 ping(){}
 terminate(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
 open(){this.readyState=1;this.emit('open');}
}
test('late BUY member refreshes watch once, subscribes and obtains a sequenced book; unapproved symbol remains refused',async()=>{
 MarketSocket.instances=[];let symbols=['BTCUSDT'],watches=0,stream;
 stream=startExecutionStreams({WebSocketClient:MarketSocket,now:()=>T,watch:async()=>{watches++;await Promise.resolve();return symbols;},
  fetchDepth:async symbol=>{stream.event({...event(),s:symbol});return {lastUpdateId:10,bids:[['99','10'],['98','10']],asks:[['101','10'],['102','10']]};}});
 try{
  await stream.refresh();for(const ws of MarketSocket.instances)ws.open();await stream.recover('BTCUSDT');
  symbols=['BTCUSDT','AKTUSDT'];
  const quotes=await Promise.all([stream.quoteReady('AKTUSDT'),stream.quoteReady('AKTUSDT')]);
  assert.equal(watches,2);assert.equal(quotes[0].market,'AKTUSDT');assert.equal(quotes[0].timing.source,'BINANCE_DEPTH_STREAM');
  const bookSocket=MarketSocket.instances.find(ws=>ws.url.includes('/public/'));
  assert.ok(bookSocket.sent.some(x=>x.method==='SUBSCRIBE'&&x.params.includes('aktusdt@depth@100ms')));
  await assert.rejects(stream.quoteReady('NOAUTHUSDT'),/NOT_WATCHED/);
  assert.equal(stream.symbols().includes('NOAUTHUSDT'),false);
  assert.equal(stream.status().watch.error,null);assert.equal(stream.status().watch.last_success_at_ms,T);
 }finally{stream.stop();}
});
test('failed watch refresh is observable and does not erase an existing book; connection opening applies pending membership',async()=>{
 MarketSocket.instances=[];let symbols=['BTCUSDT'],fail=false;
 const stream=startExecutionStreams({WebSocketClient:MarketSocket,now:()=>T,watch:async()=>{if(fail)throw Error('EXECUTION_WATCH_HTTP_503');return symbols;},fetchDepth:async()=>({lastUpdateId:10,bids:[['99','10']],asks:[['101','10']]})});
 try{
  await stream.refresh();symbols=['BTCUSDT','AKTUSDT'];await stream.refresh();
  const book=MarketSocket.instances.find(ws=>ws.url.includes('/public/'));book.open();
  assert.ok(book.sent.some(x=>x.method==='SUBSCRIBE'&&x.params.includes('aktusdt@depth@100ms')));
  fail=true;await stream.refresh();assert.equal(stream.status().watch.error,'EXECUTION_WATCH_HTTP_503');
  assert.equal(stream.status().watch.failures,1);assert.deepEqual(stream.symbols(),symbols);
  await assert.rejects(stream.quoteReady('IOTAUSDT'),/NOT_WATCHED/);
 }finally{stream.stop();}
});
test('sequenced full book supplies unchanged fresh-book gate with zero per-quote REST; continuous Top20 member retains book',async()=>{
 const c=market();c.m.event(event());await c.m.recover('BTCUSDT');c.time(T+100);
 c.m.setSymbols(['BTCUSDT','ETHUSDT']);const q=c.m.quote('BTCUSDT');assert.equal(q.timing.received_at_ms,T);
 assert.equal(normalizeEntryBook(q,1500,T+100).health.bookHealthy,true);
 for(let i=0;i<20;i++)c.m.quote('BTCUSDT');assert.equal(c.depth(),1);
 c.m.setSymbols(['ETHUSDT']);assert.throws(()=>c.m.quote('BTCUSDT'),/NOT_WATCHED/);
});
test('depth sequence gap, old event and socket reset never send stale quotes or create per-candidate REST fallback',async()=>{
 const c=market();c.m.event(event());await c.m.recover('BTCUSDT');c.time(T+1600);assert.throws(()=>c.m.quote('BTCUSDT'),/BOOK_UNAVAILABLE/);assert.equal(c.depth(),1);
 c.time(T);c.m.event(event(12,11));assert.throws(()=>c.m.quote('BTCUSDT'),/BOOK_UNAVAILABLE/);
 c.m.disconnect('book');assert.throws(()=>c.m.quote('BTCUSDT'),/BOOK_UNAVAILABLE/);
});
test('late Top20 membership bootstraps all 21 books fairly within the bounded recovery budget',async()=>{
 let now=T,reads=0,inFlight=0,maxInFlight=0;const m=createExecutionMarkets({now:()=>now,fetchDepth:async()=>{reads++;maxInFlight=Math.max(maxInFlight,++inFlight);await Promise.resolve();inFlight--;return {lastUpdateId:10,bids:[['99','10']],asks:[['101','10']]};}});
 now+=120000;const symbols=Array.from({length:21},(_,i)=>'S'+i+'USDT');m.setSymbols(symbols);
 for(const s of symbols)m.event({...event(),s,E:now});
 for(let i=0;i<11;i++)await Promise.all(m.recoverySymbols().map(s=>m.recover(s)));
 assert.equal(reads,21);assert.equal(m.status().synced,21);assert.ok(maxInFlight<=2);
 m.disconnect('book');now+=5001;for(const s of symbols)m.event({...event(),s,E:now});
 for(let i=0;i<11;i++)await Promise.all(m.recoverySymbols().map(s=>m.recover(s)));
 assert.equal(reads,25);assert.equal(m.status().recovery_requests_last_minute,25);assert.equal(m.status().synced,4);
 now+=60001;for(const s of symbols)m.event({...event(11,10),s,E:now});
 for(let i=0;i<11;i++)await Promise.all(m.recoverySymbols().map(s=>m.recover(s)));
 assert.equal(m.status().synced,21);assert.ok(reads<=46);
});
test('failed early symbols cannot starve later books and failures expose only bounded diagnostics',async()=>{
 let now=T,reads=0;const m=createExecutionMarkets({now:()=>now,fetchDepth:async s=>{reads++;if(s==='FAILUSDT')throw Error('REST_TIMEOUT');return {lastUpdateId:10,bids:[['99','10']],asks:[['101','10']]};}});
 m.setSymbols(['FAILUSDT','BTCUSDT','ETHUSDT']);for(const s of m.symbols())m.event({...event(),s});
 await Promise.all(m.recoverySymbols().map(s=>m.recover(s)));await Promise.all(m.recoverySymbols().map(s=>m.recover(s)));
 assert.equal(reads,3);assert.equal(m.status().synced,2);assert.equal(m.status().unsynced[0].reason,'REST_TIMEOUT');
 await m.recover('FAILUSDT');assert.equal(reads,3);assert.ok(m.status().unsynced[0].retry_at_ms>now);
});
test('stream quote timestamps cannot launder an old exchange event into a fresh quote',async()=>{
 const c=market();c.m.event(event());await c.m.recover('BTCUSDT');const q=c.m.quote('BTCUSDT');q.timing.book_captured_at_ms=T-1501;
 assert.ok(normalizeEntryBook(q,1500,T).health.reasons.includes('QUOTE_STALE'));
 q.raw.book_update_id=null;assert.ok(normalizeEntryBook(q,1500,T).health.reasons.includes('QUOTE_TIME_UNKNOWN'));
});
test('actual private socket verifies its own ping nonce, invalidates on venue event and never exposes the listen key',async()=>{
 const sockets=[];class Socket extends EventEmitter{constructor(url){super();this.url=url;this.readyState=1;sockets.push(this);}ping(token){this.token=token;}terminate(){this.emit('close');}close(){this.emit('close');}}
 let reads=0;const keys=[];const h=startAccountStream({WebSocketClient:Socket,now:()=>T,listenKey:async method=>{keys.push(method);return 'secret-listen-key';},readSnapshot:async()=>{reads++;return flat();}});
 try{await new Promise(r=>setImmediate(r));const s=sockets[0];assert.equal(s.url,'wss://fstream.binance.com/private/ws/secret-listen-key');s.emit('open');
  s.emit('pong',Buffer.from('wrong-nonce'));await assert.rejects(h.read(),/DISCONNECTED_OR_STALE/);
  s.emit('pong',Buffer.from(s.token));await h.read();assert.equal(reads,1);assert.deepEqual(keys,['POST']);
  s.emit('message',JSON.stringify({e:'ALGO_UPDATE',E:T}));await h.read();assert.equal(reads,2);
  assert.equal(JSON.stringify(h.status()).includes('secret-listen-key'),false);
  s.emit('close');await assert.rejects(h.read(),/DISCONNECTED_OR_STALE/);
 }finally{h.stop();}
});
