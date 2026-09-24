/** LE-SHADOW-1 precise reads for the shortlist only (<=3 symbols per cycle).
 * Imports the production PURE modules unchanged: feature15/entryReason/parseBars (V17),
 * evaluateB06133, v30FrontDecision, readSources/computeFacts (FD1). Every Binance read goes
 * through the guard. No account, order or signed endpoint exists in this file. */
import {parseBars,feature15,entryReason,M15,POLICY as V17_POLICY} from '../_shared/leader-momentum-v17.mjs';
import {evaluateB06133} from '../_shared/leader-b06133-entry.mjs';
import {v30FrontDecision} from '../_shared/gpt-final-review/contract.mjs';
import {readSources} from '../_shared/gpt-final-decision/market.mjs';
import {computeFacts} from '../_shared/gpt-final-decision/facts.mjs';
import {getJson} from './guard.mjs';

const MIN=60_000;
export const COSTS=Object.freeze({feeEntryBps:5,feeExitBps:5,exitSlipBps:5,stressBps:44,notionalUsdt:600,auxNotionalUsdt:450});
export const HARD_RULES=Object.freeze({maxSpreadBps:25,minAskDepthToOrder:1.5,maxSlippageBps:25});
const B06133_FACTORS=['absorption','volumeTails','fresh15over30','btcAnyUp','buyerShareRise','fresh5over15','recentHourLead'];

/** 15m klines (limit 110) -> production V17 feature at the last closed 15m bar. */
export async function readV17(guard,symbol,now){
  const cut15=Math.floor(now/M15)*M15;
  const raw=await getJson(guard,'/fapi/v1/klines',{symbol,interval:'15m',limit:110,endTime:cut15-1});
  const bars=parseBars(raw,M15,cut15,110);
  return feature15(symbol,bars,cut15);
}

/** BTC 15m x 9 (once per cycle) for B06133's btcAnyUp. */
export async function readBtc15(guard,decisionAt){
  const lastOpen=Math.floor(decisionAt/M15)*M15-M15;
  return getJson(guard,'/fapi/v1/klines',{symbol:'BTCUSDT',interval:'15m',startTime:lastOpen-8*M15,endTime:decisionAt-1,limit:9});
}

/** Average fill vs mid (bps) of a market BUY of `notional` walking the asks; null if the book is too thin. */
export function buySlippageBps(book,notional){
  const asks=(book?.asks??[]).map(r=>[Number(r[0]),Number(r[1])]).filter(([p,q])=>p>0&&q>=0);
  const bid=Number(book?.bids?.[0]?.[0]),ask=asks[0]?.[0];
  if(!(bid>0&&ask>=bid))return null;
  const mid=(bid+ask)/2;let left=notional,cost=0,qty=0;
  for(const [p,q] of asks){const take=Math.min(left,p*q);cost+=take;qty+=take/p;left-=take;if(left<=1e-9)break;}
  return left>1e-9?null:((cost/qty)/mid-1)*1e4;
}

/** Explicit cost facts (bps of notional). */
export function costFacts(facts,book){
  const v=facts?.values??{};
  const spread=v.spread_bps,slip600=v.est_buy_slippage_bps,slip450=book?buySlippageBps(book,COSTS.auxNotionalUsdt):null;
  const fees=COSTS.feeEntryBps+COSTS.feeExitBps;
  const beyondAsk=(s)=>Number.isFinite(s)&&Number.isFinite(spread)?Math.max(0,s-spread/2):null;
  const real=Number.isFinite(slip600)?fees+slip600+COSTS.exitSlipBps:null;
  return {fee_entry_bps:COSTS.feeEntryBps,fee_exit_bps:COSTS.feeExitBps,assumed_exit_slippage_bps:COSTS.exitSlipBps,
    spread_bps:Number.isFinite(spread)?spread:null,entry_slippage_bps_600:Number.isFinite(slip600)?slip600:null,
    entry_slippage_bps_450:Number.isFinite(slip450)?slip450:null,
    entry_slippage_beyond_ask_bps_600:beyondAsk(slip600),entry_slippage_beyond_ask_bps_450:beyondAsk(slip450),
    roundtrip_cost_bps_real:real,breakeven_bps:real,
    cost_band_bps:Number.isFinite(spread)&&Number.isFinite(slip600)?spread+slip600+fees:null,
    stress_cost_bps:COSTS.stressBps,notional_usdt:COSTS.notionalUsdt};
}

