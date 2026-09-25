import {Book,Flow,WeightBudget,VERSION,iso,inWindow} from './core.mjs';
import {randomUUID} from 'node:crypto';
const endpoint=process.env.CAPTURE_ENDPOINT;
const token=process.env.CAPTURE_TOKEN;
const expected=process.env.PROTOCOL_SHA256;
if(endpoint!=='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest' || !/^[a-f0-9]{64}$/.test(token||'') || !/^[a-f0-9]{64}$/.test(expected||'')) throw Error('INVALID_CONFIG');
const worker_id=randomUUID(), states=new Map(), budget=new WeightBudget(), queue=new Map(), seen=new Map();
let windows=[],deadline=0,lastControl=0,lastWatch=0,lastFlush=0,busyRest=false,stop=false,restFailures=0,wsGaps=0,backoffUntil=0;
const boot=Date.now();
const log=(event,extra={})=>console.log(JSON.stringify({event,at:iso(Date.now()),version:VERSION,...extra}));
async function api(action,extra={}){
  const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-doa-capture-token':token},body:JSON.stringify({action,worker_id,...extra}),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('INGEST_'+r.status);
  const out=await r.json();if(!out.enabled){stop=true;log('CONTROL_STOP',{reason:out.reason});}return out;
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
  const s={symbol,candles,book:new Book(),flow:new Flow(),ring:[],socket:null,started:Date.now(),lastBucket:Date.now(),lastTradeAt:0,lastCandle:null,needBackfill:candles,reconnectAt:0};
  states.set(symbol,s);openSocket(s);return s;
}
function openSocket(s){
  s.book.reset();s.flow=new Flow();s.started=Date.now();s.lastBucket=Date.now();
  const slug=s.symbol.toLowerCase();
  const ws=new WebSocket('wss://fstream.binance.com/stream?streams='+['depth@100ms','aggTrade','kline_1m','forceOrder'].map(x=>slug+'@'+x).join('/'));
  s.socket=ws;
  ws.addEventListener('message',msg=>{try{
    if(s.socket!==ws)return;
    const e=JSON.parse(msg.data).data;const now=Date.now();
    if(e.e==='depthUpdate')s.book.event(e,now);
    if(e.e==='aggTrade'){s.flow.event(e);s.lastTradeAt=now;}
    if(e.e==='forceOrder')s.flow.liquidation+=Number(e.o.ap||e.o.p)*Number(e.o.z);
    if(e.e==='kline' && e.k.x){const k=e.k;s.lastCandle={at:iso(+k.t),return_1m:+k.c/(+k.o)-1};if(s.candles)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k.t),payload:{open:+k.o,high:+k.h,low:+k.l,close:+k.c,quote_volume:+k.q,taker_buy_quote:+k.Q,exchange_at:iso(+e.E),available_at:iso(now),source:'WS_CLOSED',complete:true}});}
  }catch(e){wsGaps++;s.book.reset();s.flow.complete=false;ws.close();s.reconnectAt=Date.now()+5000;log('STREAM_GAP',{symbol:s.symbol,reason:e.message});}});
  ws.addEventListener('error',()=>{s.book.ready=false;s.flow.complete=false;});
  ws.addEventListener('close',()=>{if(s.socket===ws){s.book.reset();s.flow.complete=false;s.reconnectAt=Date.now()+5000;}});
}
async function watch(){
  const out=await api('watch');if(stop)return;
  if(out.protocol_sha256!==expected)throw Error('PROTOCOL_MISMATCH');
  deadline=Date.parse(out.ends_at);lastControl=Date.now();windows=out.windows;
  const desired=new Map(out.watch.map(x=>[x.symbol,x]));
  for(const [symbol,s] of states)if(!desired.has(symbol)){s.socket.close();states.delete(symbol);}
  for(const w of desired.values()){
    if(!/^[A-Z0-9]{2,24}USDT$/.test(w.symbol))continue;
    const s=states.get(w.symbol)||connect(w.symbol,w.candles);
    if(w.candles && !s.candles)s.needBackfill=true;s.candles=w.candles;
  }
  for(const s of states.values())for(const row of s.ring)if(inWindow(Date.parse(row.at),windows,s.symbol))enqueue(row);
}
async function recover(){
  if(busyRest || stop)return;busyRest=true;
  try{
    for(const s of states.values()){
      if(s.socket.readyState!==WebSocket.OPEN)continue;
      if(s.book.last===null){const snap=await publicGet('/fapi/v1/depth?symbol='+s.symbol+'&limit=1000',20);if(snap){try{s.book.snapshot(snap);}catch(e){s.book.reset();throw e;}return;}}
      if(s.needBackfill){const rows=await publicGet('/fapi/v1/klines?symbol='+s.symbol+'&interval=1m&limit=65',2);if(rows){for(const k of rows)if(+k[6]<Date.now() && +k[0]>=boot-120000)enqueue({kind:'candle',symbol:s.symbol,at:iso(+k[0]),payload:{open:+k[1],high:+k[2],low:+k[3],close:+k[4],quote_volume:+k[7],taker_buy_quote:+k[10],available_at:iso(Date.now()),source:'REST_CLOSED_BACKFILL',complete:true}});s.needBackfill=false;return;}}
    }
  }catch(e){restFailures++;log('RECOVERY_ERROR',{reason:e.message});}finally{busyRest=false;}
}
function bucket(now){
  for(const [key,t] of seen)if(now-t>600000)seen.delete(key);
  const btc=states.get('BTCUSDT')?.lastCandle;
  for(const s of states.values()){
    const m=s.book.metrics(now),flow=s.flow.metrics();
    const full=s.started<=s.lastBucket && s.book.syncAt<=s.lastBucket && now-s.lastBucket>=4500 && now-s.lastBucket<=5500;
    const row={kind:'micro',symbol:s.symbol,at:iso(Math.floor(now/5000)*5000),payload:{...m,...flow,available_at:iso(now),interval_start:iso(s.lastBucket),interval_end:iso(now),interval_ms:now-s.lastBucket,
      bucket_complete:full && m.book_complete && flow.trade_sequence_complete,
      btc_return_1m:btc && now-Date.parse(btc.at)<125000?btc.return_1m:null,btc_candle_at:btc?.at||null,sector_return_1m:null,sector_map_version:null,maker_fee_bps:null,taker_fee_bps:null,funding_cashflow:null,
      source:'BINANCE_USDM_DIFF_AGGTRADE',version:VERSION}};
    s.lastBucket=now;s.ring.push(row);s.ring=s.ring.filter(x=>Date.parse(x.at)>=now-240000);
    if(inWindow(Date.parse(row.at),windows,s.symbol))enqueue(row);
    s.book.add=0;s.book.remove=0;s.flow.reset();
  }
}
let pending=null;
async function flush(){
  if(!pending){
    const selected=[];let size=0;
    for(const [k,row] of queue){const bytes=Buffer.byteLength(JSON.stringify(row));if(selected.length>=300||size+bytes>350000)break;selected.push([k,row]);size+=bytes;}
    pending={batch_id:randomUUID(),rows:selected.map(x=>x[1]),metrics:{version:VERSION,watched:states.size,synced:[...states.values()].filter(s=>s.book.ready).length,queue:queue.size,ws_gaps:wsGaps,rest_failures:restFailures,rss_bytes:process.memoryUsage().rss,last_bucket_at:iso(Date.now()),order_calls:0,llm_calls:0}};
    for(const [k] of selected)queue.delete(k);
  }
  const out=await api('ingest',pending);lastControl=Date.now();pending=null;
  log('HEARTBEAT',{watched:states.size,synced:[...states.values()].filter(s=>s.book.ready).length,queue:queue.size,inserted:out.inserted||0,bytes:out.bytes_reserved});
}
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
await watch();
let previousBucket=Math.floor(Date.now()/5000),task=null;
log('STARTED',{worker_id,protocol_sha256:expected,deadline:iso(deadline)});
const timer=setInterval(()=>{
  const now=Date.now();
  if(stop || now>=deadline || now-lastControl>90000 || now-boot>14*86400000 || process.memoryUsage().rss>230000000){clearInterval(timer);for(const s of states.values())s.socket.close();log('STOPPED',{reason:stop?'CONTROL_OR_SIGNAL':now>=deadline?'DEADLINE':now-lastControl>90000?'CONTROL_STALE':'RESOURCE_CAP'});setTimeout(()=>process.exit(0),1000);return;}
  try{
    const b=Math.floor(now/5000);if(b!==previousBucket){bucket(now);previousBucket=b;}
    for(const s of states.values())if(s.socket.readyState===WebSocket.CLOSED && now>=s.reconnectAt)openSocket(s);
    void recover();
    if(!task){
      if(now-lastWatch>=15000){lastWatch=now;task=watch();}
      else if(now-lastFlush>=15000){lastFlush=now;task=flush();}
      if(task)task.catch(e=>log('CONTROL_ERROR',{reason:e.message})).finally(()=>{task=null;});
    }
  }catch(e){log('FATAL',{reason:e.message});stop=true;}
},200);
