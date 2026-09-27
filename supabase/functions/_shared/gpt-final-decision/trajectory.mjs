/** Dynamics of ordered sampled buckets, never intrabar highs or fabricated flow. */
const ok=Number.isFinite,round=x=>ok(x)?Number(x.toPrecision(8)):null;
const sum=(a,k)=>a.every(x=>ok(x[k]))?a.reduce((v,x)=>v+x[k],0):null;
const slope=(a,k)=>a.length>1&&ok(a[0][k])&&ok(a.at(-1)[k])?(a.at(-1)[k]-a[0][k])/((a.at(-1).end_ms-a[0].end_ms)/1000):null;
/** All extrema are sampled boundaries, not invented intrabucket highs/lows. */
export function bucketDynamics(points){
 let peak=points[0]?.start_mid,low=peak,lowAt=points[0]?.start_ms;
 return points.map(p=>{
  const renewed=ok(peak)&&p.mid>peak;peak=Math.max(peak??p.mid,p.mid);
  if(!ok(low)||p.mid<=low){low=p.mid;lowAt=p.end_ms;}
  return {...p,bid:ok(p.spread_bps)?round(p.mid*(1-p.spread_bps/20000)):null,
   ask:ok(p.spread_bps)?round(p.mid*(1+p.spread_bps/20000)):null,quote_basis:'DERIVED_FROM_RECORDED_MID_AND_SPREAD',
   high_renewal:renewed,local_peak:peak,local_trough:low,
   recovery_velocity_bps_s:p.end_ms>lowAt?round((p.mid/low-1)*10000/((p.end_ms-lowAt)/1000)):0,
   drawdown_from_sampled_peak:peak>0?round(p.mid/peak-1):null};
 });
}
export function trajectoryDynamics(points){
 const horizons={};
 for(const seconds of [5,15,30,60,120]){
  const a=points.slice(-seconds/5),last=a.at(-1),first=a[0],elapsed=(last.end_ms-first.start_ms)/1000;
  const buy=sum(a,'aggressive_buy'),sell=sum(a,'aggressive_sell'),net=buy!==null&&sell!==null?buy-sell:null;
  const ret=first.start_mid>0?last.mid/first.start_mid-1:null;
  const returns=a.map(x=>x.d_mid_bps).filter(ok),mean=returns.length?returns.reduce((x,y)=>x+y,0)/returns.length:null;
  const sampled=[first.start_mid,...a.map(x=>x.mid)].filter(x=>ok(x)&&x>0),peak=Math.max(...sampled),low=Math.min(...sampled);
  const before=points[points.length-a.length-1];
  const boundary=(key,delta)=>ok(before?.[key])?before[key]:ok(first[delta])&&first[delta]>-1?first[key]/(1+first[delta]):null;
  const bidStart=boundary('bid_depth_25_usdt','d_bid_depth_25_pct'),askStart=boundary('ask_depth_25_usdt','d_ask_depth_25_pct');
  const firstSpeed=first.d_mid_bps/((first.end_ms-first.start_ms)/1000),lastSpeed=last.d_mid_bps/((last.end_ms-last.start_ms)/1000);
  const accel=a.length>1?(lastSpeed-firstSpeed)/((last.end_ms-first.end_ms)/1000):
    ok(before?.d_mid_bps)?(lastSpeed-before.d_mid_bps/((before.end_ms-before.start_ms)/1000))/elapsed:null;
  let lowAt=first.start_mid===low?first.start_ms:null;
  for(const point of a)if(point.mid===low)lowAt=point.end_ms;
  const recoverySeconds=lowAt===null?null:(last.end_ms-lowAt)/1000;
  let high=first.start_mid??first.mid,renewals=0,early=0,late=0;
  for(let i=0;i<a.length;i++){if(a[i].mid>high){high=a[i].mid;renewals++;if(i<a.length/2)early++;else late++;}}
  const firstHalf=a.slice(0,Math.floor(a.length/2)),lastHalf=a.slice(Math.floor(a.length/2));
  const fnet=sum(firstHalf,'net_taker_quote_5s'),lnet=sum(lastHalf,'net_taker_quote_5s');
  const row={actual_seconds:elapsed,return:ret,velocity_bps_s:ret===null?null:ret*10000/elapsed,
   aggressive_buy:buy,aggressive_sell:sell,net_taker_flow:net,buy_share:buy+sell>0&&buy!==null&&sell!==null?buy/(buy+sell):null,
   acceleration_bps_s2:ok(accel)?accel:null,
   buy_share_slope:a.length===1&&ok(last.d_buy_share)?last.d_buy_share/elapsed:slope(a,'buy_share_5s'),net_flow_slope:slope(a,'net_taker_quote_5s'),
   flow_acceleration:firstHalf.length&&fnet!==null&&lnet!==null?(lnet/lastHalf.length-fnet/firstHalf.length)/5:
     ok(last.d_net_taker_quote)?last.d_net_taker_quote/elapsed:null,
   spread:last.spread_bps,spread_slope:slope(a,'spread_bps'),bid_depth:last.bid_depth_25_usdt,ask_depth:last.ask_depth_25_usdt,
   imbalance:last.imbalance,bid_depth_slope:slope(a,'bid_depth_25_usdt'),ask_depth_slope:slope(a,'ask_depth_25_usdt'),
   bid_liquidity_change:bidStart>0?last.bid_depth_25_usdt/bidStart-1:null,
   ask_liquidity_change:askStart>0?last.ask_depth_25_usdt/askStart-1:null,
   imbalance_trend:slope(a.length===1&&before?[before,...a]:a,'imbalance'),
   arrival_rate_slope:slope(a.length===1&&before?[before,...a]:a,'arrival_rate'),
   buy_impact_450_bps:last.buy_impact_450_bps,sell_impact_450_bps:last.sell_impact_450_bps,
   realized_volatility_bps:returns.length===a.length?Math.sqrt(returns.reduce((v,x)=>v+(x-mean)**2,0)/returns.length):null,
   downside_impulse_bps:returns.length?Math.min(...returns):null,upside_impulse_bps:returns.length?Math.max(...returns):null,
   sampled_high_renewals:renewals,high_renewal_slowdown:early-late,drawdown_from_sampled_peak:last.mid/peak-1,
   recovery_from_sampled_low:last.mid/low-1,recovery_velocity_bps_s:recoverySeconds>0?(last.mid/low-1)*10000/recoverySeconds:0,
   trade_count:sum(a,'trade_count'),aggressive_notional:sum(a,'aggressive_notional')};
  horizons['s'+seconds]=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='number'?round(v):v]));
 }
 const speed=horizons.s5.velocity_bps_s,prior=points.at(-2)?.d_mid_bps;
 return {basis:'ORDERED_BUCKET_END_MIDS_NOT_INTRABAR_HIGHS',boundary_policy:'UNKNOWN_BOUNDARY_RETURNS_NULL',
   ...Object.fromEntries([5,15,30,60,120].map(s=>['return_'+s+'s',horizons['s'+s].return])),
   velocity:speed,acceleration:speed!==null&&ok(prior)?round((speed-prior/5)/5):null,horizons};
}
/** Deterministic changes trigger a review only. They NEVER submit an exit. */
export function dynamicsEvent(c,prior,protect=false){
 if(c?.status!=='AVAILABLE'||!c.dynamics)return {event:null,evidenceKey:null,observation:prior??null};
 const d=c.dynamics,short=d.horizons.s15,older=d.horizons.s60,last=c.trajectory.at(-1);
 const observation={at:c.end_ms,acceleration:d.acceleration,net:short.net_taker_flow,bid:short.bid_depth,spread:short.spread};
 if(!prior)return {event:null,evidenceKey:null,observation};
 const k=protect?.5:1;let event=null;
 if(prior.acceleration>0&&d.acceleration<0)event='MOMENTUM_ACCELERATION_FLIP';
 else if(prior.net>=0&&short.net_taker_flow<0&&short.flow_acceleration<0)event='SELL_FLOW_ACCELERATION';
 else if(prior.bid>0&&short.bid_depth/prior.bid<1-.30*k)event='BID_DEPTH_COLLAPSE';
 else if(prior.spread>0&&short.spread/prior.spread>1+.75*k)event='SPREAD_BLOWOUT';
 else if(older.return<0&&short.return>0&&short.bid_depth_slope>0&&last.d_buy_share>0)event='DIP_BID_RECOVERY';
 return {event,evidenceKey:event?event+':'+Math.floor(c.end_ms/15000):null,observation};
}
