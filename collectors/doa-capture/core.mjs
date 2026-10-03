export const VERSION = 'DOA-CAPTURE-10-BOOK-INTEGRITY';
export const BOOK_STATE=Object.freeze({SYNCED:'SYNCED',UNSYNCED:'UNSYNCED',RESYNCING:'RESYNCING'});
export function symbolSingleFlight(target,work){
  if(target.resyncPromise)return target.resyncPromise;
  const flight=Promise.resolve().then(work).finally(()=>{if(target.resyncPromise===flight)target.resyncPromise=null;});
  target.resyncPromise=flight;return flight;
}
export async function boundedSnapshotResync({fetchSnapshot,applySnapshot,stillCurrent=()=>true,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxAttempts=2,retryDelayMs=250}){
  let failure='SNAPSHOT_UNAVAILABLE';
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const snapshot=await fetchSnapshot(attempt);
      if(!stillCurrent())return {ok:false,stale_generation:true,attempts:attempt,failure_reason:'STALE_SOCKET_GENERATION'};
      if(!snapshot)throw Error('REST_SNAPSHOT_DEFERRED');
      const outcome=applySnapshot(snapshot);
      if(outcome?.status!==BOOK_STATE.UNSYNCED)return {ok:true,snapshot,outcome,attempts:attempt};
      failure=outcome.reason??'SNAPSHOT_SEQUENCE_FAILED';
    }catch(error){failure=String(error?.message??error).slice(0,100);}
    if(attempt<maxAttempts)await sleep(retryDelayMs);
  }
  return {ok:false,stale_generation:false,attempts:maxAttempts,failure_reason:failure};
}
export function transportFresh(e,receivedAt){const at=Number(e.E??e.T);return Number.isSafeInteger(at)&&Number.isSafeInteger(receivedAt)&&at<=receivedAt+1000&&receivedAt-at<=10000;}
export const normalizeSymbol=value=>{const s=String(value??'').trim().toUpperCase();return /^[\p{L}\p{N}]{1,24}USDT$/u.test(s)?s:null;};
export const iso = n => new Date(n).toISOString();
export function streamURLs(symbol){
  const s=symbol.toLowerCase();
  return {book:'wss://fstream.binance.com/public/stream?streams='+s+'@depth@100ms',
    market:'wss://fstream.binance.com/market/stream?streams='+['aggTrade','kline_1m','forceOrder'].map(x=>s+'@'+x).join('/')};
}
export class Book {
  constructor() { this.reset(); }
  reset(reason='INITIAL_SNAPSHOT') {
    this.bids=new Map();this.asks=new Map();this.last=null;this.ready=false;this.state=BOOK_STATE.UNSYNCED;
    this.buffer=[];this.bufferOverflow=false;this.snapshotLoaded=false;this.snapshotAt=0;this.snapshotCovered25=false;
    this.bidBoundary=undefined;this.askBoundary=undefined;this.at=0;this.received=0;this.syncAt=Infinity;
    this.add=0;this.remove=0;this.bidAdd=0;this.bidRemove=0;this.lastIncident={reason,gap_detected_at:null,
      previous_last_update_id:null,incoming_first_update_id:null,incoming_final_update_id:null};
  }
  disposeDepth() {
    this.bids=new Map();this.asks=new Map();this.last=null;this.ready=false;this.snapshotLoaded=false;
    this.at=0;this.received=0;this.syncAt=Infinity;this.snapshotAt=0;this.snapshotCovered25=false;
    this.bidBoundary=undefined;this.askBoundary=undefined;
    this.add=0;this.remove=0;this.bidAdd=0;this.bidRemove=0;
  }
  bufferEvent(e,t) {
    if(this.buffer.length>=200){this.buffer.shift();this.bufferOverflow=true;}
    this.buffer.push([e,t]);
  }
  markUnsynced(reason,e=null,t=Date.now()) {
    const incident={reason,gap_detected_at:t,previous_last_update_id:this.last,
      incoming_first_update_id:Number.isSafeInteger(+e?.U)?+e.U:null,
      incoming_final_update_id:Number.isSafeInteger(+e?.u)?+e.u:null,
      incoming_previous_update_id:Number.isSafeInteger(+e?.pu)?+e.pu:null};
    this.disposeDepth();this.buffer=[];this.bufferOverflow=false;this.state=BOOK_STATE.UNSYNCED;
    this.lastIncident=incident;if(e)this.bufferEvent(e,t);
    return {status:BOOK_STATE.UNSYNCED,resync:true,incident};
  }
  beginResync(now=Date.now()) {
    if(this.state===BOOK_STATE.SYNCED)return false;
    this.state=BOOK_STATE.RESYNCING;this.ready=false;this.resyncStartedAt=now;return true;
  }
  failResync(reason) {
    const buffered=this.buffer;this.disposeDepth();this.buffer=buffered;this.state=BOOK_STATE.UNSYNCED;
    return {status:BOOK_STATE.UNSYNCED,resync:true,reason};
  }
  apply(e,t,countDeltas=true) {
    for(const [side,rows] of [[this.bids,e.b],[this.asks,e.a]]) for(const [p0,q0] of rows) {
      const p=+p0,q=+q0;
      // The REST snapshot defines the finite trustworthy book boundary. Diff events can
      // mention prices beyond that boundary; retaining those forever turns a long-lived
      // local book into an unbounded map and causes DEPTH_MEMORY_CAP/resync thrash.
      // Ignore only NEW out-of-bound levels. Existing in-bound levels and all removals
      // remain exact; coverage drift is handled by needsCoverageRefresh().
      if(side===this.bids&&p<this.bidBoundary&&!side.has(p))continue;
      if(side===this.asks&&p>this.askBoundary&&!side.has(p))continue;
      const old=side.get(p)||0;
      if(countDeltas&&side===this.asks) { this.add+=Math.max(0,q-old)*p; this.remove+=Math.max(0,old-q)*p; }
      if(countDeltas&&side===this.bids) { this.bidAdd+=Math.max(0,q-old)*p; this.bidRemove+=Math.max(0,old-q)*p; }
      if(q===0) side.delete(p); else side.set(p,q);
    }
    if(this.bids.size+this.asks.size>12000)throw Error('DEPTH_MEMORY_CAP');
    this.last=+e.u;this.at=+e.E;this.received=t;
  }
  drainBuffered() {
    if(!this.snapshotLoaded||this.last===null)return {status:BOOK_STATE.RESYNCING,waiting_for_bridge:true};
    const pending=this.buffer.filter(([e])=>+e.u>=this.last);this.buffer=[];
    if(!pending.length)return {status:BOOK_STATE.RESYNCING,waiting_for_bridge:true};
    const [first,firstReceived]=pending[0];
    // Binance USD-M rule: after discarding u < snapshot.lastUpdateId, the first
    // processed event must span lastUpdateId. Later events must chain pu == prior u.
    if(+first.U>this.last || +first.u<this.last){
      this.buffer=pending;return this.failResync('SNAPSHOT_BRIDGE_MISSING');
    }
    let completedAt=Math.max(this.snapshotAt??0,firstReceived);
    try{
      this.apply(first,firstReceived,false);
      for(let i=1;i<pending.length;i++){
        const [e,t]=pending[i];if(+e.u<=this.last)continue;
        if(+e.pu!==this.last){this.buffer=pending.slice(i);return this.failResync('BUFFERED_SEQUENCE_MISMATCH');}
        this.apply(e,t,false);completedAt=Math.max(completedAt,t);
      }
    }catch(e){this.buffer=pending;return this.failResync(e.message);}
    this.state=BOOK_STATE.SYNCED;this.ready=true;this.syncAt=completedAt;
    return {status:BOOK_STATE.SYNCED,resync_completed_at:completedAt,buffered_event_count:pending.length};
  }
  snapshot(s,now=Date.now()) {
    if(!Number.isSafeInteger(+s?.lastUpdateId)||!Array.isArray(s?.bids)||!Array.isArray(s?.asks))return this.failResync('INVALID_SNAPSHOT');
    const validSide=rows=>rows.length>0&&rows.every(row=>Array.isArray(row)&&row.length>=2&&Number(row[0])>0&&Number(row[1])>0&&Number.isFinite(Number(row[0]))&&Number.isFinite(Number(row[1])));
    if(!validSide(s.bids)||!validSide(s.asks))return this.failResync('INVALID_SNAPSHOT');
    this.bids=new Map(s.bids.map(([p,q])=>[+p,+q])); this.asks=new Map(s.asks.map(([p,q])=>[+p,+q]));
    this.last=+s.lastUpdateId;this.ready=false;this.state=BOOK_STATE.RESYNCING;this.snapshotLoaded=true;
    this.bidBoundary=Math.min(...this.bids.keys()); this.askBoundary=Math.max(...this.asks.keys());
    const bestBid=Math.max(...this.bids.keys()),bestAsk=Math.min(...this.asks.keys());
    if(bestBid>bestAsk)return this.failResync('CROSSED_SNAPSHOT');
    const mid=(bestBid+bestAsk)/2;
    this.snapshotAt=now;this.snapshotCovered25=this.bidBoundary<=mid*.9975&&this.askBoundary>=mid*1.0025;
    return this.drainBuffered();
  }
  event(e,t) {
    if(this.state!==BOOK_STATE.SYNCED){this.bufferEvent(e,t);return this.state===BOOK_STATE.RESYNCING?this.drainBuffered():{status:BOOK_STATE.UNSYNCED,buffered:true};}
    if(+e.u<=this.last)return {status:BOOK_STATE.SYNCED,duplicate:true};
    if(+e.pu!==this.last)return this.markUnsynced('DEPTH_SEQUENCE_MISMATCH',e,t);
    try{this.apply(e,t,true);return {status:BOOK_STATE.SYNCED};}
    catch(error){return this.markUnsynced(error.message,e,t);}
  }
  needsCoverageRefresh(now) {
    // A diff book can be fresh but its finite snapshot boundary may have been left
    // behind by price movement. Do not loop on intrinsically shallow 1000-level books.
    if(!this.ready||!this.snapshotCovered25||now-this.snapshotAt<60000||now-(this.coverageCheckedAt??-Infinity)<5000)return false;
    this.coverageCheckedAt=now;
    if(now-this.received>3000||now-this.at>10000)return false;
    // Recovery runs every 200 ms. Never sort full books or calculate impact here.
    let bid=-Infinity,ask=Infinity;for(const p of this.bids.keys())if(p>bid)bid=p;for(const p of this.asks.keys())if(p<ask)ask=p;
    if(!(bid>0&&ask>=bid))return false;const mid=(bid+ask)/2;
    return !(this.bidBoundary<=mid*.9975&&this.askBoundary>=mid*1.0025);
  }
  needsStaleResync(now) {
    return this.state===BOOK_STATE.SYNCED&&(!Number.isSafeInteger(this.received)||now-this.received>3000||
      !Number.isSafeInteger(this.at)||now-this.at>10000);
  }
  metrics(now) {
    if(this.state!==BOOK_STATE.SYNCED || !this.ready || now-this.received>3000 || this.at>now || now-this.at>10000) return {book_complete:false,reason:'BOOK_UNSYNCED_OR_STALE'};
    const bids=[...this.bids].sort((a,b)=>b[0]-a[0]),asks=[...this.asks].sort((a,b)=>a[0]-b[0]);
    const bid=bids[0]?.[0],ask=asks[0]?.[0],mid=(bid+ask)/2;
    if(!(bid>0 && ask>=bid)) return {book_complete:false,reason:'CROSSED_OR_EMPTY'};
    const depth=(rows,band,isBid)=>rows.filter(([p])=>isBid?p>=mid*(1-band):p<=mid*(1+band)).reduce((v,[p,q])=>v+p*q,0);
    const coverage=b=>this.bidBoundary<=mid*(1-b) && this.askBoundary>=mid*(1+b);
    return {book_complete:true,best_bid:bid,best_ask:ask,bid_qty:bids[0][1],ask_qty:asks[0][1],mid,
      depth_coverage_complete:coverage(.0025),depth_requested_bps:25,
      depth_bid_coverage_bps:Math.max(0,Math.min(25,(mid-this.bidBoundary)/mid*10000)),
      depth_ask_coverage_bps:Math.max(0,Math.min(25,(this.askBoundary-mid)/mid*10000)),
      depth_bid_boundary:this.bidBoundary,depth_ask_boundary:this.askBoundary,
      observed_bid_depth_usdt:depth(bids.filter(([p])=>p>=this.bidBoundary),.0025,true),
      observed_ask_depth_usdt:depth(asks.filter(([p])=>p<=this.askBoundary),.0025,false),
      spread_bps:(ask-bid)/mid*10000,bid_25_usdt:depth(bids,.0025,true),ask_25_usdt:depth(asks,.0025,false),
      bid_50_usdt:depth(bids,.005,true),ask_50_usdt:depth(asks,.005,false),coverage_25:coverage(.0025),coverage_50:coverage(.005),
      buy_vwap_450:vwap(asks,450),sell_vwap_450:vwap(bids,450),displayed_ask_added_5s:this.add,displayed_ask_removed_5s:this.remove,
      displayed_bid_added_5s:this.bidAdd,displayed_bid_removed_5s:this.bidRemove,
      exchange_at:iso(this.at),received_at:iso(this.received),last_update_id:this.last};
  }
}
export function vwap(levels,quote) {
  let left=quote,base=0;
  for(const [p,q] of levels) { const n=Math.min(left,p*q); base+=n/p; left-=n; if(left<1e-8) return quote/base; }
  return null;
}
export class Flow {
  constructor(){ this.last=null; this.reset(); }
  reset(){ this.buy=0;this.sell=0;this.seconds=new Map();this.count=0;this.eventAt=null;this.receivedAt=null;this.invalidTime=false;this.complete=this.last!==null;this.liquidation=0; }
  event(e,receivedAt=Date.now()){
    if(this.last!==null && +e.a<=this.last) return;
    if(this.last===null || +e.a!==this.last+1) this.complete=false;
    const eventAt=Math.max(Number(e.T),Number(e.E??e.T));
    if(!Number.isSafeInteger(eventAt)||!Number.isSafeInteger(receivedAt)||receivedAt-eventAt>10000||eventAt>receivedAt+1000)this.invalidTime=true;
    else{this.eventAt=Math.max(this.eventAt??0,eventAt);this.receivedAt=Math.max(this.receivedAt??0,receivedAt);}
    this.last=+e.a;const n=+e.p*(+e.q); if(e.m) {this.sell+=n;const k=Math.floor(+e.T/1000);this.seconds.set(k,(this.seconds.get(k)||0)+n);} else this.buy+=n;
    this.count++;
    if(this.seconds.size>30) this.complete=false;
    while(this.seconds.size>30) this.seconds.delete(this.seconds.keys().next().value);
  }
  metrics(cutoff=Date.now()){return {trade_event_at:this.eventAt===null?null:iso(this.eventAt),trade_received_at:this.receivedAt===null?null:iso(this.receivedAt),flow_causal:!this.invalidTime&&(this.eventAt===null||this.eventAt<=cutoff)&&(this.receivedAt===null||this.receivedAt<=cutoff),buy_quote_5s:this.buy,sell_quote_5s:this.sell,sell_quote_max_1s:Math.max(0,...this.seconds.values()),trade_count:this.count,trade_sequence_complete:this.complete,observed_liquidation_usdt:this.liquidation,liquidation_complete:false};}
}
// A finite snapshot can lose a usable best side while update IDs still chain.
// Retire only that book; its invalid interval stays ineligible until a fresh
// snapshot bridges and a complete interval is observed.
export function invalidateUnusableBook(book,metrics,now){
  if(book.state!==BOOK_STATE.SYNCED||metrics.book_complete!==false||metrics.reason!=='CROSSED_OR_EMPTY')return null;
  return book.markUnsynced('DEPTH_BOOK_INVALID',null,now);
}
// Keep exchange streams independent: a depth reconnect must not erase a
// still continuous trade stream or move the five-second bucket boundary.
export function retireBookCapture(s,now){
  // Depth continuity failure is symbol-local. Drop only this book generation and
  // reconnect quickly enough to obtain a fresh REST snapshot before the next 5s
  // bucket when possible. The broken interval remains invalid; trade flow, other
  // symbols and the shared bucket clock are untouched.
  s.book.reset();s.bookGeneration++;s.bookReconnectAt=now+250;
}
export function retireMarketCapture(s,now){
  s.flow.complete=false;s.marketSequenceVerified=false;
  s.marketResetAt=now;s.marketReconnectAt=now+5000;
}
/** Control-plane resilience (2026-09-29).
 *
 * WHY
 * ---
 * A 90-second Edge API outage used to end real-time market surveillance for HOURS. The worker
 * exited when `now-lastControl>90000`, and the machine was created with `--restart no --rm`, so
 * that exit DESTROYED it: nothing streamed again until a human noticed. On 2026-09-29 the
 * collector stopped at 04:33 KST and the account was blind for over five hours.
 *
 * THE RULE
 * --------
 * A transport failure is never fatal. Only the control plane saying "stop", or a signal, is.
 *   - 5xx / network / timeout / rate limit -> exponential backoff with jitter, retry forever.
 *   - control transport unavailable -> RUN DEGRADED on the last authoritative watch set; keep streams alive.\n *   - control explicitly disabled, or past its scheduled end -> IDLE, keep polling, never exit,
 *     so re-enabling recovers without a deploy.
 *   - a crash or a resource cap -> exit non-zero so the supervisor hands us a fresh process.
 * Jitter keeps a fleet from retrying in lockstep after a shared outage.
 */
