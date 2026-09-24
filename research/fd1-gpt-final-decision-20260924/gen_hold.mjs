import {readFileSync,writeFileSync} from 'node:fs';
import {CEC} from './lib.mjs';
import {runTrade} from './holdsim.mjs';
const rows=JSON.parse(readFileSync('data/rows3.json'));const EC=JSON.parse(readFileSync('data/entry_compact.json'));
const kOf=new Map(EC.map(x=>['E:'+x[0]+':'+x[1],x.slice(2)]));
const T=rows.filter(r=>r.v17.K5r6.path==='PULLBACK'&&r.v17.K5r6.t);
const style=r=>{const b=r.v17.K5r6.b;return b.allowed&&b.branch?CEC.p142StyleForBranch(b.branch):'retestAnchor';};
const out=[],seen=new Set();let n=0;
for(const r of T){const at=r.v17.K5r6.triggerAt,ek='E:'+r.symbol+':'+at,k=kOf.get(ek);if(!k)continue;
  for(const mode of CEC.P142_MODES){const x=runTrade({symbol:r.symbol,at,style:style(r),mode,answer:()=> 'HOLD'});if(!x)continue;
    for(const v of x.reviews){const id=ek+'@'+v.at;if(seen.has(id))continue;seen.add(id);
      out.push([r.symbol,at,v.at,+x.entryPrice.toPrecision(8),+v.peak.toPrecision(8),v.lastHighAt,+v.stop.toPrecision(8),v.stage,v.event]);}}n++;}
writeFileSync('/home/user/Trading-booooo/research/fd1-gpt-final-decision-20260924/jobs/hold_16d.json',JSON.stringify(out));
const c={};for(const o of out){const e=o[8].split(':')[0];c[e]=(c[e]||0)+1;}console.log(n,'trades',out.length,'reviews',c);
