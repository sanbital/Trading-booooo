/** FD1 open-position reviews inside the existing manager. The deterministic exit state is
 * computed first and is authoritative for every stop; this adapter can only
 *  - defer a TIME-based close while a fresh valid GPT HOLD exists (or for at most
 *    HOLD_POLICY.timeAnswerWaitMs while the answer is pending), and
 *  - turn a HOLD tick into a close when GPT answered a valid, fresh EXIT.
 * Any failure (control, budget, storage, API, validation) falls back to the deterministic
 * decision. The API call runs in the background; no lease is held while it runs. */
import {holdStep,initialHoldState,runHoldReview,TIME_REASONS,FD1_HOLD_POLICY_VERSION} from '../_shared/gpt-final-decision/hold.mjs';
import {SupabaseReviewStore,readReviewControl} from '../_shared/gpt-final-review/supabase-store.mjs';
import {configFromControl} from '../_shared/gpt-final-review/coordinator.mjs';
export {FD1_HOLD_POLICY_VERSION,TIME_REASONS};
const getenv=n=>globalThis.Deno?.env?.get(n)??'';
let testHooks=null;
export function setFd1HoldTestHooks(h){testHooks=h;}
function authorized(c,apiKey){return c.mode==='ENFORCE'&&c.modeValid!==false&&c.enforceApproved===true&&c.approvalRef.length>0&&
  c.apiBudgetUsd>=0.10&&Number.isInteger(c.maxCalls)&&c.maxCalls>0&&!!apiKey;}
/**
 * @returns {close:boolean, reason:string|null, fallback?:boolean, state:object, review?:object}
 */
export async function fd1HoldTick(db,p,{meta,state,bid,now,timeCandidate}){
  const store=testHooks?.store??new SupabaseReviewStore(db),apiKey=testHooks?.apiKey??getenv('OPENAI_API_KEY');
  const prior=meta.fd1Hold&&meta.fd1Hold.version===FD1_HOLD_POLICY_VERSION?meta.fd1Hold:initialHoldState(p.entry_price);
  const answerOf=async key=>{const row=await store.get(key);if(!row)return null;const r=row.record?.result??{};
    return {state:row.state,decision:r.decision,valid:r.valid===true,completed_at_ms:r.completed_at_ms};};
  let step;
  try{step=await holdStep(prior,{now,price:bid,peak:state.peakPrice,timeCandidate,positionId:p.id,answerOf});}
  catch{return {close:!!timeCandidate,reason:null,fallback:true,state:prior};}
  if(!step.start)return step;
  // A review is starting: claim it in the shared journal/ledger, then ask in the background.
  const fail=why=>({close:!!timeCandidate,reason:null,fallback:true,
    state:{...step.state,pending:null,last:{key:step.start.key,event:step.start.event,decision:why,at:now}}});
  try{
    const config=testHooks?.config??configFromControl(await readReviewControl(db).catch(()=>null),getenv);
    if(!authorized(config,apiKey))return fail('NOT_AUTHORIZED');
    const f=meta.entryFeatures??{};
    const record={version:FD1_HOLD_POLICY_VERSION,kind:'FD1_HOLD',purpose:'PRODUCTION',api_approval_ref:config.approvalRef,
      identity:{signal_id:String(p.signal_id??''),symbol:String(p.symbol).toUpperCase(),position_id:String(p.id),event:step.start.event},
      reserved_usd:0.10,source_commit:FD1_HOLD_POLICY_VERSION,packet:null,result:null};
    let claimed;
    try{claimed=await store.claim(step.start.key,record,config);}
    catch(e){return fail(/API_BUDGET_EXHAUSTED/.test(String(e?.message??e))?'BUDGET_EXHAUSTED':'CLAIM_FAILED');}
    if(claimed.created){
      const owner=claimed.row.owner;
      const task=(async()=>{
        const out=await (testHooks?.review??runHoldReview)({apiKey,position:{id:p.id,symbol:p.symbol,entryPrice:Number(p.entry_price),
          peakPrice:state.peakPrice,entryAt:Date.parse(p.entry_at),lastHighAt:state.lastHighAt,stopPrice:state.stopPrice,entryFeatures:f},
          event:step.start.event,timeCandidate,stopStage:state.protectionStage??null});
        await store.complete(step.start.key,owner,{...record,packet:out.packet,result:out.result,
          snapshot_at_ms:out.packet?now:null});
      })().catch(e=>console.error('FD1_HOLD_REVIEW_FAILED',p.id,String(e?.message??e).slice(0,200)));
      if(testHooks?.schedule)testHooks.schedule(task);
      else if(globalThis.EdgeRuntime?.waitUntil)EdgeRuntime.waitUntil(task);
    }
    return step;
  }catch{return fail('ADAPTER_ERROR');}
}
/** ORDER-FREE production probe of both FD1 decisions on live data (no lease, no claim of
 * signals, no order, no position write). Entry: the production FD1 engine on a fixture
 * trigger at the current minute. Hold: a fixture position with a pending TIME exit
 * candidate. Both call the real API once. Journal rows are DRYRUN only. */
