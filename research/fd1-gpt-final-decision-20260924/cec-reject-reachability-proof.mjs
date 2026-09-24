// ORDER-FREE proof on a REAL stored production signal (CYSUSDT, CEC0040 REJECT, continuation),
// using the exact deployed source (bundle parity: main 3d07bad). The DB row is not modified:
// its historical status REJECTED (old rule) is replaced by NEW only in this in-memory copy.
import {readFileSync} from 'node:fs';
const R='/home/user/Trading-booooo/supabase/functions/';
const {baselineAllowedLive}=await import(R+'_shared/gpt-final-review/contract.mjs');
const {entryExecutionWindow}=await import(R+'v10-lane-executor/entry-evidence.mjs');
const {SETUP_POLICY}=await import(R+'_shared/leader-pullback-reaccel.mjs');
const {FinalReviewCoordinator,MemoryReviewStore}=await import(R+'_shared/gpt-final-review/coordinator.mjs');
const {FD1_ENTRY_ENGINE,fd1EntryIdentity}=await import(R+'_shared/gpt-final-decision/engine.mjs');
const rows=JSON.parse(readFileSync(new URL('./data/cec_reject_rows.json',import.meta.url)));
for(const row of rows){
  const s={...structuredClone(row),status:'NEW'},f=s.features,trig=Number(f.v17Setup.triggerAt);
  const win=entryExecutionWindow(s,true,120000,SETUP_POLICY);
  const out={symbol:s.symbol,storedStatus:row.status,storedReason:row.reject_reason,cec:{action:f.cec0040.action,effectiveAllowed:f.cec0040.effectiveAllowed,modelAllowed:f.cec0040.modelAllowed,prediction:f.cec0040.predictionUsdt},
    v30:f.v30Front.admitted,triggerMode:f.v17Setup.triggerMode,policy:SETUP_POLICY.version,executionWindow:win,gptBaseline:baselineAllowedLive(s),
    judgmentsShownToGpt:fd1EntryIdentity(s).judgments.cec0040};
  for(const answer of ['BUY','SKIP','ABSTAIN']){
    let apiCalls=0;
    const fetchFn=async(url,init)=>{const u=new URL(url);
      if(u.hostname==='api.openai.com'){apiCalls++;const i=JSON.parse(JSON.parse(init.body).input[1].content);
        const w=answer==='BUY'?{d:'BUY',reasons:[],support:['return_5m','taker_buy_ratio_5m'],n:'상승'}:{d:answer,reasons:[],support:[],n:'보류'};
        return new Response(JSON.stringify({model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:0}},
          output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({t:'ENTRY',c:i.candidate_id,...w})}]}]}),{status:200,headers:{'x-request-id':'r'}});}
      const MIN=60000,end=Number(u.searchParams.get('endTime')??trig)+1,lim=Number(u.searchParams.get('limit')??1),iv=u.searchParams.get('interval')==='5m'?5*MIN:MIN;
      if(u.pathname==='/fapi/v1/klines')return Response.json(Array.from({length:lim},(_,k)=>{const t=Math.floor(end/iv)*iv-(lim-k)*iv,o=0.17+k*0.0002,c=o+0.0002;return [t,String(o),String(c*1.001),String(o*0.999),String(c),'0',t+iv-1,'10000',0,'0','6000','0'];}));
      if(u.pathname==='/futures/data/openInterestHist')return Response.json(Array.from({length:13},(_,k)=>({timestamp:Math.floor(trig/300000)*300000-(12-k)*300000,sumOpenInterest:1000+k,sumOpenInterestValue:5e5})));
      if(u.pathname==='/fapi/v1/premiumIndexKlines')return Response.json([[trig-MIN,'0','0','0','0.0002','0',trig-1]]);
      if(u.pathname==='/fapi/v1/premiumIndex')return Response.json({lastFundingRate:'0.0001'});
      if(u.pathname==='/fapi/v1/depth')return Response.json({bids:[[0.1799,40000],[0.1798,40000]],asks:[[0.18,40000],[0.1801,40000]]});
      return new Response('x',{status:404});};
    const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'proof',apiBudgetUsd:3,maxCalls:300,enforceApproved:true,source:'PROOF'},
      store:new MemoryReviewStore(),apiKey:()=>'mock',now:()=>trig+1500,fetchFn,engine:FD1_ENTRY_ENGINE,baseline:baselineAllowedLive,schedule:()=>{}});
    await c.consider(s);await Promise.all([...c.pending.values()]);const r=await c.consider(s);
    out['gpt_'+answer]={gptLayerReached:apiCalls>0,decision:r.decision,orderCandidate:c.check(s).allowed===true};
  }
  console.log(JSON.stringify(out,null,1));
}
