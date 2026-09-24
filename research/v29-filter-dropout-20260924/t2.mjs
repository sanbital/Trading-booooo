// Combined V17 setup: production pullback path + a pre-registered BASE_BREAKOUT path
// (sideways base near the reference, then a bullish close above the base high).
import {readFileSync,writeFileSync} from "node:fs";
import {SIGNALS,PB,range,kline,MIN,b06133At,trade,COSTS_REAL,COSTS_44,CEC} from "./lib.mjs";
const P=PB.SETUP_POLICY;
export function combined(sig,{K=5,maxRange=.006,base=true}={}){
  const f=sig.f,armAt=Number(f.signal5Close),ref=Number(f.referenceClose);
  let st=PB.startPullbackSetup({id:sig.id,symbol:sig.symbol,features:f},armAt,P).state;
  const {out}=range(sig.symbol,armAt-MIN,armAt+P.setupTtlMs+2*MIN);const seen=[];
  for(let i=0;i<out.length;i++){const b=out[i];if(b[0]<armAt)continue;const now=b[0]+MIN;
    if(now>st.expiresAt)return {path:null,end:'EXPIRED'};
    const r=PB.advancePullbackSetup(st,kline(b[0],b.slice(1)),i>0?kline(out[i-1][0],out[i-1].slice(1)):null,now,P);st=r.state;
    if(st.state==='TRIGGERED')return {path:'PULLBACK',triggerAt:st.triggerAt,close:b[4]};
    if(PB.isTerminal(st))return {path:null,end:st.state};
    // BASE_BREAKOUT: only while no pullback was seen (otherwise the pullback path owns it)
    if(base&&!st.pullbackObserved&&seen.length>=K){
      const w=seen.slice(-K),hi=Math.max(...w.map(x=>x[2])),lo=Math.min(...w.map(x=>x[3]));
      if((hi-lo)/ref<=maxRange&&b[4]>b[1]&&b[4]>hi&&b[4]>=ref*(1+P.minReaccelPct)&&b[4]<=ref*(1+P.maxChasePct))
        return {path:'BASE',triggerAt:b[0]+MIN,close:b[4]};
    }
    seen.push(b);
  }
  return {path:null,end:'EXPIRED'};
}
const byId=new Map(SIGNALS.map(s=>[s.id,s]));
const rows=JSON.parse(readFileSync('data/rows2.json'));
const variants={K5r6:{K:5,maxRange:.006},K8r6:{K:8,maxRange:.006},K5r10:{K:5,maxRange:.010},K8r10:{K:8,maxRange:.010}};
for(const r of rows){const s=byId.get(r.id);r.v17={};
  for(const [name,opt] of Object.entries(variants)){const c=combined(s,opt);const o={path:c.path,triggerAt:c.triggerAt??null};
    if(c.path){const b=b06133At(s,c.triggerAt);o.b={allowed:b.allowed,branch:b.branch,factors:b.factors};
      const style=b.branch?CEC.p142StyleForBranch(b.branch):'retestAnchor';
      const t=trade(s,c.triggerAt,{style,costs:COSTS_REAL}),t44=trade(s,c.triggerAt,{style,costs:COSTS_44}),tr=trade(s,c.triggerAt,{style:'retestAnchor',costs:COSTS_REAL});
      o.t=t?.status==='CLOSED'?{net:t.net,exitAt:t.exitAt,entryAt:t.entryAt}:null;o.t44=t44?.status==='CLOSED'?{net:t44.net,exitAt:t44.exitAt}:null;o.tr=tr?.status==='CLOSED'?{net:tr.net}:null;}
    r.v17[name]=o;}
}
writeFileSync('data/rows3.json',JSON.stringify(rows));
const c={};for(const r of rows){const k=r.v17.K5r6.path||'none';c[k]=(c[k]||0)+1;}console.log(c);
