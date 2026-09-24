import {readFileSync} from "node:fs";
import {stats,portfolio} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows.json'));
const NOW=Date.parse("2026-09-24T00:20:00Z");
const W={h12:12,h24:24,h48:48,d7:168,d16:400};
const med=a=>{a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?+a[Math.floor(a.length/2)].toFixed(4):null};
const T=(rs,k)=>rs.map(r=>({...r[k],symbol:r.symbol})).filter(t=>t.status==='CLOSED');
for(const [w,h] of Object.entries(W)){
  const R=rows.filter(r=>r.s5c>=NOW-h*3600e3);
  const by=k=>R.filter(r=>r.simSetup===k);
  const trig=by('TRIGGERED'),chase=by('CHASE_EXPIRED'),exp=R.filter(r=>/EXPIRED_NO/.test(r.simSetup));
  const bOK=trig.filter(r=>r.b?.allowed),bNO=trig.filter(r=>r.b&&!r.b.allowed);
  console.log(`\n=== ${w}: signals ${R.length} symbols ${new Set(R.map(r=>r.symbol)).size}`);
  console.log(' setup: TRIGGERED',trig.length,'CHASE',chase.length,'EXPIRED',exp.length);
  console.log(' CHASE  immediate-entry',JSON.stringify(stats(T(chase,'immediate'))),'| max60 med',med(chase.map(r=>r.fwd.max60)),'ret60 med',med(chase.map(r=>r.fwd.ret60)),'ret240 med',med(chase.map(r=>r.fwd.ret240)));
  console.log(' EXPIRE immediate-entry',JSON.stringify(stats(T(exp,'immediate'))),'| ret60 med',med(exp.map(r=>r.fwd.ret60)));
  console.log(' TRIG all   ',JSON.stringify(stats(T(trig,'trig'))));
  console.log(' B06133 PASS',JSON.stringify(stats(T(bOK,'trig'))),' 44bp',JSON.stringify(stats(T(bOK,'trig44'))));
  console.log(' B06133 REJ ',JSON.stringify(stats(T(bNO,'trig'))),' 44bp',JSON.stringify(stats(T(bNO,'trig44'))));
  console.log(' ALL immediate(old V17)',JSON.stringify(stats(T(R,'immediate'))));
  // portfolio (cap4 / cap10) de-duplicated
  for(const cap of [4,10]){
    console.log(` PF cap${cap}: trig-all`,JSON.stringify(stats(portfolio(T(trig,'trig'),cap))),' b06133',JSON.stringify(stats(portfolio(T(bOK,'trig'),cap))),' immediate-all',JSON.stringify(stats(portfolio(T(R,'immediate'),cap))));
  }
}
