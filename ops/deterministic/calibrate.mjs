/** Pooled engineering bands, not a fitted PnL classifier. Training data stay private.
 * Usage: node ops/deterministic/calibrate.mjs <entry50.json> <training-end-ISO> <profile.mjs>
 * No account, symbol, outcome or date appears in market decision rules.
 */
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {ENGINE,quantile} from '../../supabase/functions/_shared/deterministic/market-state.mjs';
export function calibrate(bytes,trainingEnd){
 const data=JSON.parse(bytes),entries=new Map(data.entries.map(e=>[e.signal_id,e])),positions=data.positions.filter(p=>Date.parse(p.entry_at)<Date.parse(trainingEnd)),bands={};
 const band=(name,values,basis,ps=[.5,.9,.99])=>{const a=values.filter(Number.isFinite);bands[name]={normal:quantile(a,ps[0]),caution:quantile(a,ps[1]),block:quantile(a,ps[2]),samples:a.length,quantiles:ps,basis};};
 for(const name of ['ema9_distance','bb_position','rsi_1m_14','rsi_5m_14','stoch_k_1m','atr_1m_14_normalized','spread_bps','day_return'])
  band(name,positions.map(p=>entries.get(p.signal_id)?.facts?.values?.[name]),'FIRST_RECORDED_ENTRY_FACT:'+name);
 band('volume',positions.map(p=>entries.get(p.signal_id)?.facts?.values?.volume_ratio_5m_vs_60m),'LAST_5M_MEAN_QUOTE_VOLUME/PRECEDING_55M_MEAN');
 band('roundtrip_impact_bps',positions.map(p=>{const v=entries.get(p.signal_id)?.facts?.values??{};
  return Number.isFinite(v.est_buy_slippage_bps)&&Number.isFinite(v.est_sell_slippage_bps)?v.est_buy_slippage_bps+v.est_sell_slippage_bps:NaN;}),'RECORDED_ENTRY_BOOK_450_USDT_BUY_AND_EXIT_IMPACT_EXCLUDING_FEES');
 band('entry_drift',positions.map(p=>{const c=entries.get(p.signal_id)?.facts?.capture_context,mid=c?.trajectory?.at(-1)?.mid;
  return mid>0?Number(p.entry_price)/mid-1:NaN;}),'EXECUTED_ENTRY_PRICE/LAST_RECORDED_DECISION_CAPTURE_MID-1');
 band('mfe',positions.map(p=>Number(p.peak_price)/Number(p.entry_price)-1),'HISTORICAL_SAMPLED_PEAK/ENTRY-1;CAUTION_IS_PROTECTION_ARM_QUARTILE',[.5,.25,.9]);
 return {version:ENGINE,training_count:positions.length,training_end:trainingEnd,dataset_sha256:createHash('sha256').update(bytes).digest('hex'),
  selection:'chronological pre-cutoff trades; held-out later incidents excluded; pooled bands with matched feature units; no PnL or symbol optimization',bands};
}
if(process.argv[1]?.endsWith('/calibrate.mjs')){
 const [input,end,output]=process.argv.slice(2);if(!output)throw Error('CALIBRATION_INPUT_END_AND_OUTPUT_REQUIRED');
 const profile=calibrate(fs.readFileSync(input),end);fs.writeFileSync(output,'/** Reproducible empirical bands. See ops/deterministic/calibrate.mjs. */\nexport const PROFILE=Object.freeze('+JSON.stringify(profile,null,2)+');\n');
 console.log(JSON.stringify({training_count:profile.training_count,drift:profile.bands.entry_drift,impact:profile.bands.roundtrip_impact_bps}));
}
