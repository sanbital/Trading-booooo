import {SIGNALS,simulateSetup,b06133At,trade,forward,MIN,COSTS_REAL,COSTS_44,CEC} from "./lib.mjs";
import {writeFileSync} from "node:fs";
const out=[];
for(const s of SIGNALS){
  const f=s.f,s5c=Number(f.signal5Close),ref=Number(f.referenceClose);
  const sim=simulateSetup(s);const st=sim.state;
  const r={id:s.id,symbol:s.symbol,s5c,ref,status:s.status,reason:(s.reason||s.status).split(':')[0],dayReturn:f.dayReturn,r15:f.return15m,r30:f.return30m,r60:f.return60m,vr:f.volumeRatio,rank:f.rank,
    prodSetup:s.setup?.state??null,simSetup:st?.state??null,triggerAt:st?.triggerAt??null,prodB:s.b?.reason??null,prodCec:s.cec?.action??null,prodCecReason:s.cec?.reason??null,pos:s.pos};
  r.fwd=forward(s,s5c,ref);
  r.immediate=trade(s,s5c,{costs:COSTS_REAL});
  r.immediate44=trade(s,s5c,{costs:COSTS_44});
  if(st?.state==='TRIGGERED'){
    const b=b06133At(s,st.triggerAt);r.b={allowed:b.allowed,branch:b.branch,result:b.result,factors:b.factors,reason:b.reason};
    const style=b.branch?CEC.p142StyleForBranch(b.branch):'retestAnchor';
    r.trig=trade(s,st.triggerAt,{style,costs:COSTS_REAL});r.trig44=trade(s,st.triggerAt,{style,costs:COSTS_44});
    r.trigFwd=forward(s,st.triggerAt,ref);
  }
  out.push(r);
}
writeFileSync('data/rows.json',JSON.stringify(out));
console.log(out.length, out.filter(r=>r.trig?.status==='CLOSED').length, out.filter(r=>r.immediate?.status==='CLOSED').length);
