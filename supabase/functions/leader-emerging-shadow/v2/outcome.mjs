/** LE-SHADOW-2 hypothetical outcome labels. Pure.
 * For each horizon h in 5/15/30/60/120/240 minutes, from 1m klines that start at the entry
 * minute (future data is used ONLY here, after maturity, never for a decision):
 *   ret     close of the bar ending at entry+h / entry price - 1
 *   mfe/mae max high / min low of bars inside (entry, entry+h] vs entry price
 *   gross   ret in bps (GROSS)
 *   net     gross - round trip (NET_ESTIMATED): fee in 5 + fee out 5 bps (production taker rate,
 *           leader-exit-r3 estimatedExitFeeRate 0.0005) + measured entry slippage beyond the ask
 *           + exit slippage 5 bps (assumed; the only estimate)
 * An unknown cost is NEVER 0: net is null and cost_basis says GROSS_ONLY. */
export const OUTCOME_V2_VERSION='LE_OUTCOME_2';
export const HORIZONS=Object.freeze([5,15,30,60,120,240]);
export const KLINE_LIMIT=241;
export const COSTS_V2=Object.freeze({feeEntryBps:5,feeExitBps:5,exitSlipBps:5,feeSource:'production taker 0.05% (leader-exit-r3 estimatedExitFeeRate)'});
const MIN=60_000;
const fin=x=>typeof x==='number'&&Number.isFinite(x);

export function maturityAtV2(entryAt){return Math.floor(entryAt/MIN)*MIN+KLINE_LIMIT*MIN+30_000;}

/** Entry slippage beyond the best ask from an average-fill-vs-mid slippage and the spread. */
export function beyondAskBps(slipVsMidBps,spreadBps){
  return fin(slipVsMidBps)&&fin(spreadBps)?Math.max(0,slipVsMidBps-spreadBps/2):null;
}
export function roundTripBps(beyond){
  return fin(beyond)?COSTS_V2.feeEntryBps+COSTS_V2.feeExitBps+beyond+COSTS_V2.exitSlipBps:null;
}

function parse(raw){
  return (Array.isArray(raw)?raw:[]).map(r=>({t:Number(r[0]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),end:Number(r[6])}))
    .filter(b=>Number.isSafeInteger(b.t)&&b.t%MIN===0&&b.c>0&&b.h>0&&b.l>0).sort((a,b)=>a.t-b.t);
}

/**
 * @param entry {at (ms), price (entry ask), beyondAskBps (measured or null)}
 * @param raw   Binance 1m rows starting at floor(entry.at) (limit 241)
 */
export function labelV2(entry,raw){
  const bs=parse(raw),t0=Math.floor(entry.at/MIN)*MIN,p0=Number(entry.price);
  if(!(p0>0))throw Error('ENTRY_PRICE_INVALID');
  let contiguous=bs.length>0&&bs[0].t===t0;for(let i=1;i<bs.length&&contiguous;i++)if(bs[i].t-bs[i-1].t!==MIN)contiguous=false;
  const cost=roundTripBps(entry.beyondAskBps);
  const horizons={};
  for(const h of HORIZONS){
    const endT=t0+h*MIN,b=bs.find(x=>x.t===endT-MIN);   // the bar that closes at entry minute + h
    const inside=bs.filter(x=>x.t>=t0&&x.t<endT);
    const ret=b?b.c/p0-1:null;
    const ok=contiguous&&inside.length>=h&&ret!==null;
    const mfe=inside.length?Math.max(...inside.map(x=>x.h))/p0-1:null,mae=inside.length?Math.min(...inside.map(x=>x.l))/p0-1:null;
    horizons[h]={ret:ok?ret:null,mfe:ok?mfe:null,mae:ok?mae:null,gross_bps:ok?ret*1e4:null,
      net_bps:ok&&cost!==null?ret*1e4-cost:null,complete:ok};
  }
  const g=h=>horizons[h];
  return {outcome_version:OUTCOME_V2_VERSION,horizons,
    ret_5m:g(5).ret,ret_15m:g(15).ret,ret_30m:g(30).ret,ret_60m:g(60).ret,ret_120m:g(120).ret,ret_240m:g(240).ret,
    mfe_60m:g(60).mfe,mae_60m:g(60).mae,mfe_240m:g(240).mfe,mae_240m:g(240).mae,
    gross_bps_60m:g(60).gross_bps,net_bps_60m:g(60).net_bps,gross_bps_120m:g(120).gross_bps,net_bps_120m:g(120).net_bps,
    gross_bps_240m:g(240).gross_bps,net_bps_240m:g(240).net_bps,
    roundtrip_cost_bps:cost,cost_basis:cost===null?'GROSS_ONLY':'NET_ESTIMATED',
    cost:{...COSTS_V2,entry_slippage_beyond_ask_bps:fin(entry.beyondAskBps)?entry.beyondAskBps:null},
    data_complete:contiguous&&bs.length>=KLINE_LIMIT};
}
