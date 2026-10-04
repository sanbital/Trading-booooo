import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shortSqueezeSignal } from "./squeeze.mjs";

function capture({withOi=true}={}) {
  const start=Date.parse("2026-10-04T09:00:00.000Z");
  const trajectory=Array.from({length:24},(_,i)=>({
    bucket_ms:start+i*5000,
    funding_rate:i<21?0.00010:-0.00030,
    basis_bps:-4,
    open_interest:withOi?1_000_000*(1+i*0.0001):null,
    open_interest_at_ms:withOi?start+Math.floor(i/6)*30_000:null,
  }));
  if(withOi){
    for(let i=0;i<trajectory.length;i++)trajectory[i].open_interest=1_000_000*(1+Math.floor(i/6)*0.002);
  }
  return {trajectory,dynamics:{horizons:{s15:{return:0.004,net_taker_flow:3000},s30:{return:0.007}}}};
}
const values={
  return_15m:0.03,return_60m:0.08,ema9_vs_ema20:0.02,
  macd_hist_1m:0.004,macd_hist_delta_1m:0.0005,obv_delta_5m:150000,
  volume_ratio_5m_vs_60m:2,last_body:0.01,close_location_value:0.8,last_upper_wick:0.002,last_lower_wick:0.003,
  failed_breakout_candle:false,sell_volume_expansion:false,volume_climax_decline:false,
};

Deno.test("negative funding shock + rising trend + OI context confirms squeeze review",()=>{
  const out=shortSqueezeSignal({values,capture:capture(),profile:{bands:{volume:{normal:1.2}}}});
  assertEquals(out.watch,true);
  assertEquals(out.confirmed,true);
  assertEquals(out.reason,"SHORT_SQUEEZE_CONFIRMED");
  assertEquals(out.oi_mode,"BUILD");
});

Deno.test("funding shock alone never confirms an entry",()=>{
  const out=shortSqueezeSignal({values,capture:capture({withOi:false}),profile:{bands:{volume:{normal:1.2}}}});
  assertEquals(out.watch,true);
  assertEquals(out.confirmed,false);
  assertEquals(out.confirmations.oi_support,false);
});