// Production release trigger: collector DB-isolation semantics are unchanged; deploy the already-tested worker bundle.
export const CONTROL_RECOVERY=Object.freeze({baseMs:1000,maxMs:30000,factor:2,jitter:.25});
export function controlBackoffMs(failures,policy=CONTROL_RECOVERY,random=Math.random){
  if(!Number.isInteger(failures)||failures<1)return 0;
  const {baseMs,maxMs,factor,jitter}=policy;
  const raw=Math.min(maxMs,baseMs*factor**Math.min(failures-1,32));
  return Math.max(0,Math.round(raw*(1-jitter+2*jitter*random())));
}
/** What the worker does next. `exit` is the ONLY path that ends the process. */
export function controlDisposition({stopped=false,signalled=false,disabled=false,
  pastDeadline=false,overResourceCap=false,crashed=false}={}){
  if(signalled)return {action:'exit',code:0,reason:'SIGNAL'};
  if(crashed)return {action:'exit',code:1,reason:'CRASHED'};
  if(overResourceCap)return {action:'exit',code:1,reason:'RESOURCE_CAP'};
  // Not exits: the control plane can hand authority back at any time, and a destroyed
  // machine cannot come back on its own.
  if(disabled)return {action:'idle',code:null,reason:'CONTROL_DISABLED'};
  if(pastDeadline)return {action:'idle',code:null,reason:'CONTROL_WINDOW_ENDED'};
  if(stopped)return {action:'run',code:null,reason:'CONTROL_UNAVAILABLE'};
  return {action:'run',code:null,reason:null};
}
export function snapshotStillCurrent(s,generation,socket){
  return s.bookGeneration===generation && s.socket===socket;
}
// A late timer tick must not make the following bucket artificially short.
// Wait without resetting flow until the existing minimum interval is present.
// Emit overdue intervals as-is so completeCaptureInterval still rejects them.
export function initialBucketBoundary(now){return Math.floor(now/5000)*5000;}
export function captureBucketDue(lastBucket,now){
  return Number.isSafeInteger(lastBucket)&&Number.isSafeInteger(now)&&
    Math.floor(now/5000)>Math.floor(lastBucket/5000)&&now-lastBucket>=4500;
}
export function completeCaptureInterval(s,now,marketOpen){
  return s.started<=s.lastBucket && s.book.syncAt<=s.lastBucket &&
    s.marketResetAt<=s.lastBucket && s.marketSequenceVerified && marketOpen &&
    now-s.lastBucket>=4500 && now-s.lastBucket<=5500;
}
export function inWindow(t,windows,symbol){return windows.some(w=>w.symbol===symbol && t>=Date.parse(w.at)-60000 && t<=Date.parse(w.at)+120000);}
export class WeightBudget {
  constructor(){this.used=[];}
  claim(n,now,limit=100){this.used=this.used.filter(x=>x[0]>now-60000);if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(n)||n<=0||this.used.reduce((s,x)=>s+x[1],0)+n>limit)return false;this.used.push([now,n]);return true;}
}

