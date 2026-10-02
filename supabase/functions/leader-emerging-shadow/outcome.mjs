/** LE-SHADOW-1 precise outcome labels (hypothetical, 600 USDT notional). Pure.
 * Forward returns and MFE/MAE from 1m klines that start at the entry minute; exit simulation is
 * the production P142 replay kernel (retestAnchor) averaged over its three intrabar paths.
 * Costs: REAL = fees 5+5 bps + measured entry slippage beyond the ask + 5 bps exit;
 * STRESS = 44 bps round trip (CEC0040 basis). */
import {replayP142Target,P142_MODES} from '../_shared/leader-cec0040.mjs';
import {COSTS} from './features.mjs';
export const OUTCOME_VERSION='LE_OUTCOME_1';
export const HORIZONS=Object.freeze([5,15,30,60,120,240]);
export const KLINE_LIMIT=241;
const MIN=60_000;

export function maturityAt(entryAt){return Math.floor(entryAt/MIN)*MIN+KLINE_LIMIT*MIN+30_000;}

function rows(raw){
  return (Array.isArray(raw)?raw:[]).map(r=>({t:Number(r[0]),o:Number(r[1]),h:Number(r[2]),l:Number(r[3]),c:Number(r[4]),end:Number(r[6]),raw:r}))
    .filter(b=>Number.isSafeInteger(b.t)&&b.t%MIN===0&&b.c>0).sort((a,b)=>a.t-b.t);
}

/**
 * @param entry {at (ms), price (ask), beyondAskBps (measured, 600), beyondAskBps450}
 * @param raw   Binance 1m rows from floor(entry.at) (limit 241)
 */
export function labelOutcome(entry,raw){
  const bs=rows(raw),t0=Math.floor(entry.at/MIN)*MIN,p0=Number(entry.price);
  let contiguous=bs.length>0&&bs[0].t===t0;for(let i=1;i<bs.length&&contiguous;i++)if(bs[i].t-bs[i-1].t!==MIN)contiguous=false;
  const complete=contiguous&&bs.length>=KLINE_LIMIT;
  const at=(m)=>{const target=t0+m*MIN;const b=bs.find(x=>x.t===target-MIN);return b&&b.end<entry.at+m*MIN+MIN?b.c/p0-1:null;};
  const fwd=Object.fromEntries(HORIZONS.map(h=>['hyp_fwd_'+h+'m',at(h)]));
  const after=m=>bs.filter(b=>b.t>=Math.ceil(entry.at/MIN)*MIN&&b.t<entry.at+m*MIN);
  const ext=m=>{const xs=after(m);return xs.length?{mfe:Math.max(...xs.map(b=>b.h))/p0-1,mae:Math.min(...xs.map(b=>b.l))/p0-1}:{mfe:null,mae:null};};
  const e60=ext(60),e240=ext(240);
  const beyond=Number.isFinite(entry.beyondAskBps)?entry.beyondAskBps:null;
  const beyond450=Number.isFinite(entry.beyondAskBps450)?entry.beyondAskBps450:null;
  const realCost=beyond===null?null:COSTS.feeEntryBps+COSTS.feeExitBps+beyond+COSTS.exitSlipBps;
  const realCost450=beyond450===null?null:COSTS.feeEntryBps+COSTS.feeExitBps+beyond450+COSTS.exitSlipBps;
  const net=(f,c)=>f===null||c===null?null:f*1e4-c;
  // P142 exit simulation on the same bars (entry price already includes the beyond-ask slippage)
  let sim=null;
  if(contiguous&&bs.length>=2){
    const run=(price,costs)=>P142_MODES.map(mode=>{
      let o;try{o=replayP142Target({at:entry.at,price},bs.map(b=>b.raw),{style:'retestAnchor',mode,costs});}catch(e){return {mode,status:'SIM_ERROR',reason:String(e?.message??e).slice(0,40),exitAt:null,netBps:null,grossBps:null,holdMin:null};}
      if(o.status==='CLOSED')return {mode,status:'CLOSED',reason:o.reason,exitAt:o.exitAt,netBps:o.netBeforeFunding/COSTS.notionalUsdt*1e4,
        grossBps:o.grossPnl/COSTS.notionalUsdt*1e4,holdMin:o.holdMs/MIN};
      if(o.status==='OPEN_CENSORED'){ // mark at the last price seen (4 h window), exit costs applied
        const exitPrice=o.lastPrice*(1-costs.exitSlip),q=o.quantity,gross=(exitPrice-price)*q,fees=COSTS.notionalUsdt*costs.entryFee+exitPrice*q*costs.exitFee;
        return {mode,status:'CENSORED_240M',reason:'CENSORED_240M',exitAt:o.lastTime,netBps:(gross-fees)/COSTS.notionalUsdt*1e4,grossBps:gross/COSTS.notionalUsdt*1e4,holdMin:(o.lastTime-entry.at)/MIN};}
      return {mode,status:o.status,reason:o.status,exitAt:null,netBps:null,grossBps:null,holdMin:null};
    });
    const realPrice=beyond===null?null:p0*(1+beyond/1e4);
    const real=realPrice===null?null:run(realPrice,{entryFee:COSTS.feeEntryBps/1e4,exitFee:COSTS.feeExitBps/1e4,exitSlip:COSTS.exitSlipBps/1e4});
    const stress=run(p0*(1+.001),{entryFee:.0007,exitFee:.0007,exitSlip:.002});
    const mean=(xs,k)=>xs&&xs.every(x=>Number.isFinite(x[k]))?xs.reduce((s,x)=>s+x[k],0)/xs.length:null;
    sim={real,stress,real_net_bps:mean(real,'netBps'),stress_net_bps:mean(stress,'netBps'),gross_bps:mean(real??stress,'grossBps'),
      hold_min:mean(real??stress,'holdMin'),exit_reason:(real??stress).map(x=>x.reason).join('|')};
  }
  return {outcome_version:OUTCOME_VERSION,...fwd,
    hyp_mfe_60:e60.mfe,hyp_mae_60:e60.mae,hyp_mfe_240:e240.mfe,hyp_mae_240:e240.mae,
    hyp_net_bps_real_60m:net(fwd.hyp_fwd_60m,realCost),hyp_net_bps_real_120m:net(fwd.hyp_fwd_120m,realCost),
    hyp_net_bps_stress44_60m:net(fwd.hyp_fwd_60m,COSTS.stressBps),hyp_net_bps_stress44_120m:net(fwd.hyp_fwd_120m,COSTS.stressBps),
    hyp_sim_exit_reason:sim?.exit_reason??null,hyp_sim_hold_min:sim?.hold_min??null,hyp_sim_gross_bps:sim?.gross_bps??null,
    hyp_sim_net_bps_real:sim?.real_net_bps??null,hyp_sim_net_bps_stress44:sim?.stress_net_bps??null,
    hyp_net_usdt_600:sim?.real_net_bps==null?null:sim.real_net_bps/1e4*COSTS.notionalUsdt,
    hyp_cost_bps_real:realCost,hyp_cost_bps_real_450:realCost450,
    cost:{fee_bps:COSTS.feeEntryBps+COSTS.feeExitBps,entry_slippage_beyond_ask_bps_600:beyond,entry_slippage_beyond_ask_bps_450:beyond450,
      exit_slippage_bps:COSTS.exitSlipBps,stress_bps:COSTS.stressBps,notional_usdt:COSTS.notionalUsdt},
    sim,data_complete:complete};
}
