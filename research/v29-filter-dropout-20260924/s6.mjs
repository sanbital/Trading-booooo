import {readFileSync} from "node:fs";
import {stats,portfolio,CEC} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows2.json'));
const NOW=Date.parse("2026-09-24T00:20:00Z");
const v25=r=>r.dayReturn<.08&&r.vr>=1.3;
// Causal CEC over a chronological candidate list; targets fold after exitAt (44bp target).
function cec(cands,seed={ewma:1.0,n:116}){
  let ewma=seed.ewma,n=seed.n,run=0;const pend=[],kept=[];
  for(const c of [...cands].sort((a,b)=>a.entryAt-b.entryAt)){
    pend.sort((a,b)=>a.exitAt-b.exitAt);
    while(pend.length&&pend[0].exitAt<=c.entryAt){const t=pend.shift();const s=CEC.cec0040Fold({ewmaUsdt:ewma,trainingCount:n},t.t44);ewma=s.ewmaUsdt;n=s.trainingCount;}
    const d=CEC.cec0040Decision({ewmaUsdt:ewma,trainingCount:n,rejectRun:run});run=d.rejectRunAfter;
    if(d.allowed){kept.push({...c,cecAction:d.action});pend.push({exitAt:c.t44exit,t44:c.t44});}
  }
  return kept;
}
const mk=(r,k)=>r[k]?.status==='CLOSED'?{...r[k],symbol:r.symbol,t44:r[k+'44']?.net??r[k].net,t44exit:r[k+'44']?.exitAt??r[k].exitAt,row:r}:null;
const arms={
 'A0 immediate, no gates':R=>R.map(r=>mk(r,'immediate')),
 'A1 pullback only (V17 timing)':R=>R.filter(r=>r.trig).map(r=>mk(r,'trig')),
 'A2 pullback+B06133':R=>R.filter(r=>r.b?.allowed).map(r=>mk(r,'trig')),
 'A3 pullback+B06133+CEC (CURRENT)':R=>cec(R.filter(r=>r.b?.allowed).map(r=>mk(r,'trig')).filter(Boolean)),
 'A4 pullback+CEC (drop B06133)':R=>cec(R.filter(r=>r.trig).map(r=>mk(r,'trig')).filter(Boolean)),
 'A5 immediate+B06133@s5c? n/a':null,
 'A6 pullback+v25gate':R=>R.filter(r=>r.trig&&v25(r)).map(r=>mk(r,'trig')),
 'A7 pullback+v25gate+CEC':R=>cec(R.filter(r=>r.trig&&v25(r)).map(r=>mk(r,'trig')).filter(Boolean)),
 'A8 pullback+v25+B06133':R=>R.filter(r=>r.b?.allowed&&v25(r)).map(r=>mk(r,'trig')),
 'A9 immediate+v25gate':R=>R.filter(v25).map(r=>mk(r,'immediate')),
};
for(const [w,h] of [['h12',12],['h24',24],['h48',48],['d7',168],['d16',400]]){
  const R=rows.filter(r=>r.s5c>=NOW-h*3600e3);console.log(`\n== ${w}`);
  for(const [name,fn] of Object.entries(arms)){if(!fn)continue;const t=fn(R).filter(Boolean);const p=portfolio(t,4);
    console.log(name.padEnd(36),'PF4',JSON.stringify(stats(p)),' 44bp',JSON.stringify(stats(p.map(x=>({...x,net:x.t44})))));}
}
