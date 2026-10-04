import test from "node:test";
import assert from "node:assert/strict";
import { shortSqueezeSignal } from "../supabase/functions/_shared/deterministic/squeeze.mjs";
import { technicalFacts } from "../supabase/functions/_shared/deterministic/technical.mjs";

function capture({ withOi = true } = {}) {
  const start=Date.parse("2026-10-04T09:00:00.000Z");
  const trajectory=Array.from({length:24},(_,i)=>({
    bucket_ms:start+i*5000,
    funding_rate:i<21?0.00010:-0.00030,
    basis_bps:-4,
    open_interest:withOi?1_000_000*(1+Math.floor(i/6)*0.002):null,
    open_interest_at_ms:withOi?start+Math.floor(i/6)*30_000:null,
  }));
  return {trajectory,dynamics:{horizons:{s15:{return:0.004,net_taker_flow:3000},s30:{return:0.007}}}};
}
const values={
  return_15m:0.03,return_60m:0.08,ema9_vs_ema20:0.02,
  macd_hist_1m:0.004,macd_hist_delta_1m:0.0005,obv_delta_5m:150000,
  volume_ratio_5m_vs_60m:2,last_body:0.01,close_location_value:0.8,last_upper_wick:0.002,last_lower_wick:0.003,
  failed_breakout_candle:false,sell_volume_expansion:false,volume_climax_decline:false,
};
test("funding shock is review-only until OI and independent confirmations agree",()=>{
  const withoutOi=shortSqueezeSignal({values,capture:capture({withOi:false}),profile:{bands:{volume:{normal:1.2}}}});
  assert.equal(withoutOi.watch,true);assert.equal(withoutOi.confirmed,false);
  const withOi=shortSqueezeSignal({values,capture:capture(),profile:{bands:{volume:{normal:1.2}}}});
  assert.equal(withOi.watch,true);assert.equal(withOi.confirmed,true);assert.equal(withOi.oi_mode,"BUILD");
});
test("completed-candle technicals expose finite MACD and OBV confirmations",()=>{
  const mk=(n,ms)=>Array.from({length:n},(_,i)=>{
    const c=100+i*0.2+(i%5===0?0.1:0),o=c-0.1,h=c+0.2,l=o-0.2;
    return {t:i*ms,end:(i+1)*ms-1,o,h,l,c,q:1000+i*10,buy:550+i};
  });
  const out=technicalFacts(mk(80,60_000),mk(30,300_000)).values;
  assert.ok(Number.isFinite(out.macd_hist_1m));
  assert.ok(Number.isFinite(out.macd_hist_delta_1m));
  assert.ok(Number.isFinite(out.obv_delta_5m));
});
