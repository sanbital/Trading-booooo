import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {CANDIDATES,nextCandidate} from './exit-candidates.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const base=path.resolve(here,'../../..');
const R=JSON.parse(fs.readFileSync(path.join(base,'analysis/trades.json'))),K=JSON.parse(fs.readFileSync(path.join(base,'evidence/candles_1m.json')));
const meta=JSON.parse(fs.readFileSync(path.join(base,'evidence/provenance.json'))),asof=Date.parse(meta.asof);
export function replay(r,bars,config,{slippage=.001,observe='OPEN',boundary='ADVERSE'}={}){
  let state={entryPrice:r.entry_price,entryAt:r.entry_ms,entryFee:r.fees?r.entry_notional*.0005:0,quantity:r.quantity,peakPrice:r.entry_price,lastHighAt:r.entry_ms,stopPrice:r.entry_price*.975};
  // Source fees used for entry; exit taker commission assumption is 5bp in every model.
  state.entryFee=r.entry_notional*.0005;
  let exit=null,reason=null,stage='INITIAL_HARD',censored=false;
  const entrybar=Math.floor(r.entry_ms/60000)*60000;
  const future=bars.filter(b=>Number(b[0])>=entrybar&&Number(b[6])<asof);
  for(const b of future){
    const [t,open,high,low,close]=b.slice(0,5).map(Number);
    if(t<r.entry_ms){
      // Unknown pre-entry part of this bar: publish both adverse and skipped bounds.
      if(boundary==='ADVERSE'&&low<=state.stopPrice){exit=Math.min(state.stopPrice,r.entry_price)*(1-slippage);reason='INITIAL_BAR_BOUND';exit={price:exit,time:r.entry_ms+1};break;}
      continue;
    }
    const history=bars.filter(x=>Number(x[6])<t);
    const last=history.at(-1),at=(n)=>history.at(-1-n);
    const feats={closedAt:t,atrPct:Number(r.features.atr)/r.entry_price};
    if(history.length>=26){
      feats.return1m=Number(last[4])/Number(at(1)[4])-1;feats.return5m=Number(last[4])/Number(at(5)[4])-1;feats.return15m=Number(last[4])/Number(at(15)[4])-1;
      const v5=history.slice(-5).reduce((a,x)=>a+Number(x[7]),0),prior=history.slice(-25,-5).reduce((a,x)=>a+Number(x[7]),0)/4;feats.volumeRatio=prior>0?v5/prior:0;
    }
    // Previous candle high is known only now. Never raise a stop using this bar's future high.
    if(observe==='COMPLETED_HIGH'&&last&&Number(last[0])>=r.entry_ms&&Number(last[2])>state.peakPrice){state={...state,peakPrice:Number(last[2]),lastHighAt:t};}
    const decision=nextCandidate(state,open,t,config,feats);
    state={...state,peakPrice:decision.peakPrice,lastHighAt:decision.lastHighAt,stopPrice:decision.stopPrice};stage=decision.protectionStage??stage;
    if(decision.action==='CLOSE'){exit={price:open*(1-slippage),time:t};reason=decision.reason;break;}
    if(low<=state.stopPrice){exit={price:Math.min(open,state.stopPrice)*(1-slippage),time:t+60000};reason='NATIVE_'+stage;break;}
  }
  if(!exit){const last=future.at(-1);exit={price:last?Number(last[4]):r.entry_price,time:last?Number(last[6]):r.entry_ms};reason='RIGHT_CENSORED';censored=true;}
  const gross=(exit.price-r.entry_price)*r.quantity,fees=state.entryFee+exit.price*r.quantity*.0005,net=gross-fees;
  const ambiguous=reason.startsWith('NATIVE_')||reason==='INITIAL_BAR_BOUND';
  const lowEnd=ambiguous?exit.time-60000:exit.time;
  const full=bars.filter(b=>Number(b[0])>=r.entry_ms&&Number(b[6])<lowEnd);
  const overlap=bars.filter(b=>Number(b[6])>=r.entry_ms&&Number(b[0])<=exit.time);
  const mfeLow=Math.max(0,Math.max(r.entry_price,exit.price,...full.map(b=>Number(b[2])))/r.entry_price-1);
  const mfeHigh=Math.max(mfeLow,Math.max(r.entry_price,...overlap.map(b=>Number(b[2])))/r.entry_price-1);
  return {id:r.id,symbol:r.symbol,cohort:r.cohort,policy:r.policy,price:exit.price,exit_ms:exit.time,net,gross,fees,censored,reason,holding_min:(exit.time-r.entry_ms)/60000,actual_net:r.net,entry_notional:r.entry_notional,mfe:r.mfe,mfeLow,mfeHigh};
}
function stats(rs){const x=rs.filter(r=>!r.censored),wins=x.filter(r=>r.net>0),losses=x.filter(r=>r.net<0);let eq=0,peak=0,mdd=0;for(const r of [...x].sort((a,b)=>a.exit_ms-b.exit_ms)){eq+=r.net;peak=Math.max(peak,eq);mdd=Math.max(mdd,peak-eq);}return {n:x.length,censored:rs.length-x.length,net:x.reduce((a,r)=>a+r.net,0),pf:losses.length?wins.reduce((a,r)=>a+r.net,0)/-losses.reduce((a,r)=>a+r.net,0):null,wins:wins.length,avg_win:wins.length?wins.reduce((a,r)=>a+r.net,0)/wins.length:null,avg_loss:losses.length?losses.reduce((a,r)=>a+r.net,0)/losses.length:null,max_loss:Math.min(...x.map(r=>r.net)),max_drawdown:mdd,winners_preserved:x.filter(r=>r.actual_net>0&&r.net>0).length,actual_winners:x.filter(r=>r.actual_net>0).length};}
const outputs={},summary=[];
// Freeze eligibility using available horizon, independently of a candidate's exit time.
const eligible=R.filter(r=>r.entry_ms+6*3600000+60000<=asof);
for(const observe of ['OPEN','COMPLETED_HIGH'])for(const [name,config] of Object.entries(CANDIDATES)){
  const key=name+'__'+observe;outputs[key]=eligible.map(r=>replay(r,K[r.id],config,{observe}));
  for(const cohort of ['PRE','POST','ALL']){const rs=outputs[key].filter(r=>cohort==='ALL'||r.cohort===cohort);summary.push({candidate:name,observe,cohort,...stats(rs)});}
}
const sensitivity=[];
for(const stop of [.015,.0175,.02,.0225,.025]){
 const config={kind:'R5',stopPct:stop,riskCutLevelPct:Math.min(.012,stop-.001)};
 for(const cohort of ['PRE','POST'])sensitivity.push({axis:'hard_stop',value:stop,cohort,...stats(eligible.filter(r=>r.cohort===cohort).map(r=>replay(r,K[r.id],config)))});
}
for(const arm of [.0125,.015,.0175,.02])for(const cohort of ['PRE','POST'])sensitivity.push({axis:'be_arm',value:arm,cohort,...stats(eligible.filter(r=>r.cohort===cohort).map(r=>replay(r,K[r.id],{...CANDIDATES.C_COMBINED,beArm:arm})))});
const stress=[];
for(const slippage of [.0005,.001,.002,.003])for(const boundary of ['ADVERSE','SKIP'])for(const name of ['V17_R5','A_LADDER','B_TREND','C_COMBINED'])stress.push({candidate:name,slippage,boundary,cohort:'POST',...stats(eligible.filter(r=>r.cohort==='POST').map(r=>replay(r,K[r.id],CANDIDATES[name],{slippage,boundary})))});
const rolling=[];const post=eligible.filter(r=>r.cohort==='POST');
for(let i=0;i<post.length;i+=7)for(const name of ['V17_R5','A_LADDER','B_TREND','C_COMBINED'])rolling.push({candidate:name,window:`POST_${i+1}_${Math.min(post.length,i+7)}`,...stats(post.slice(i,i+7).map(r=>replay(r,K[r.id],CANDIDATES[name])))});
const results={method:{horizon:'6h plus one minute',entry_boundary:'ADVERSE with SKIP sensitivity',slippage:.001,entryFee:.0005,exitFee:.0005,funding:'not modeled',candidate_selection:'none; fixed hypotheses',full_eligible:eligible.length,eligible_post:post.length,excluded:R.filter(r=>!eligible.includes(r)).map(r=>({symbol:r.symbol,entry:r.entry_time}))},summary,outputs,sensitivity,stress,rolling};
fs.writeFileSync(path.join(base,'analysis/replay.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({method:results.method,post:summary.filter(x=>x.cohort==='POST'),pre:summary.filter(x=>x.cohort==='PRE'&&x.observe==='OPEN'),rolling},null,2));
