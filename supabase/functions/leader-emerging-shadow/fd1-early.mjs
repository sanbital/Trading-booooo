/** Order-free 1/2/3/5 minute structural failure observations on live FD1 positions.
 * Only complete Binance 1m bars; never submits orders or changes production state. */
import {getJson,createGuard} from './guard.mjs';
export const EARLY_VERSION='LE_FD1_EARLY_OBSERVATION_1';
const MIN=60_000;
const N=x=>Number(x);
const windows=[1,2,3,5];
const readOpen=`select p.id::text as position_id,p.signal_id::text as signal_id,p.symbol,p.entry_at,p.entry_price,p.peak_price
  from public.v11_long_regime_positions p
  where p.state='OPEN' and p.side='LONG'
    and p.entry_at between now()-interval '9 minutes' and now()-interval '60 seconds'
  order by p.entry_at limit 10`;
const existing=`select window_min from shadow_le.fd1_early_snapshots where position_id=$1::uuid`;
const save=`insert into shadow_le.fd1_early_snapshots(position_id,signal_id,symbol,entry_at,window_min,observed_at,
  last_bar_close_at,entry_price,current_price,mfe_lower_bound,mae_lower_bound,current_return,taker_buy_share_2bars,
  completed_bars,structural_signals,shadow_label,version)
  values ($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::int,$6::timestamptz,
    $7::timestamptz,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13::numeric,
    $14::int,$15::jsonb,$16::text,$17::text)
  on conflict(position_id,window_min,version) do nothing returning position_id`;
export const EARLY_SQL=Object.freeze({readOpen,existing,save});

/** First full bar opens AFTER entry's partial minute. A current partial bar is never used. */
export function evaluateEarly(position,raw,now,windowMin){
  const entryMs=Date.parse(position.entry_at),entry=N(position.entry_price);
  if(!Number.isFinite(entryMs)||!Number.isFinite(entry)||entry<=0)return null;
  const first=Math.ceil((entryMs+1)/MIN)*MIN;
  const complete=(Array.isArray(raw)?raw:[]).filter(b=>Array.isArray(b)&&N(b[0])>=first&&N(b[6])<now)
    .sort((a,b)=>N(a[0])-N(b[0]));
  const eligible=complete.filter(b=>N(b[6])>=entryMs+windowMin*MIN);
  if(!eligible.length||!complete.length)return null;
  // This function runs promptly after the checkpoint; do not use bars after its first completed bar.
  const endpoint=eligible[0],bars=complete.filter(b=>N(b[0])<=N(endpoint[0]));
  if(!bars.length||bars.some((b,i)=>i>0&&N(b[0])-N(bars[i-1][0])!==MIN))return null;
  const current=N(endpoint[4]),high=Math.max(...bars.map(b=>N(b[2]))),low=Math.min(...bars.map(b=>N(b[3])));
  if(![current,high,low].every(Number.isFinite))return null;
  const recent=bars.slice(-2),q=recent.reduce((s,b)=>s+N(b[7]),0),buy=recent.reduce((s,b)=>s+N(b[10]),0);
  const share=q>0?buy/q:null,mfe=high/entry-1,mae=low/entry-1,ret=current/entry-1;
  const falling=recent.length===2&&recent.every(b=>N(b[4])<N(b[1]));
  const weakFlow=share!==null&&share<.45;
  const signals={no_peak_01:mfe<.001,negative_ret:ret<0,loss_gt_25bp:ret<-.0025,
    taker_weak_2bars:weakFlow,two_falling_complete_bars:falling,
    entry_minute_peak_unobserved:true,window_is_observation_not_time_exit:true};
  let label='OBSERVE';
  if(windowMin===5&&mfe<.001&&ret<0)label='E1_5M_HYPOTHESIS';
  if(windowMin===5&&mfe<.005&&ret<-.0025&&weakFlow)label='E2_5M_HYPOTHESIS';
  if(windowMin<=3&&mfe<.001&&ret<-.005&&weakFlow&&falling)label='EARLY_COMPOUND_HYPOTHESIS';
  return {windowMin,observedAt:new Date(now).toISOString(),barCloseAt:new Date(N(endpoint[6])).toISOString(),
    entry,current,mfe,mae,ret,share,bars:bars.length,signals,label};
}

export async function runFd1Early({db,store2=null,guard=null,now=Date.now}){
  const t=now(),out={ok:true,mode:'fd1early',version:EARLY_VERSION,positions:0,recorded:0,errors:[],orders:0,gpt_calls:0};
  if(store2?.haltedTodayV2&&await store2.haltedTodayV2()){out.status='HALTED_TODAY';return out;}
  const scan=store2?.prodScanLatest?await store2.prodScanLatest():null;
  if(scan&&t-Date.parse(scan.captured_at)<=10*MIN&&/WEIGHT|HTTP_429|HTTP_418|HTTP_451|RATE_LIMIT/i.test(JSON.stringify([scan.blocked??null,scan.errors??null]))){
    out.status='SHADOW_YIELD_PRODUCTION_WEIGHT';return out;}
  const g=createGuard({fetchFn:guard?.fetch??fetch,cycleWeightCap:20,abortAt:1000});
  const positions=await db.query(readOpen,[]);
  for(const p of positions){
    out.positions++;
    try{
      const age=(t-Date.parse(p.entry_at))/MIN;
      const done=new Set((await db.query(existing,[p.position_id])).map(x=>N(x.window_min)));
      const due=windows.filter(w=>!done.has(w)&&age>=w&&age<w+2);
      if(!due.length)continue;
      const raw=await getJson(g,'/fapi/v1/klines',{symbol:p.symbol,interval:'1m',startTime:Math.floor(Date.parse(p.entry_at)/MIN)*MIN,limit:10});
      for(const w of due){
        const e=evaluateEarly(p,raw,t,w);if(!e)continue;
        const result=await db.query(save,[p.position_id,p.signal_id,p.symbol,p.entry_at,w,e.observedAt,e.barCloseAt,
          e.entry,e.current,e.mfe,e.mae,e.ret,e.share,e.bars,JSON.stringify(e.signals),e.label,EARLY_VERSION]);
        if(result.length)out.recorded++;
      }
    }catch(e){out.errors.push({symbol:p.symbol,code:String(e?.code??e?.message??'ERROR').slice(0,80)});
      if(g.state?.dayHalt||g.state?.abort)break;}
  }
  return out;
}
