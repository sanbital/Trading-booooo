// A/B/C comparison on the same 1,119 V17 pullback triggers, same entry price rule, same costs.
import {readFileSync,existsSync} from 'node:fs';
import {stats,portfolio,CEC,COSTS_REAL,COSTS_44} from './lib.mjs';
import {runTrade} from './holdsim.mjs';
const rows=JSON.parse(readFileSync('data/rows3.json'));
const T=rows.filter(r=>r.v17.K5r6.path==='PULLBACK'&&r.v17.K5r6.t).sort((a,b)=>a.v17.K5r6.triggerAt-b.v17.K5r6.triggerAt);
const E=JSON.parse(readFileSync('data/entry_results.json')); // {key:{d,valid,err,lat,cost}}
const H=existsSync('data/hold_results.json')?JSON.parse(readFileSync('data/hold_results.json')):{}; // {tradeKey@at:{d,valid}}
const keyOf=r=>'E:'+r.symbol+':'+r.v17.K5r6.triggerAt;
const NOW=Date.parse('2026-09-24T00:20:00Z');
const style=r=>{const b=r.v17.K5r6.b;return b.allowed&&b.branch?CEC.p142StyleForBranch(b.branch):'retestAnchor';};
const cache=new Map();
function outcome(r,costs,exitMode){ // average of the 3 intrabar modes
  const k=keyOf(r)+'|'+(costs===COSTS_44?44:0)+'|'+exitMode;if(cache.has(k))return cache.get(k);
  const at=r.v17.K5r6.triggerAt,tk=keyOf(r);
  const ans=exitMode==='GPT'?(ctx,ev)=>{const a=H[tk+'@'+ctx.at];return a?.valid?a.d:'ABSTAIN';}:()=> 'ABSTAIN';
  const xs=CEC.P142_MODES.map(mode=>runTrade({symbol:r.symbol,at,style:style(r),mode,costs,answer:ans}));
  if(xs.some(x=>!x||x.status!=='CLOSED')){cache.set(k,null);return null;}
  const o={net:xs.reduce((s,x)=>s+x.netBeforeFunding,0)/3,exitAt:Math.max(...xs.map(x=>x.exitAt)),reasons:xs.map(x=>x.reason),
    reviews:xs[2].reviews.length,mfe:xs[0].mfe};cache.set(k,o);return o;
}
function cecFilter(c){let e=.995,n=116,run=0;const pend=[],kept=[];
  for(const x of [...c].sort((a,b)=>a.entryAt-b.entryAt)){pend.sort((a,b)=>a.exitAt44-b.exitAt44);
    while(pend.length&&pend[0].exitAt44<=x.entryAt){const t=pend.shift();const s=CEC.cec0040Fold({ewmaUsdt:e,trainingCount:n},t.t44);e=s.ewmaUsdt;n=s.trainingCount;}
    const d=CEC.cec0040Decision({ewmaUsdt:e,trainingCount:n,rejectRun:run});run=d.rejectRunAfter;
    if(d.allowed){kept.push(x);pend.push(x);}}return kept;}
const f=r=>r.v17.K5r6.b.factors,v30=r=>f(r).fresh5over15===true&&f(r).volumeTails===false,gpt=r=>E[keyOf(r)]?.d==='BUY'&&E[keyOf(r)]?.valid;
export const ARMS={
 'A  prev prod: B06133+CEC, det exit':{sel:r=>r.v17.K5r6.b.allowed,cec:true,exit:'DET'},
 'B0 V30+CEC(hard), det exit':{sel:v30,cec:true,exit:'DET'},
 'B1 V30 (CEC advisory), det exit':{sel:v30,cec:false,exit:'DET'},
 'X  all triggers, det exit':{sel:()=>true,cec:false,exit:'DET'},
 'C  GPT BUY on all triggers, GPT hold':{sel:gpt,cec:false,exit:'GPT'},
 'C1 GPT BUY, det exit':{sel:gpt,cec:false,exit:'DET'},
 'C2 GPT BUY + V30 gate, GPT hold':{sel:r=>gpt(r)&&v30(r),cec:false,exit:'GPT'},
 'C3 GPT BUY + CEC gate, GPT hold':{sel:gpt,cec:true,exit:'GPT'},
 'C4 GPT BUY + V30 + CEC, GPT hold':{sel:r=>gpt(r)&&v30(r),cec:true,exit:'GPT'},
};
export function trades(arm,wf){
  const R=T.filter(wf);let c=[];
  for(const r of R){if(!arm.sel(r))continue;const o=outcome(r,COSTS_REAL,arm.exit),o44=outcome(r,COSTS_44,arm.exit);if(!o||!o44)continue;
    c.push({symbol:r.symbol,entryAt:r.v17.K5r6.triggerAt,net:o.net,exitAt:o.exitAt,t44:o44.net,exitAt44:o44.exitAt,reasons:o.reasons,reviews:o.reviews});}
  if(arm.cec)c=cecFilter(c);return c;
}
export const W=[['24h',r=>r.s5c>=NOW-24*3600e3],['48h',r=>r.s5c>=NOW-48*3600e3],['7d',r=>r.s5c>=NOW-168*3600e3],['16d',r=>true],
  ['9/8-16',r=>r.s5c<Date.parse('2026-09-17T00:00Z')],['9/17-24',r=>r.s5c>=Date.parse('2026-09-17T00:00Z')]];
if(process.argv[1].endsWith('c_eval.mjs')){
  for(const cap of [1,4,10]){
    console.log(`\n=== cap ${cap} slots | cell = net USDT / n / win / PF / MDD  [44bp net]`);
    console.log('arm'.padEnd(40),W.map(w=>w[0].padEnd(28)).join(''));
    for(const [name,arm] of Object.entries(ARMS)){
      const cells=W.map(([,wf])=>{const p=portfolio(trades(arm,wf),cap),s=stats(p),s44=stats(p.map(x=>({...x,net:x.t44})));
        return (s.n?`${s.net.toFixed(0)}/${s.n}/${s.win}/${s.pf??'-'}/${s.mdd.toFixed(0)} [${s44.net.toFixed(0)}]`:'0/0').padEnd(28);});
      console.log(name.padEnd(40),cells.join(''));
    }
  }
}
