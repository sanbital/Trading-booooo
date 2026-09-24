// FD1 hold/exit simulation helpers (causal: every decision uses only completed bars).
import {range,CEC,COSTS_REAL} from './lib.mjs';
import {replayC} from './kernelC.mjs';
export const MIN=60000,HORIZON_MS=24*3600e3,TIME_HOLD_TTL_MS=15*MIN,MIN_GAP_MS=5*MIN,MAX_REVIEWS=30;
export const DETERIORATION_DD=-0.015,PRICE_MOVE=0.02;
/** Event policy shared by query generation and final simulation (identical sequence). */
export function eventPolicy(){
  const st={lastReviewAt:-Infinity,lastReviewPrice:null,ddArmed:true,holdUntil:-Infinity,reviews:0,lastPeak:null};
  return {
    time(ctx,answer){ // returns true => close now
      if(ctx.at<st.holdUntil)return false;
      if(st.reviews>=MAX_REVIEWS)return true; // review cap reached -> deterministic behavior
      st.reviews++;st.lastReviewAt=ctx.at;st.lastReviewPrice=ctx.price;
      const a=answer(ctx,'TIME_EXIT_CANDIDATE:'+ctx.reason);
      if(a==='HOLD'){st.holdUntil=ctx.at+TIME_HOLD_TTL_MS;return false;}
      return true; // EXIT, ABSTAIN, invalid, missing -> deterministic time exit
    },
    event(ctx,answer){ // returns true => GPT EXIT
      if(st.lastReviewPrice===null)st.lastReviewPrice=ctx.price0;
      if(st.lastPeak===null||ctx.peak>st.lastPeak){st.lastPeak=ctx.peak;st.ddArmed=true;}
      if(ctx.at-st.lastReviewAt<MIN_GAP_MS||st.reviews>=MAX_REVIEWS)return false;
      let ev=null;
      if(st.ddArmed&&ctx.price/ctx.peak-1<=DETERIORATION_DD){ev='MOMENTUM_DETERIORATION';st.ddArmed=false;}
      else if(Math.abs(ctx.price/st.lastReviewPrice-1)>=PRICE_MOVE)ev='SIGNIFICANT_PRICE_CHANGE';
      if(!ev)return false;
      st.reviews++;st.lastReviewAt=ctx.at;st.lastReviewPrice=ctx.price;
      return answer(ctx,ev)==='EXIT';
    }};
}
export function barsFor(sym,at){const {out,gapAt}=range(sym,at,at+HORIZON_MS+5*MIN);return {bars:out.map(b=>b.slice(0,5)),gapAt};}
/** Run one trade under a mode with an answer function; returns kernel outcome + reviews. */
export function runTrade({symbol,at,style='retestAnchor',mode='CLOSE_ONLY',costs=COSTS_REAL,answer,timeExits=true}){
  const {bars}=barsFor(symbol,at);if(!bars.length||bars[0][0]!==at)return null;
  const price=bars[0][1]*(1+costs.entrySlip),pol=eventPolicy(),reviews=[];
  const ans=(ctx,ev)=>{const a=answer?answer(ctx,ev):'HOLD';reviews.push({at:ctx.at,event:ev,price:ctx.price,peak:ctx.peak,lastHighAt:ctx.lastHighAt,stop:ctx.stop,stage:ctx.stage,answer:a});return a;};
  const hooks={timeGate:ctx=>timeExits?pol.time(ctx,ans):false,event:ctx=>pol.event(ctx,ans)};
  const r=replayC({at,price},bars,{style,mode,costs,hooks});
  return {...r,reviews,entryPrice:price,dataEnd:bars.at(-1)[0]+MIN};
}
