import {readFileSync,writeFileSync} from 'node:fs';
import {SIGNALS,CEC} from './lib.mjs';
import {modelJudgments} from '/home/user/Trading-booooo/supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {v30FrontDecision,V30_FRONT_LIVE_VERSION} from '/home/user/Trading-booooo/supabase/functions/_shared/gpt-final-review/contract.mjs';
const rows=JSON.parse(readFileSync('data/rows3.json'));const byId=new Map(SIGNALS.map(s=>[s.id,s]));
const T=rows.filter(r=>r.v17.K5r6.path==='PULLBACK'&&r.v17.K5r6.t).sort((a,b)=>a.v17.K5r6.triggerAt-b.v17.K5r6.triggerAt);
// strategy-wide causal CEC state: fold every earlier triggered candidate's 44bp target once it has closed
let e=.995,n=116,run=0;const pend=[];const jobs=[];
for(const r of T){const o=r.v17.K5r6,at=o.triggerAt;
  pend.sort((a,b)=>a.exitAt-b.exitAt);while(pend.length&&pend[0].exitAt<=at){const x=pend.shift();const s=CEC.cec0040Fold({ewmaUsdt:e,trainingCount:n},x.net);e=s.ewmaUsdt;n=s.trainingCount;}
  const d=CEC.cec0040Decision({ewmaUsdt:e,trainingCount:n,rejectRun:run});run=d.rejectRunAfter;
  if(o.t44)pend.push({exitAt:o.t44.exitAt,net:o.t44.net});
  const s=byId.get(r.id),f=s.f,b={version:'B06133_ENTRY_SELECTION_1',allowed:o.b.allowed,result:o.b.allowed,branch:o.b.branch,reason:o.b.allowed?'B06133_ALLOW':'B06133_REJECT',factors:o.b.factors};
  const features={...f,rank:r.rank??f.rank,dayReturn:r.dayReturn??f.dayReturn,v17Setup:{state:'TRIGGERED',triggerAt:at},b06133:b,v30Front:v30FrontDecision(b,V30_FRONT_LIVE_VERSION),
    cec0040:{action:d.action,effectiveAllowed:d.allowed,ready:true,predictionUsdt:d.prediction}};
  jobs.push({id:'E:'+r.id,run_tag:'fd1-entry-16d',task:'ENTRY',symbol:r.symbol,as_of_ms:at+2000,
    context:{referenceClose:r.ref,dayReturn:features.dayReturn,rank:features.rank,judgments:modelJudgments(features)},
    meta:{cec:d.action,v30:features.v30Front.admitted,b:o.b.allowed}});
}
writeFileSync('data/entry_jobs.json',JSON.stringify(jobs));
console.log(jobs.length,JSON.stringify(jobs[0]).length,jobs.filter(j=>j.meta.cec!=='REJECT').length,'cec admit/probe');
console.log(JSON.stringify(jobs[500].context).slice(0,900));
