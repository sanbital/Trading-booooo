import {scoreAlternativeEntry} from './alternative-score.mjs';

function ok(x,msg){if(!x)throw Error(msg)}
const base={facts:{values:{
 signal_rank:2,day_return:.12,relative_strength_15m:.03,relative_strength_60m:.07,
 return_5m:.01,return_15m:.025,return_60m:.06,distance_sma20:.02,distance_high_60m:-.005,accel_5m_vs_15m:.004,
 taker_buy_ratio_5m:.58,taker_buy_ratio_15m:.56,buyer_share_change:.04,volume_ratio_5m_vs_60m:1.6,oi_change_5m:.01,
 spread_bps:4,ask_depth_to_order:8,bid_depth_to_order:6,book_imbalance_25bps:.2,est_buy_slippage_bps:4
}},model_judgments:{b06133:{allowed:false,factors:{volumeTails:true}},cec0040:{action:'REJECT'}}};
const a=scoreAlternativeEntry(base);
ok(a.hardReject===false,'score must never reject');
ok(a.composite>0&&a.composite<=100,'composite range');
ok(a.axes.execution!==null,'live micro should score');
ok(a.legacy.volumeTails===true,'volumeTails evidence preserved');
const replay=structuredClone(base);
for(const k of ['spread_bps','ask_depth_to_order','bid_depth_to_order','book_imbalance_25bps','est_buy_slippage_bps']) replay.facts.values[k]=null;
const b=scoreAlternativeEntry(replay);
ok(b.axes.execution===null,'replay must not invent microstructure');
ok(b.composite>0,'replay still ranks on known evidence');
console.log(JSON.stringify({ok:true,a,b}));
