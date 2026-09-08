import {POLICY,M5,M15,activeSymbols,parseBars,feature15,rankFeatures,entryReason,confirm5} from './leader-momentum-v17.mjs';
// Public GET endpoints only. No API key, order endpoint, repository price cache or DB history.
export async function scanMarket({fetchFn=fetch,now=Date.now(),policy=POLICY,concurrency=6,
  maxWeight=1800,timeoutMs=100_000}={}) {
  const start=Date.now();let weight=0,fatal=null;
  async function get(path,cost) {
    if(fatal) throw fatal;
    if(Date.now()-start>timeoutMs) throw Error('SCAN_DEADLINE');
    if(weight+cost>maxWeight) {fatal=Error('SCAN_WEIGHT_BUDGET');throw fatal;}
    weight+=cost;
    const r=await fetchFn('https://fapi.binance.com'+path,{method:'GET',signal:AbortSignal.timeout(8_000)});
    // A rate limit or regional restriction is not retried through another host.
    if(!r.ok){const e=Error(`BINANCE_HTTP_${r.status}`);if([418,429,451].includes(r.status)) fatal=e;throw e;}
    const used=Number(r.headers?.get?.('x-mbx-used-weight-1m'));
    if(Number.isFinite(used)&&used>=2100) {fatal=Error('SHARED_IP_WEIGHT_HIGH');throw fatal;}
    return r.json();
  }
  async function pool(items,fn) {
    const out=new Array(items.length);let cursor=0;
    await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
      while(cursor<items.length){const i=cursor++;try{out[i]={value:await fn(items[i])};}catch(e){out[i]={symbol:items[i],error:String(e.message||e)};}}
    }));return out;
  }
  const remote=await get('/fapi/v1/time',1),clock=Number(remote.serverTime);
  if(!Number.isFinite(clock)||Math.abs(clock-now)>5_000) throw Error('SERVER_CLOCK_SKEW');
  const cut15=Math.floor(clock/M15)*M15,cut5=Math.floor(clock/M5)*M5;
  const info=await get('/fapi/v1/exchangeInfo',1),universe=activeSymbols(info,cut15);
  if(!universe.symbols.length) throw Error('EMPTY_ACTIVE_COIN_UNIVERSE');
  const rows=await pool(universe.symbols,async symbol=>{
    const qs=new URLSearchParams({symbol,interval:'15m',limit:'110',endTime:String(cut15-1)});
    const bars=parseBars(await get('/fapi/v1/klines?'+qs,2),M15,cut15,110);
    return feature15(symbol,bars,cut15);
  });
  const errors=rows.filter(x=>x.error),features=rows.filter(x=>x.value).map(x=>x.value);
  const coverage=features.length/universe.symbols.length,ranked=rankFeatures(features);
  const reasons={},eligible=[];
  for(const f of ranked){const r=entryReason(f,policy);reasons[r]=(reasons[r]||0)+1;if(r==='ELIGIBLE')eligible.push(f);}
  const base={source:'BINANCE_USDM_PUBLIC_REST',cut15,cut5,serverTime:clock,expected:universe.symbols.length,
    evaluated:features.length,coverage,weight,excluded:universe.excluded,errors,reasons,top10:ranked.slice(0,10)};
  if(fatal||coverage<policy.minCoverage) return {...base,blocked:fatal?.message||'MARKET_COVERAGE_INCOMPLETE',candidates:[]};
  const confirmations=await pool(eligible,async f=>{
    const qs=new URLSearchParams({symbol:f.symbol,interval:'5m',limit:'14',endTime:String(cut5-1)});
    return confirm5(f,parseBars(await get('/fapi/v1/klines?'+qs,1),M5,cut5,14),cut5,policy);
  });
  const scanEnd=now+(Date.now()-start);
  const blocked=fatal?.message||(scanEnd-cut5>policy.maxEntryAgeMs?'SCAN_FINISHED_AFTER_ENTRY_WINDOW':null);
  return {...base,weight,scanDurationMs:Date.now()-start,blocked,
    confirmationErrors:confirmations.filter(x=>x.error).map(x=>({symbol:x.symbol?.symbol,error:x.error})),
    candidates:blocked?[]:confirmations.filter(x=>x.value).map(x=>({...x.value,marketCoverage:coverage,
      marketExpected:universe.symbols.length,marketEvaluated:features.length}))};
}