// The last actually received, closed BTC candle is the only injection source.
export function closedCandle(e,receivedAt){
 const k=e.k,start=Number(k?.t),end=start+60000;
 if(k?.x!==true||!Number.isSafeInteger(start)||Number(k.T)!==end-1||!(Number(k.o)>0)||!(Number(k.c)>0))return null;
 return {at:iso(start),end_ms:end,exchange_ms:Number(e.E),received_ms:receivedAt,complete:true,return_1m:Number(k.c)/Number(k.o)-1};
}
export function btcCandleFields(c,cutoff){
 const valid=c?.complete===true&&[c.end_ms,c.exchange_ms,c.received_ms,cutoff].every(Number.isSafeInteger)&&
  c.end_ms<=cutoff&&c.exchange_ms<=cutoff&&c.received_ms<=cutoff&&c.exchange_ms>=c.end_ms-1&&
  c.received_ms>=c.exchange_ms-1000&&c.received_ms-c.exchange_ms<=10000&&cutoff-c.end_ms<=65000&&Number.isFinite(c.return_1m);
 return {btc_return_1m:valid?c.return_1m:null,btc_candle_at:c?.at??null,
  btc_candle_complete:valid,btc_candle_end_ms:c?.end_ms??null,btc_candle_exchange_ms:c?.exchange_ms??null,btc_candle_received_ms:c?.received_ms??null};
}
