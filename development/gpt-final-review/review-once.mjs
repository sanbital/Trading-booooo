/** Calls the real GPT API for ONE live candidate. No DB, trade or order client. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensure,baselineAllowed} from '../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FinalReviewCoordinator,MAX_RESERVED_USD} from '../../supabase/functions/_shared/gpt-final-review/coordinator.mjs';
import {FileReviewStore} from './file-store.mjs';
export async function main(args=process.argv.slice(2)){
  const value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
  if(args.includes('--help')){console.log('node review-once.mjs --candidate live-candidate.json --journal ./private-gpt-journal --call-api --approve-cost-usd 0.10 --approval-ref YOUR_REFERENCE');return;}
  ensure(args.includes('--call-api'),'EXPLICIT_API_CALL_REQUIRED');
  const file=value('--candidate'),directory=value('--journal'),approval=value('--approval-ref'),cap=Number(value('--approve-cost-usd'));
  ensure(file&&directory&&approval,'CANDIDATE_JOURNAL_APPROVAL_REQUIRED');
  ensure(Number.isFinite(cap)&&cap>=MAX_RESERVED_USD,'APPROVED_API_COST_REQUIRED');
  ensure(!!process.env.OPENAI_API_KEY,'OPENAI_API_KEY_MISSING');
  const bytes=readFileSync(resolve(file));ensure(bytes.length<500000,'CANDIDATE_TOO_LARGE');
  const candidate=JSON.parse(bytes);ensure(baselineAllowed(candidate),'EXISTING_APPROVED_CANDIDATE_REQUIRED');
  const store=new FileReviewStore(directory);
  const c=new FinalReviewCoordinator({config:{mode:'SHADOW',modeValid:true,approvalRef:approval,
    apiBudgetUsd:cap,maxCalls:1,enforceApproved:false},store,apiKey:()=>process.env.OPENAI_API_KEY});
  const initial=await c.consider(candidate);await Promise.all([...c.pending.values()]);
  const keys=[...c.tracked.keys()],row=keys.length?await store.get(keys[0]):null;
  const result=row?.record?.result??null;
  console.log(JSON.stringify({mode:'ONE_CANDIDATE_NO_ORDER',production_changed:false,orders:0,
    decision:result?.decision??'ABSTAIN',valid:result?.valid??false,error:result?result.error:initial.reason,
    summary:result?.answer?.summary??null,request_id:result?.request_id??null,
    api_cost_usd:result?.api_cost_usd??null,journal:keys.length?store.path(keys[0]):null},null,2));
  if(!result?.valid)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  console.error('REVIEW_NOT_COMPLETED: check candidate freshness, explicit approval, API secret and private journal. No order was submitted.');process.exitCode=1;
});