export async function fd1Probe(db,{symbol,apiKey,runId,fetchFn=fetch,engine,store=new SupabaseReviewStore(db)}){
  const MIN=60000,trigger=Math.floor(Date.now()/MIN)*MIN;
  const url='https://fapi.binance.com/fapi/v1/klines?'+new URLSearchParams({symbol,interval:'1m',limit:'2',endTime:String(trigger-1)});
  const r=await fetchFn(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('LIVE_KLINES_'+r.status);
  const last=Number((await r.json()).filter(x=>Number(x[6])<trigger).at(-1)?.[4]);if(!(last>0))throw Error('LIVE_PRICE');
  const {FinalReviewCoordinator}=await import('../_shared/gpt-final-review/coordinator.mjs');
  const s={id:'fd1-probe-'+symbol+'-'+trigger+'-'+String(runId).slice(0,20),symbol,status:'NEW',features:{strategy:'LEADER_MOMENTUM_V17',
    referenceClose:last,dayReturn:null,rank:null,v17Setup:{state:'TRIGGERED',triggerAt:trigger},exitPolicy:{}}};
  const c=new FinalReviewCoordinator({config:{mode:'ENFORCE',modeValid:true,approvalRef:'FD1_PROBE:'+String(runId).slice(0,50),apiBudgetUsd:1.5,
    maxCalls:150,enforceApproved:true,source:'DRYRUN'},store,apiKey:()=>apiKey,fetchFn,purpose:'DRYRUN',engine,baseline:()=>true});
  const t0=Date.now(),first=await c.consider(s);await Promise.all([...c.pending.values()]);const second=await c.consider(s);
  const row=second.jobKey?await store.get(second.jobKey):null,res=row?.record?.result,pk=row?.record?.packet;
  const entry={fixture:true,triggerAt:trigger,first:first.reason,final:second.reason,decision:second.decision??null,allowed:second.allowed===true,
    elapsedMs:Date.now()-t0,latencyMs:res?.latency_ms??null,costUsd:res?.api_cost_usd??null,error:res?.error??null,
    quality:pk?.facts?.quality??null,sourceErrors:pk?.source_errors??null,answer:res?.answer??null,jobKey:second.jobKey??null,
    wouldOrder:second.allowed===true?'NEXT_STEP_IS_EXISTING_ORDER_GUARDS (not executed: probe)':'NO_ORDER'};
  const h0=Date.now(),hold=await runHoldReview({apiKey,fetchFn,position:{id:'fd1-probe-position-'+trigger,symbol,entryPrice:last*.99,peakPrice:last*1.01,
    entryAt:Date.now()-50*MIN,lastHighAt:Date.now()-46*MIN,stopPrice:last*.99*.99,entryFeatures:{referenceClose:last*.99}},
    event:'TIME_EXIT_CANDIDATE:V17_MOMENTUM_STALE',timeCandidate:'V17_MOMENTUM_STALE',stopStage:'RISK_CUT'});
  return {entry,hold:{fixture:true,decision:hold.result.decision,valid:hold.result.valid===true,latencyMs:hold.result.latency_ms??null,
    costUsd:hold.result.api_cost_usd??null,error:hold.result.error??null,answer:hold.result.answer??null,elapsedMs:Date.now()-h0,
    facts_quality:hold.packet?.facts?.quality??null,consequence:hold.result.decision==='HOLD'&&hold.result.valid?'TIME_EXIT_DEFERRED_15M':'DETERMINISTIC_TIME_EXIT'}};
}
