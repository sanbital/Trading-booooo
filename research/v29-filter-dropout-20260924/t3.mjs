import {readFileSync} from "node:fs";
import {stats,portfolio,CEC} from "./lib.mjs";
const rows=JSON.parse(readFileSync('data/rows3.json'));
const NOW=Date.parse("2026-09-24T00:20:00Z"),MID=Date.parse('2026-09-17T00:00Z');
function cec(c,seed={ewma:.995,n:116}){let e=seed.ewma,n=seed.n,run=0;const pend=[],kept=[];
  for(const x of [...c].sort((a,b)=>a.entryAt-b.entryAt)){pend.sort((a,b)=>a.exitAt-b.exitAt);
    while(pend.length&&pend[0].exitAt<=x.entryAt){const t=pend.shift();const s=CEC.cec0040Fold({ewmaUsdt:e,trainingCount:n},t.t44);e=s.ewmaUsdt;n=s.trainingCount;}
    const d=CEC.cec0040Decision({ewmaUsdt:e,trainingCount:n,rejectRun:run});run=d.rejectRunAfter;
    if(d.allowed){kept.push(x);pend.push({exitAt:x.exitAt44,t44:x.t44});}}return kept;}
// candidate from a V17 variant: path source (PB only = production pullback, or with BASE)
const cand=(r,v,gate)=>{const o=v==='PB'?(r.v17.K5r6.path==='PULLBACK'?r.v17.K5r6:null):r.v17[v];
  if(!o?.path||!o.t||!o.t44)return null;const f=o.b.factors;if(!gate(o,f))return null;
  return {net:o.t.net,t44:o.t44.net,exitAt:o.t.exitAt,exitAt44:o.t44.exitAt,entryAt:o.t.entryAt,symbol:r.symbol,path:o.path};};
const G={
 B06133_hard:(o,f)=>o.b.allowed===true,
 none:()=>true,
 fresh:(o,f)=>f.fresh5over15===true,
 fresh_notTails:(o,f)=>f.fresh5over15===true&&f.volumeTails===false,
};
const arms=[];
for(const v of ['PB','K5r6','K8r10'])for(const g of Object.keys(G))for(const c of [true,false])arms.push({name:`${v}+${g}${c?'+CEC':''}`,v,g,c});
const W=[['12h',r=>r.s5c>=NOW-12*3600e3],['24h',r=>r.s5c>=NOW-24*3600e3],['48h',r=>r.s5c>=NOW-48*3600e3],['7d',r=>r.s5c>=NOW-168*3600e3],['16d',r=>1],['dev(9/8-16)',r=>r.s5c<MID],['hold(9/17-24)',r=>r.s5c>=MID]];
const cap=Number(process.argv[2]||4);
const fmt=s=>s.n?`${s.net.toFixed(0)}/${s.n}/${s.win}/${s.pf??'-'}/${s.mdd.toFixed(0)}`:'0/0';
console.log(`cap ${cap}. cell = net/n/win/PF/MDD  (real cost) ; [44bp net]`);
console.log('arm'.padEnd(30),W.map(w=>w[0].padEnd(24)).join(''));
for(const a of arms){if(a.v!=='PB'&&a.g==='B06133_hard'&&!a.c)continue;
  const cells=W.map(([,wf])=>{const R=rows.filter(wf);let t=R.map(r=>cand(r,a.v,G[a.g])).filter(Boolean);if(a.c)t=cec(t);const p=portfolio(t,cap);
    return (fmt(stats(p))+' ['+stats(p.map(x=>({...x,net:x.t44}))).net?.toFixed?.(0)+']').padEnd(24);});
  console.log(a.name.padEnd(30),cells.join(''));}
