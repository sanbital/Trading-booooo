/** LE-SHADOW-2 compressed full-market context. Pure and read-only.
 *
 * Input is one point-in-time public.market_regime_observations row selected at-or-before the
 * candidate snapshot. The raw observer feature tree is deliberately NOT forwarded to GPT.
 * This module keeps only stable, compact context so the individual-symbol evidence remains primary.
 * It is also covered by the shadow order-free static surface test.
 */
export const MARKET_CONTEXT_VERSION='LE_MARKET_CONTEXT_1';
export const MARKET_CONTEXT_MAX_AGE_MS=10*60_000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const n=x=>x===null||x===undefined||x===''?null:(Number.isFinite(Number(x))?Number(x):null);
const ms=x=>x instanceof Date?x.getTime():typeof x==='number'?x:Date.parse(x);
const obj=x=>{if(x&&typeof x==='object'&&!Array.isArray(x))return x;if(typeof x==='string'){try{const v=JSON.parse(x);return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{}}return {};};
const iso=x=>Number.isFinite(x)?new Date(x).toISOString():null;

function breadth(x){
  const v=obj(x);
  return {sample_size:n(v.sample_size),positive_fraction:n(v.positive_fraction),clipped_mean_pct:n(v.clipped_mean_pct),
    gain_tail_fraction:n(v.gain_tail_fraction),loss_tail_fraction:n(v.loss_tail_fraction)};
}
function usefulBreadth(x){return fin(x?.positive_fraction)||fin(x?.clipped_mean_pct);}
function breadthState(b24,b30){
  const p24=b24?.positive_fraction,p30=b30?.positive_fraction;
  if(!fin(p24)||!fin(p30))return 'UNKNOWN';
  if(p24>=.60&&p30>=.60)return 'BROAD_RISK_ON';
  if(p24<=.40&&p30<=.40)return 'BROAD_RISK_OFF';
  if(p24>=.60&&p30<=.40)return 'STRONG_24H_WEAK_30M';
  if(p24<=.40&&p30>=.60)return 'WEAK_24H_REBOUND_30M';
  return 'MIXED';
}
function benchmark(features){
  const rows=Array.isArray(features?.benchmark?.markets)?features.benchmark.markets:[];
  const out={};
  for(const asset of ['BTC','ETH','SOL']){
    const r=rows.find(x=>x?.asset===asset&&x?.venue==='binance_futures')??rows.find(x=>x?.asset===asset&&x?.venue==='binance_spot');
    if(!r)continue;
    out[asset]={venue:r.venue??null,return_30m_pct:n(r.r30),return_2h_pct:n(r.r120),return_6h_pct:n(r.r360),
      return_24h_pct:n(r.r1440),market_score:n(r.score)};
  }
  return out;
}
function empty(status,age=null,observed=null){
  return {version:MARKET_CONTEXT_VERSION,status,observed_at:observed,age_ms:age,source:'MARKET_REGIME_OBSERVER_READ_ONLY',
    universe:null,regime:null,breadth:null,benchmarks:{},breadth_state:'UNKNOWN',
    direct_marketwide_liquidity:{status:'NOT_INCLUDED_PHASE_1'},news_context:{status:'NOT_INCLUDED_PHASE_1'}};
}

/** Build a compact context using only a row whose observed_at <= asOf. */
export function buildMarketContext(row,asOf){
  const t=ms(row?.observed_at),at=ms(asOf);
  if(!row||!fin(t)||!fin(at))return empty('MISSING');
  const age=at-t;
  if(age<0)return empty('INVALID_TIME',age,iso(t));
  if(age>MARKET_CONTEXT_MAX_AGE_MS)return empty('STALE',age,iso(t));
  const f=obj(row.features),u=obj(f.universe);
  const b24=breadth(f?.breadth_24h?.binance_futures),b30=breadth(f?.breadth_30m?.binance_futures);
  const phase=obj(f.momentum_phase);
  const ctx={version:MARKET_CONTEXT_VERSION,status:(usefulBreadth(b24)||usefulBreadth(b30))?'OK':'PARTIAL',
    observed_at:iso(t),age_ms:Math.round(age),source:'MARKET_REGIME_OBSERVER_READ_ONLY',
    universe:{total:n(u.total)??n(row.sample_size),binance_futures:n(u.binance_futures),binance_spot:n(u.binance_spot),upbit_spot:n(u.upbit_spot)},
    regime:{predicted:row.predicted_regime??null,bull_score:n(row.bull_score),confidence:n(row.confidence),momentum_phase:phase.phase??null},
    breadth:{binance_futures_24h:b24,binance_futures_30m:b30},
    benchmarks:benchmark(f),breadth_state:breadthState(b24,b30),
    direct_marketwide_liquidity:{status:'NOT_INCLUDED_PHASE_1'},news_context:{status:'NOT_INCLUDED_PHASE_1'}};
  return ctx;
}
