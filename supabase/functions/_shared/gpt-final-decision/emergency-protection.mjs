import {entryCaptureSafety} from './dynamic-flow.mjs';
export const EMERGENCY_VERSION='THESIS_TECHNICAL_PROTECTION_1';
// Calibrated on recorded winners/losers (ops/hold-protection): a full 120s sampled
// bid floor preserved both winners where 15/30/60s floors cut them early. No new % stop.
export function emergencyProtection({capture,now,bid,peak,hardFloor,standing=0,technicalFailure}){
 if(!technicalFailure||!entryCaptureSafety(capture,now).ok||![bid,peak,hardFloor,standing].every(Number.isFinite)||bid<=0||peak<bid||hardFloor<=0)return null;
 const h=capture.dynamics.horizons,a=h.s15,b=h.s30,d=h.s60;
 const keys=[[a,'return'],[b,'return'],[b,'net_taker_flow'],[d,'net_taker_flow'],[b,'bid_liquidity_change'],[b,'imbalance']];
 if(keys.some(([x,k])=>!Number.isFinite(x?.[k])))return null;
 // Only simultaneous PRICE + FLOW + BOOK failure protects. Recovery or renewed
 // price strength fails these signs. One red bucket, missing data or cost alone cannot.
 if(!(a.return<0&&b.return<0&&b.net_taker_flow<0&&d.net_taker_flow<0&&b.bid_liquidity_change<0&&b.imbalance<0&&bid<peak))return null;
 const bids=capture.trajectory.map(x=>x.mid*(1-x.spread_bps/20000));
 if(bids.some(x=>!Number.isFinite(x)||x<=0))return null;
 const floor=Math.min(...bids),level=Math.max(standing,hardFloor,floor);
 if(level<=hardFloor)return null;
 return {version:EMERGENCY_VERSION,action:bid<=level?'EMERGENCY_EXIT_THESIS_FAILURE':'HOLD_WITH_TIGHTER_RISK',level,
  axes:['PRICE','FLOW','BOOK',...(b.sampled_high_renewals===0&&a.arrival_rate_slope<0?['PARTICIPATION']:[])],
  no_new_high:b.sampled_high_renewals===0,recovery_velocity:a.recovery_velocity_bps_s,
  accelerating:a.acceleration_bps_s2<0,source:'RECORDED_120S_BID_LOW',capture_end_ms:capture.end_ms};
}
