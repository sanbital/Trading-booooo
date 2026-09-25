/** Order-free HOLD input ablation. Never import position outcomes into model input. */
import {sharedReview,callCounter,MODEL_CANDIDATES} from './parallel.mjs';
import {hash} from './api.mjs';
export const TEMPORAL_VERSION='DS_HOLD_TEMPORAL_1';
export const HISTORY_KEYS=Object.freeze(['return_1m','return_5m','return_15m','taker_buy_ratio_5m',
  'buyer_share_change','relative_strength_15m','volume_ratio_5m_vs_60m',
  'position_return','position_peak_return','position_drawdown_from_peak','position_stop_distance']);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function check(row){
  if(row?.packet?.task!=='HOLD'||!row.group_key||!Number.isSafeInteger(row.as_of_ms))throw Error('TEMPORAL_IDENTITY');
  const end=row.packet.facts?.quality?.last_close_at_ms;
  if(!Number.isSafeInteger(end)||end>=row.as_of_ms)throw Error('TEMPORAL_FUTURE_CANDLE');
}
export async function temporalInputs(row,previous=[]){
  check(row);
  const shared=await sharedReview(row.packet,{snapshotAtMs:row.as_of_ms});
  const seen=new Set();
  const history=previous.filter(p=>p.group_key===row.group_key&&p.packet?.symbol===row.packet.symbol&&
    Number.isSafeInteger(p.as_of_ms)&&p.as_of_ms<row.as_of_ms&&p.as_of_ms>=row.as_of_ms-3600000)
    .sort((a,b)=>a.as_of_ms-b.as_of_ms).filter(p=>{if(seen.has(p.as_of_ms))return false;seen.add(p.as_of_ms);return true;}).slice(-3)
    .map(p=>{check(p);return {as_of_ms:p.as_of_ms,age_ms:row.as_of_ms-p.as_of_ms,
      facts:Object.fromEntries(HISTORY_KEYS.map(k=>[k,finite(p.packet.facts.values[k])?p.packet.facts.values[k]:null]))};});
  const v=row.packet.facts.values,last=history.at(-1);
  const changes=Object.fromEntries(HISTORY_KEYS.map(k=>[k,last&&finite(last.facts[k])&&finite(v[k])?v[k]-last.facts[k]:null]));
  const temporal={version:TEMPORAL_VERSION,as_of_ms:row.as_of_ms,history,change_from_latest:changes,
    instructions:'History is irregularly sampled factual data, not prior advice. Compare failure versus normal pullback and remaining upside. Evidence strings must name available current fact keys. Missing history is not deterioration.',
    quality:{history_count:history.length,peak_below_current:finite(v.position_peak_return)&&finite(v.position_return)&&v.position_peak_return<v.position_return}};
  const market_input=JSON.parse(JSON.stringify({...shared.market_input,temporal}));
  const enriched={...shared,market_input,snapshot_hash:await hash({base:shared.snapshot_hash,market_input})};
  for(const input of [shared,enriched])if(new TextEncoder().encode(JSON.stringify(input.market_input)).length>40000)throw Error('TEMPORAL_INPUT_SIZE');
  return {A:shared,B:enriched,history_count:history.length};
}
export async function compareTemporal(row,previous,options={}){
  const inputs=await temporalInputs(row,previous),invoke=options.call??callCounter;
  const cfg={...MODEL_CANDIDATES[0],apiKey:options.apiKey,timeoutMs:8000};
  const results=await Promise.allSettled(['A','B'].map(arm=>invoke(inputs[arm],cfg)));
  return {version:TEMPORAL_VERSION,authority:[],history_count:inputs.history_count,
    inputs:{A:inputs.A.market_input,B:inputs.B.market_input},
    arms:Object.fromEntries(results.map((r,i)=>[['A','B'][i],r.status==='fulfilled'?r.value:{valid:false,error:'PROVIDER_ERROR'}]))};
}
