export const VERSION = 'DOA-CAPTURE-1.1';
export const iso = n => new Date(n).toISOString();
export function streamURLs(symbol){
  const s=symbol.toLowerCase();
  return {book:'wss://fstream.binance.com/public/stream?streams='+s+'@depth@100ms',
    market:'wss://fstream.binance.com/market/stream?streams='+['aggTrade','kline_1m','forceOrder'].map(x=>s+'@'+x).join('/')};
}
export class Book {
  constructor() { this.reset(); }
  reset() { this.bids=new Map(); this.asks=new Map(); this.last=null; this.ready=false; this.buffer=[]; this.at=0; this.add=0; this.remove=0; this.received=0; this.syncAt=Infinity; }
  snapshot(s) {
    this.bids=new Map(s.bids.map(([p,q])=>[+p,+q])); this.asks=new Map(s.asks.map(([p,q])=>[+p,+q]));
    this.last=+s.lastUpdateId; this.ready=false;
    this.bidBoundary=Math.min(...this.bids.keys()); this.askBoundary=Math.max(...this.asks.keys());
    const pending=this.buffer; this.buffer=[];
    for (const [e,t] of pending) this.event(e,t);
  }
  event(e,t) {
    // Before snapshot, retain only the latest20s; a missing bridge still fails closed.
    if (this.last===null) { if(this.buffer.length>=200)this.buffer.shift(); this.buffer.push([e,t]); return; }
    if (+e.u<this.last || (this.ready && +e.u===this.last)) return;
    if ((!this.ready && !(+e.U<=this.last && +e.u>=this.last)) || (this.ready && +e.pu!==this.last)) throw Error('DEPTH_GAP');
    for(const [side,rows] of [[this.bids,e.b],[this.asks,e.a]]) for(const [p0,q0] of rows) {
      const p=+p0,q=+q0,old=side.get(p)||0;
      if(side===this.asks && this.ready) { this.add+=Math.max(0,q-old)*p; this.remove+=Math.max(0,old-q)*p; }
      if(q===0) side.delete(p); else side.set(p,q);
    }
    if(this.bids.size+this.asks.size>12000) throw Error('DEPTH_MEMORY_CAP');
    if(!this.ready)this.syncAt=t;
    this.last=+e.u; this.at=+e.E; this.received=t; this.ready=true;
  }
  metrics(now) {
    if(!this.ready || now-this.received>3000) return {book_complete:false,reason:'BOOK_UNSYNCED_OR_STALE'};
    const bids=[...this.bids].sort((a,b)=>b[0]-a[0]),asks=[...this.asks].sort((a,b)=>a[0]-b[0]);
    const bid=bids[0]?.[0],ask=asks[0]?.[0],mid=(bid+ask)/2;
    if(!(bid>0 && ask>=bid)) return {book_complete:false,reason:'CROSSED_OR_EMPTY'};
    const depth=(rows,band,isBid)=>rows.filter(([p])=>isBid?p>=mid*(1-band):p<=mid*(1+band)).reduce((v,[p,q])=>v+p*q,0);
    const coverage=b=>this.bidBoundary<=mid*(1-b) && this.askBoundary>=mid*(1+b);
    return {book_complete:true,best_bid:bid,best_ask:ask,bid_qty:bids[0][1],ask_qty:asks[0][1],mid,
      spread_bps:(ask-bid)/mid*10000,bid_25_usdt:depth(bids,.0025,true),ask_25_usdt:depth(asks,.0025,false),
      bid_50_usdt:depth(bids,.005,true),ask_50_usdt:depth(asks,.005,false),coverage_25:coverage(.0025),coverage_50:coverage(.005),
      buy_vwap_450:vwap(asks,450),sell_vwap_450:vwap(bids,450),displayed_ask_added_5s:this.add,displayed_ask_removed_5s:this.remove,
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
  reset(){ this.buy=0;this.sell=0;this.seconds=new Map();this.count=0;this.complete=this.last!==null;this.liquidation=0; }
  event(e){
    if(this.last!==null && +e.a<=this.last) return;
    if(this.last===null || +e.a!==this.last+1) this.complete=false;
    this.last=+e.a;const n=+e.p*(+e.q); if(e.m) {this.sell+=n;const k=Math.floor(+e.T/1000);this.seconds.set(k,(this.seconds.get(k)||0)+n);} else this.buy+=n;
    this.count++;
    if(this.seconds.size>30) this.complete=false;
    while(this.seconds.size>30) this.seconds.delete(this.seconds.keys().next().value);
  }
  metrics(){return {buy_quote_5s:this.buy,sell_quote_5s:this.sell,sell_quote_max_1s:Math.max(0,...this.seconds.values()),trade_count:this.count,trade_sequence_complete:this.complete,observed_liquidation_usdt:this.liquidation,liquidation_complete:false};}
}
export function inWindow(t,windows,symbol){return windows.some(w=>w.symbol===symbol && t>=Date.parse(w.at)-60000 && t<=Date.parse(w.at)+120000);}
export class WeightBudget {
  constructor(){this.used=[];}
  claim(n,now){this.used=this.used.filter(x=>x[0]>now-60000);if(this.used.reduce((s,x)=>s+x[1],0)+n>100)return false;this.used.push([now,n]);return true;}
}