/** Deterministic execution blocks (not strategy judgments): unexecutable at 600 USDT. */
export function hardBlocks(facts,H=HARD_RULES){
  const v=facts?.values??{},out=[];
  if(!facts?.quality?.micro_complete)out.push('MICRO_INCOMPLETE');
  if(Number.isFinite(v.spread_bps)&&v.spread_bps>H.maxSpreadBps)out.push('SPREAD_GT_25BPS');
  if(Number.isFinite(v.ask_depth_to_order)&&v.ask_depth_to_order<H.minAskDepthToOrder)out.push('ASK_DEPTH_LT_1_5X');
  if(Number.isFinite(v.est_buy_slippage_bps)&&v.est_buy_slippage_bps>=H.maxSlippageBps)out.push('SLIPPAGE_GE_25BPS');
  return out;
}

const r5From=five=>{
  const b=(Array.isArray(five)?five:[]).map(x=>({t:Number(x[0]),c:Number(x[4])})).sort((a,b)=>a.t-b.t);
  return b.length>=2&&b.at(-2).c>0?b.at(-1).c/b.at(-2).c-1:null;
};

/**
 * All precise facts for one shortlisted candidate. Every bar used closes strictly before
 * asOf (computeFacts/parseBars/b06133Inputs enforce it). Never throws for one source.
 */
export async function preciseRead(guard,c,{asOf,btc15,btcCache,v17Top10=new Map()}){
  const errors={};
  let v17=null;
  try{v17=await readV17(guard,c.symbol,asOf);}catch(e){errors.v17=String(e?.code??e?.message??e).slice(0,80);}
  const {src,errors:srcErr}=await readSources(c.symbol,asOf,{mode:'LIVE',fetchFn:guard.fetch,ms:3000,btcCache});
  Object.assign(errors,Object.fromEntries(Object.entries(srcErr).map(([k,v])=>['fd1_'+k,v])));
  let facts=null;
  try{facts=computeFacts(src,{asOf,referenceClose:c.price,dayReturn:c.dayReturn,rank:c.rank});}catch(e){errors.facts=String(e?.message??e).slice(0,80);}
  const decisionAt=Math.floor(asOf/MIN)*MIN;
  const b06133=evaluateB06133({features:{volumeRatio:v17?.volumeRatio,return5m:r5From(src.five),return15m:v17?.return15m,
    return30m:v17?.return30m,return60m:v17?.return60m},prebars:src.one,btcBars:btc15,decisionAt});
  const v30=v30FrontDecision(b06133);
  const prodRank=v17Top10.get(c.symbol)??null;
  const v17Out=v17?{signal15Close:v17.signal15Close,dayStart:v17.dayStart,day_return:v17.dayReturn,return_15m:v17.return15m,
    return_30m:v17.return30m,return_60m:v17.return60m,vr15:v17.volumeRatio,qv24:v17.qv24,reference15Close:v17.reference15Close,
    production_top10_rank:prodRank,
    entry_reason:entryReason({...v17,rank:prodRank??99},V17_POLICY),
    entry_reason_at_live_rank:entryReason({...v17,rank:c.rank},V17_POLICY)}:null;
  const cost=facts?costFacts(facts,src.book):null;
  return {v17:v17Out,vr15:v17?.volumeRatio??null,facts,src,
    b06133:{version:b06133.version,reason:b06133.reason,allowed:b06133.allowed,branch:b06133.branch,
      factors:Object.fromEntries(B06133_FACTORS.map(k=>[k,b06133.factors[k]])),decisionAt},
    v30:{version:v30.version,admitted:v30.admitted,failed:v30.failed,unknown:v30.unknown,required:v30.required},
    cost,hardBlock:facts?hardBlocks(facts):['FACTS_UNAVAILABLE'],errors};
}

/** Decision-time quote (depth limit 5): best ask/bid/mid, spread, slippage of the top levels. */
export async function readQuote(guard,symbol,now=Date.now){
  const book=await getJson(guard,'/fapi/v1/depth',{symbol,limit:5});
  const bid=Number(book?.bids?.[0]?.[0]),ask=Number(book?.asks?.[0]?.[0]);
  if(!(bid>0&&ask>=bid))throw Error('QUOTE_INVALID');
  return {at:now(),bid,ask,mid:(bid+ask)/2,spread_bps:(ask-bid)/((bid+ask)/2)*1e4,book};
}
