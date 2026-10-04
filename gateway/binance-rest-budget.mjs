// One process serves the dedicated egress IP. Admission is immediate: waiting here
// would age quotes, signed payloads and writer submission evidence.
export function requestWeight(path, params={}) {
 if(path.endsWith('/depth')){const n=Number(params.limit)||100;return n<=50?2:n<=100?5:n<=500?10:20;}
 if(path.endsWith('/openOrders'))return params.symbol?1:40;
 if(path.endsWith('/openAlgoOrders'))return 40;
 if(path.endsWith('/positionSide/dual'))return 30;
 if(path.endsWith('/commissionRate'))return 20;
 if(path.endsWith('/account')||path.endsWith('/positionRisk'))return 5;
 if(path.endsWith('/userTrades')||path.endsWith('/allOrders'))return 20;
 if(path.endsWith('/trades')||path.endsWith('/aggTrades'))return 20;
 if(path.endsWith('/ticker/24hr'))return params.symbol?1:40;
 if(path.endsWith('/ticker/bookTicker'))return params.symbol?2:5;
 if(path.endsWith('/ticker/price'))return params.symbol?1:2;
 if(path.endsWith('/klines')){const n=Number(params.limit)||500;return n<100?1:n<500?2:n<=1000?5:10;}
 if(path.endsWith('/exchangeInfo')||path.endsWith('/time')||path.endsWith('/order')||path.endsWith('/leverage'))return 1;
 return 50; // Unknown routes consume conservative headroom, never zero weight.
}
export function createBinanceRestBudget({now=Date.now,limit=2400,reserve=300,blockedUntil=0}={}) {
 let sequence=0,minute=-1,observed=0,blocked=Number(blockedUntil)||0,reason='STARTUP_EXCHANGE_COOLDOWN';
 const reads=[],pending=new Map(),totals=new Map();let denied=0;
 function state(){const t=now(),m=Math.floor(t/60000);if(m!==minute){minute=m;observed=0;}
  while(reads.length&&reads[0].at<=t-60000)reads.shift();
  return {t,used:Math.max(reads.reduce((n,r)=>n+r.weight,0),observed+[...pending.values()].reduce((n,r)=>n+r.weight,0))};}
 function fail(code,until){denied++;throw Object.assign(new Error(`${code}: REST unavailable until ${until}`),{status:429,code,retryAfter:Math.max(1,Math.ceil((until-now())/1000)),retryAtMs:until});}
 return {
  admit(path,params={},method='GET'){
   const {t,used}=state();if(t<blocked)fail(reason,blocked);
   const weight=requestWeight(path,params),risk=method!=='GET'||/\/(account|positionRisk|order|openOrders|openAlgoOrders)$/.test(path);
   if(used+weight>(risk?limit:limit-reserve))fail('BINANCE_WEIGHT_BUDGET',Math.floor(t/60000)*60000+60000);
   const row={id:++sequence,at:t,weight,path};reads.push(row);pending.set(row.id,row);
   const x=totals.get(path)||{requests:0,weight:0};x.requests++;x.weight+=weight;totals.set(path,x);return row;
  },
  observe(response,token){
   pending.delete(token.id);state();
   const used=Number(response.headers.get('x-mbx-used-weight-1m'));if(Number.isFinite(used))observed=Math.max(observed,used);
   if(response.status===429||response.status===418){
    const retry=response.headers.get('retry-after'),seconds=Number(retry),date=Date.parse(retry);
    const until=Number.isFinite(seconds)&&seconds>0?now()+seconds*1000:Number.isFinite(date)?date:now()+(response.status===418?120000:60000);
    blocked=Math.max(blocked,until);reason=response.status===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED';
   }
  },
  banFromBody(error){const match=String(error?.message??'').match(/banned until (\d{13})/);if(match){blocked=Math.max(blocked,Number(match[1]));reason='BINANCE_IP_BANNED';}},
  finish(token){pending.delete(token.id);},
  snapshot(){const {t,used}=state();return {limit,reserve,estimated_or_observed_weight:used,exchange_observed_weight:observed,blocked_until_ms:blocked>t?blocked:null,reason:blocked>t?reason:null,denied,in_flight:pending.size,endpoints:Object.fromEntries(totals)};}
 };
}
