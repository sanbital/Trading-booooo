// Synthetic data for unit/integration tests. Never historical replay evidence.
import {validateCapture120,CAPTURE_VERSION} from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import {DYNAMIC_VERSION,HORIZONS} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
export function rawCapture(at){
 const end=Math.floor((at-200)/5000)*5000+100;
 const trajectory=Array.from({length:24},(_,i)=>{
  const e=end-(23-i)*5000,mid=1.2*(1+.0001*(i+1));
  return {bucket_ms:e-100,start_ms:e-5000,end_ms:e,received_at_ms:e+50,exchange_event_ms:e-200,
   book_received_at_ms:e-100,flow_event_ms:e-150,flow_received_at_ms:e-100,mid,start_mid:1.2*(1+.0001*i),
   d_mid_bps:1,d_spread_bps:0,d_ask_depth_25_pct:0,d_bid_depth_25_pct:0,buy_share_5s:.6,d_buy_share:0,
   aggressive_buy:600,aggressive_sell:400,net_taker_quote_5s:200,d_net_taker_quote:0,ask_book_net_5s:0,bid_book_net_5s:0,
   buy_impact_450_bps:2,d_buy_impact_bps:0,sell_impact_450_bps:2,d_sell_impact_bps:0,trade_count:10,
   arrival_rate:2,aggressive_notional:1000,spread_bps:2,bid_depth_25_usdt:100000,ask_depth_25_usdt:100000,imbalance:0};
 });
 return {version:CAPTURE_VERSION,status:'AVAILABLE',start_ms:end-120000,end_ms:end,ingested_at_ms:end+50,buckets:24,trajectory};
}
export const validCapture=at=>validateCapture120(rawCapture(at),at);
export function dynamicWire(w,input){
 if(input.dynamic_policy!==DYNAMIC_VERSION)return w;
 const common={structural_strength:'Established trend',current_propulsion:'Current flow supports continuation',
  propulsion_direction:'STABLE',dynamic_evidence:['dynamics.horizons.s30.net_taker_flow'],dynamic_risks:[],confidence:.9};
 if(w.t==='HOLD')return {...w,...common,uncertainty:'Observed evidence only',dynamic_action:w.d==='EXIT'?'EXIT_THESIS_BROKEN':w.d==='PROTECT'?'HOLD_AND_RAISE_PROTECTION':'HOLD'};
 return {...w,...common,why_buy_now:{summary:'Continuing demand with stable liquidity',
  horizons:Object.fromEntries(HORIZONS.map(s=>['s'+s,{summary:'Direction assessed',evidence:['dynamics.horizons.s'+s+'.return']}])),
  flow:['dynamics.horizons.s30.net_taker_flow'],orderbook:['dynamics.horizons.s30.bid_liquidity_change']},
  why_not_wait:'Evidence supports continuation',...(w.t==='RECHECK'?{invalidation:'Loss of flow support'}:{}),
  dual_confidence_degraded:input.independent_reviews?.deepseek?.valid!==true};
}
export function dynamicMarketFixture(inner){
 const previous=globalThis.Deno?.env?.get;
 globalThis.Deno={...(globalThis.Deno??{}),env:{get:k=>k==='SUPABASE_URL'?'https://capture.test':k==='SUPABASE_SERVICE_ROLE_KEY'?'synthetic-unit-key':previous?.(k)}};
 return async(url,init)=>{
  if(String(url).startsWith('https://capture.test/rest/v1/rpc/doa_'))return Response.json(rawCapture(Date.parse(JSON.parse(init.body).p_as_of)));
  const r=await inner(url,init);
  if(new URL(url).hostname!=='api.openai.com'||!r.ok)return r;
  const body=JSON.parse(init.body),input=JSON.parse(body.input[1].content);
  if(!body.text?.format?.schema?.properties?.propulsion_direction)return r;
  const raw=await r.json();
  for(const m of raw.output??[])for(const c of m.content??[])if(c.type==='output_text')c.text=JSON.stringify(dynamicWire(JSON.parse(c.text),{...input,dynamic_policy:DYNAMIC_VERSION}));
  return Response.json(raw,{status:r.status,headers:r.headers});
 };
}
