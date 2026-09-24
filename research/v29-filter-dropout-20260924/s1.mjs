import {SIGNALS,simulateSetup,b06133At,PB} from "./lib.mjs";
const CUT=Date.parse("2026-09-17T00:00:00Z");
const rows=SIGNALS.filter(s=>Number(s.f.signal5Close)>=CUT && s.setup);
const conf={};let bagree=0,bn=0;const bmis=[];
for(const s of rows){
  const sim=simulateSetup(s);
  const k=`${s.setup.state}|${sim.state?.state}`;conf[k]=(conf[k]||0)+1;
  if(s.b&&s.b.version&&sim.state?.state==='TRIGGERED'&&sim.state.triggerAt===s.setup.triggerAt){
    const b=b06133At(s,sim.state.triggerAt);bn++;if(b.allowed===s.b.allowed)bagree++;else bmis.push([s.symbol,s.b.reason,b.reason]);
  }
}
console.log(rows.length);console.log(Object.entries(conf).sort((a,b)=>b[1]-a[1]));
console.log('b06133 agree',bagree,'/',bn,bmis.slice(0,10));
