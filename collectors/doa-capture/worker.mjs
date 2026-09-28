import {Book,Flow,WeightBudget,VERSION,iso,inWindow,streamURLs,normalizeSymbol,transportFresh,closedCandle,btcCandleFields,retireBookCapture,retireMarketCapture,snapshotStillCurrent,completeCaptureInterval,captureBucketDue} from './core.mjs';
import {randomUUID} from 'node:crypto';
import {summarizeCapture} from './context.mjs';
const endpoint=process.env.CAPTURE_ENDPOINT;
const token=process.env.CAPTURE_TOKEN;
const expected=process.env.PROTOCOL_SHA256;
if(endpoint!=='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest' || !/^[a-f0-9]{64}$/.test(token||'') || !/^[a-f0-9]{64}$/.test(expected||'')) throw Error('INVALID_CONFIG');
const worker_id=randomUUID(), states=new Map(), budget=new WeightBudget(), queue=new Map(), seen=new Map();
let windows=[],deadline=0,lastControl=0,lastWatch=0,lastFlush=0,busyRest=false,stop=false,restFailures=0,wsGaps=0,coverageRefreshes=0,backoffUntil=0;
let production=false,universe=new Set(),universeAt=0,unavailableSymbols={};
const boot=Date.now();
const log=(event,extra={})=>console.log(JSON.stringify({event,at:iso(Date.now()),version:VERSION,...extra}));
async function api(action,extra={}){
  const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-doa-capture-token':token},body:JSON.stringify({action,worker_id,...extra}),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('INGEST_'+r.status);
  const out=await r.json();if(!out.enabled&&out.reason!=='LEASE_BUSY'){stop=true;log('CONTROL_STOP',{reason:out.reason});}return out;
}
async function publicGet(path,weight){
  if(Date.now()<backoffUntil || !budget.claim(weight,Date.now()))return null;
  const r=await fetch('https://fapi.binance.com'+path,{signal:AbortSignal.timeout(8000)});
  if(r.status===418 || r.status===429){backoffUntil=Date.now()+Math.max(60000,Number(r.headers.get('retry-after')||60)*1000);stop=true;throw Error('RATE_LIMIT_STOP');}
  if(!r.ok)throw Error('PUBLIC_HTTP_'+r.status);
  return await r.json();
}
function enqueue(row){const key=row.kind+':'+row.symbol+':'+row.at;if(seen.has(key))return;seen.set(key,Date.now());queue.set(key,row);if(queue.size>1200)throw Error('PERSIST_QUEUE_CAP');}
function connect(symbol,candles){
  const s={symbol,candles,book:new Book(),flow:new Flow(),ring:[],socket:null,marketSocket:null,started:Date.now(),lastBucket:Date.now(),marketResetAt:Date.now(),marketSequenceVerified:true,bookGeneration:0,lastTradeAt:0,lastCandle:null,needBackfill:candles,bookReconnectAt:0,marketReconnectAt:0};
  states.set(symbol,s);openSocket(s);return s;
}
function openSocket(s){
  const urls=streamURLs(s.symbol);
  if(!s.socket){
    s.book.reset();s.bookGeneration++;s.started=Date.now();
    const ws=new WebSocket(urls.book);s.socket=ws;
    const retire=()=>{if(s.socket!==ws)return;s.socket=null;retireBookCapture(s,Date.now());ws.close();};
    ws.addEventListener('message',msg=>{let eventIds;try{
      if(s.socket!==ws)return;
      const e=JSON.parse(msg.data).data,now=Date.now();
      if(!e || (e.st!==undefined && +e.st!==1) || e.s && e.s!==s.symbol)return;
      eventIds={U:e.U,u:e.u,pu:e.pu,previous_u:s.book.last,event_ms:e.E,received_ms:now};
      if(!transportFresh(e,now))throw Error('TRANSPORT_EVENT_STALE_OR_FUTURE');
      if(e.e==='depthUpdate')s.book.event(e,now);
    }catch(e){wsGaps++;retire();log('STREAM_GAP',{symbol:s.symbol,stream:'book',reason:e.message,event_ids:eventIds});}});
    ws.addEventListener('error',retire);ws.addEventListener('close',retire);
  }
  if(!s.marketSocket){
    const marketWs=new WebSocket(urls.market);s.marketSocket=marketWs;
    const retire=()=>{if(s.marketSocket!==marketWs)return;s.marketSocket=null;retireMarketCapture(s,Date.now());marketWs.close();};
    marketWs.addEventListener('message',msg=>{let eventIds;try{
    if(s.marketSocket!==marketWs)return;
    const e=JSON.parse(msg.data).data;const now=Date.now();
    if(!e || (e.st!==undefined && +e.st!==1) || e.s && e.s!==s.symbol)return;
    eventIds={aggregate_id:e.a,previous_aggregate_id:s.flow.last,event_ms:e.E,trade_ms:e.T,received_ms:now};
    if(!transportFresh(e,now))throw Error('TRANSPORT_EVENT_STALE_OR_FUTURE');
    if(e.e==='aggTrade'){
      const previous=s.flow.last;
      s.flow.event(e,now);
      if(!s.marketSequenceVerified && previous!==null && +e.a===previous+1)s.marketSequenceVerified=true;
      s.lastTradeAt=now;
    }
    if(e.e==='forceOrder')s.flow.liquidation+=Number(e.o.ap||e.o.p)*Number(e.o.z);
    if(e.e==='kline' && e.k.x){const k=e.k;s.lastCandle=closedCandle(e,now);if(s.candles)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k.t),payload:{open:+k.o,high:+k.h,low:+k.l,close:+k.c,quote_volume:+k.q,taker_buy_quote:+k.Q,exchange_at:iso(+e.E),available_at:iso(now),source:'WS_CLOSED',complete:true}});}
    }catch(e){wsGaps++;retire();log('STREAM_GAP',{symbol:s.symbol,stream:'market',reason:e.message,event_ids:eventIds});}});
    marketWs.addEventListener('error',retire);marketWs.addEventListener('close',retire);
  }
}
async function watch(){
  const out=await api('watch');if(stop)return;
  if(out.reason==='LEASE_BUSY'){log('LEASE_WAIT');return false;}
  if(out.protocol_sha256!==expected)throw Error('PROTOCOL_MISMATCH');
  deadline=Date.parse(out.ends_at);lastControl=Date.now();windows=out.windows;production=out.production_enabled===true;
  if(Date.now()-universeAt>900000){
    const info=await publicGet('/fapi/v1/exchangeInfo',1);
    if(info?.symbols){universe=new Set(info.symbols.filter(x=>x.status==='TRADING'&&x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT').map(x=>x.symbol));universeAt=Date.now();}
    if(!universe.size)throw Error('ACTIVE_UNIVERSE_UNAVAILABLE');
  }
  unavailableSymbols={};
  const desired=new Map(out.watch.map(x=>({...x,symbol:normalizeSymbol(x.symbol)})).filter(x=>{
    if(x.symbol&&universe.has(x.symbol))return true;
    unavailableSymbols[x.symbol??'INVALID']='NOT_ACTIVE_USDM_PERPETUAL';return false;
  }).map(x=>[x.symbol,x]));
  for(const [symbol,s] of states)if(!desired.has(symbol)){s.socket?.close();s.marketSocket?.close();states.delete(symbol);}
  for(const w of desired.values()){
    if(!normalizeSymbol(w.symbol))continue;
    const s=states.get(w.symbol)||connect(w.symbol,w.candles);
    if(w.candles && !s.candles)s.needBackfill=true;s.candles=w.candles;s.roles=w.roles??[];
  }
  for(const s of states.values())for(const row of s.ring)if(production||inWindow(Date.parse(row.at),windows,s.symbol))enqueue(row);
}
async function recover(){
  if(busyRest || stop)return;busyRest=true;
  try{
    for(const s of [...states.values()].sort((a,b)=>Number(!a.roles?.includes('OPEN_POSITION'))-Number(!b.roles?.includes('OPEN_POSITION')))){
      if(s.socket?.readyState!==WebSocket.OPEN)continue;
      if(s.book.needsCoverageRefresh(Date.now())){
        s.book.reset();s.bookGeneration++;coverageRefreshes++;log('COVERAGE_BOUNDARY_RESYNC',{symbol:s.symbol});
      }
      if(s.book.last===null){const generation=s.bookGeneration,socket=s.socket;
        const snap=await publicGet('/fapi/v1/depth?symbol='+s.symbol+'&limit=1000',20);
        if(snap && snapshotStillCurrent(s,generation,socket)){try{s.book.snapshot(snap,Date.now());}catch(e){s.book.reset();s.bookGeneration++;throw e;}return;}}
      if(s.needBackfill){const rows=await publicGet('/fapi/v1/klines?symbol='+s.symbol+'&interval=1m&limit=65',2);if(rows){for(const k of rows)if(+k[6]<Date.now() && +k[0]>=boot-120000)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k[0]),payload:{open:+k[1],high:+k[2],low:+k[3],close:+k[4],quote_volume:+k[7],taker_buy_quote:+k[10],available_at:iso(Date.now()),source:'REST_CLOSED_BACKFILL',complete:true}});s.needBackfill=false;return;}}
    }
  }catch(e){restFailures++;log('RECOVERY_ERROR',{reason:e.message});}finally{busyRest=false;}
}
function bucket(now){
  let emitted=false;
  for(const [key,t] of seen)if(now-t>600000)seen.delete(key);
  const btc=states.get('BTCUSDT')?.lastCandle;
  for(const s of states.values()){
    if(!captureBucketDue(s.lastBucket,now))continue;
    const m=s.book.metrics(now),flow=s.flow.metrics(now);
    const full=completeCaptureInterval(s,now,s.marketSocket?.readyState===WebSocket.OPEN);
    const row={kind:'micro',symbol:s.symbol,at:iso(Math.floor(now/5000)*5000),payload:{...m,...flow,available_at:iso(now),interval_start:iso(s.lastBucket),interval_end:iso(now),interval_ms:now-s.lastBucket,
      bucket_complete:full && m.book_complete && flow.trade_sequence_complete && flow.flow_causal,
      ...btcCandleFields(btc,now),watch_roles:s.roles??[],sector_return_1m:null,sector_map_version:null,maker_fee_bps:null,taker_fee_bps:null,funding_cashflow:null,
      source:'BINANCE_USDM_DIFF_AGGTRADE',version:VERSION}};
    s.lastBucket=now;s.ring.push(row);s.ring=s.ring.filter(x=>Date.parse(x.at)>=now-240000);
    if(production||inWindow(Date.parse(row.at),windows,s.symbol))enqueue(row);
    s.book.add=0;s.book.remove=0;s.book.bidAdd=0;s.book.bidRemove=0;s.flow.reset();
    emitted=true;
  }
  return emitted;
}
let pending=null;
async function flush(){
  if(!pending){
    const selected=[];let size=0;
    for(const [k,row] of [...queue].sort((a,b)=>Number(!states.get(a[1].symbol)?.roles?.includes('OPEN_POSITION'))-Number(!states.get(b[1].symbol)?.roles?.includes('OPEN_POSITION')))){const bytes=Buffer.byteLength(JSON.stringify(row));if(selected.length>=300||size+bytes>350000)break;selected.push([k,row]);size+=bytes;}
    pending={batch_id:randomUUID(),rows:selected.map(x=>x[1]),metrics:{version:VERSION,source_commit:process.env.SOURCE_COMMIT??null,watched:states.size,synced:[...states.values()].filter(s=>s.book.ready).length,trade_streams_seen:[...states.values()].filter(s=>s.lastTradeAt>0).length,candle_streams_seen:[...states.values()].filter(s=>s.lastCandle!==null).length,queue:queue.size,ws_gaps:wsGaps,coverage_refreshes:coverageRefreshes,rest_failures:restFailures,rss_bytes:process.memoryUsage().rss,last_bucket_at:iso(Date.now()),order_calls:0,llm_calls:0}};
    pending.metrics.live_contexts=Object.fromEntries([...states].map(([symbol,s])=>[symbol,summarizeCapture(s.ring,Date.now())]));
    pending.metrics.watch_roles=Object.fromEntries([...states].map(([symbol,s])=>[symbol,s.roles??[]]));
    pending.metrics.unavailable_symbols=unavailableSymbols;
    pending.metrics.production_continuous=production;
    for(const [k] of selected)queue.delete(k);
  }
  const out=await api('ingest',pending);lastControl=Date.now();pending=null;
  log('HEARTBEAT',{watched:states.size,synced:[...states.values()].filter(s=>s.book.ready).length,queue:queue.size,inserted:out.inserted||0,bytes:out.bytes_reserved});
}
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
// A rolling release waits for the previous worker's DB lease; it never steals it.
for(let i=0;i<24&&!stop&&!deadline;i++){await watch();if(!deadline&&!stop)await new Promise(r=>setTimeout(r,5000));}
if(!deadline&&!stop)throw Error('LEASE_START_TIMEOUT');
let watchTask=null,flushTask=null,bucketFlushDue=false;
log('STARTED',{worker_id,protocol_sha256:expected,deadline:iso(deadline)});
const timer=setInterval(()=>{
  const now=Date.now();
  if(stop || now>=deadline || now-lastControl>90000 || (!production&&now-boot>14*86400000) || process.memoryUsage().rss>230000000){clearInterval(timer);for(const s of states.values()){s.socket?.close();s.marketSocket?.close();}log('STOPPED',{reason:stop?'CONTROL_OR_SIGNAL':now>=deadline?'DEADLINE':now-lastControl>90000?'CONTROL_STALE':'RESOURCE_CAP'});setTimeout(()=>process.exit(stop?0:1),1000);return;}
  try{
    if(bucket(now))bucketFlushDue=true;
    for(const s of states.values())if((!s.socket && now>=s.bookReconnectAt)||(!s.marketSocket && now>=s.marketReconnectAt))openSocket(s);
    void recover();
    if(!watchTask&&now-lastWatch>=15000){lastWatch=now;watchTask=watch().catch(e=>log('CONTROL_ERROR',{reason:e.message})).finally(()=>{watchTask=null;});}
    // Keep one in-flight ingest; a newly closed bucket must not wait for an unrelated timer phase.
    if(!flushTask&&((production&&bucketFlushDue)||now-lastFlush>=(production?5000:15000))){bucketFlushDue=false;lastFlush=now;flushTask=flush().catch(e=>log('CONTROL_ERROR',{reason:e.message})).finally(()=>{flushTask=null;});}
  }catch(e){log('FATAL',{reason:e.message});stop=true;}
},200);
