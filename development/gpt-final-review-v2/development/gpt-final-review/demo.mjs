/** Synthetic integration demo. Zero network/API/order calls. */
import {FinalReviewCoordinator,MemoryReviewStore} from '../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {candidate,marketData,transport,config,T} from './tests/helpers.mjs';
for(const decision of ['PASS','VETO','ABSTAIN']){
  const requests=[],c=new FinalReviewCoordinator({config:config(),store:new MemoryReviewStore(),
    apiKey:()=> 'TEST_ONLY',fetchFn:transport({decision,requests}),market:async()=>marketData(),now:()=>T+1000});
  const s=candidate(),first=await c.consider(s);await Promise.all([...c.pending.values()]);
  const result=await c.consider(s),check=c.check(s);
  console.log(JSON.stringify({TEST_ONLY:true,actual_api_calls:0,orders:0,original:'BUY_LONG',pending:first.reason,
    gpt:result.decision,can_enter_existing_guards:check.allowed,explanation:check.review?.summary??null}));
}
