import {readFileSync,writeFileSync} from "node:fs";
import {SIGNALS,trade,stats,portfolio,range,COSTS_REAL,COSTS_44,MIN,b06133At,CEC} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows.json'));const byId=new Map(SIGNALS.map(s=>[s.id,s]));
const NOW=Date.parse("2026-09-24T00:20:00Z");
// causal continuation entry: first completed 1m bar in [s5c, s5c+15m) with close>ref*1.01 -> enter next minute open
for(const r of rows){const s=byId.get(r.id);const {out}=range(r.symbol,r.s5c,r.s5c+15*MIN);
  const b=out.find(x=>x[4]>r.ref*1.01);
  if(b){r.chaseAt=b[0]+MIN;r.chase=trade(s,r.chaseAt,{costs:COSTS_REAL});r.chase44=trade(s,r.chaseAt,{costs:COSTS_44});}
}
writeFileSync('data/rows2.json',JSON.stringify(rows));
const T=(rs,k)=>rs.filter(r=>r[k]?.status==='CLOSED').map(r=>({...r[k],symbol:r.symbol,r}));
for(const [w,h] of [['h24',24],['h48',48],['d7',168],['d16',400]]){
  const R=rows.filter(r=>r.s5c>=NOW-h*3600e3);
  const chaseRows=R.filter(r=>r.simSetup==='CHASE_EXPIRED');
  console.log(`\n== ${w}`);
  console.log(' continuation entry on CHASE rows (causal, at breach):',JSON.stringify(stats(T(chaseRows,'chase'))),'44bp',JSON.stringify(stats(T(chaseRows,'chase44'))));
  // combined: first of pullback-trigger or breach
  const comb=R.map(r=>{const a=r.trig?.status==='CLOSED'?r.trig:null,b=r.chase?.status==='CLOSED'?r.chase:null;return a&&b?(a.entryAt<=b.entryAt?a:b):(a||b);}).map((t,i)=>t&&({...t,symbol:R[i].symbol})).filter(Boolean);
  console.log(' pullback OR continuation',JSON.stringify(stats(comb)),' PF4',JSON.stringify(stats(portfolio(comb,4))),' PF10',JSON.stringify(stats(portfolio(comb,10))));
  console.log(' current pullback only PF4',JSON.stringify(stats(portfolio(T(R,'trig'),4))),' immediate PF4',JSON.stringify(stats(portfolio(T(R,'immediate'),4))));
  // strength buckets for immediate entry
  for(const [lab,fn] of [['day<8%',r=>r.dayReturn<.08],['day8-20%',r=>r.dayReturn>=.08&&r.dayReturn<.2],['day>=20%',r=>r.dayReturn>=.2],['r60>=5%',r=>r.r60>=.05],['vr>=3',r=>r.vr>=3]]){
    const X=R.filter(fn);console.log(`  [${lab}] n=${X.length} immediate`,JSON.stringify(stats(T(X,'immediate'))),' trig',JSON.stringify(stats(T(X,'trig'))),' chase',JSON.stringify(stats(T(X,'chase'))));
  }
}
