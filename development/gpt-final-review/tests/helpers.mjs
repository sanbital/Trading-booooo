import {arithmeticCheck,decisionIdentity,MODEL,toWireAnswer} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {computeMarket,buildPacket} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
export const T=Date.UTC(2026,8,23,10,0,0);
export function candidate(id='test-signal'){
  const s={id,symbol:'TESTUSDT',status:'NEW',features:{referenceClose:100,exitPolicy:{stopPct:.01,trailArmPct:.008,trailGapPct:.004,maxHoldMs:3600000,staleMs:120000},
    v17Setup:{state:'TRIGGERED',triggerAt:T},b06133:{version:'B06133_ENTRY_SELECTION_1',allowed:true,result:true,branch:'R62',
      factors:{},source:{decisionAt:T,featureValues:{volumeRatio:4,return5m:.01,return15m:.02,return30m:.03,return60m:.04},
        prebars:[0,1,2].map(i=>({openTime:T-(3-i)*60000,closeTime:T-(2-i)*60000-1,open:100+i,high:102+i,low:99+i,close:101+i,quoteVolume:100,takerBuyQuote:45+i})),
        btc:{return30m:.01,return2h:.02,freshnessMs:0}}},
    cec0040:{version:'CEC0040_CAUSAL_EDGE_CONTROLLER_1',targetVersion:'CEC0040_P142_MEAN44_1',decisionAt:T,action:'ADMIT',ready:true,effectiveAllowed:true,enforcementEnabled:true}}};
  s.features.b06133.factors=arithmeticCheck(decisionIdentity(s)).expected;return s;
}
export function bars(n,interval,price=100){
  return Array.from({length:n},(_,i)=>{const t=T-(n-i)*interval,o=price+i*.1,c=o+.05;return[t,String(o),String(c+.1),String(o-.1),String(c),'100',t+interval-1,'10000',10,'55','5500','0'];});
}
export function marketData(s=candidate(),at=T+1000){
  return computeMarket(decisionIdentity(s),{one:{rows:bars(61,60000),requestedAt:T+100,receivedAt:T+300},
    five:{rows:bars(12,300000),requestedAt:T+100,receivedAt:T+300},
    btc:{rows:bars(16,60000,60000),requestedAt:T+100,receivedAt:T+300}},at);
}
export async function packet(s=candidate()){return buildPacket(decisionIdentity(s),marketData(s),T+1000);}
export function answer(p,decision='PASS'){
  const path='/current_market/metrics/return_5m',path2='/current_market/metrics/last_close_change';
  const ev=field=>({field_path:field,observed_value:p.current_market.metrics[field.split('/').at(-1)].value,
    unit:p.current_market.metrics[field.split('/').at(-1)].unit,interpretation:'완성 봉에서 확인한 현재 시장 근거입니다.'});
  return {candidate_id:p.candidate_id,snapshot_hash:p.snapshot_hash,decision,
    assessment:{PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'INSUFFICIENT_EVIDENCE'}[decision],
    checked_claims:[...Object.keys(p.original_model.factors).map(claim_id=>({claim_id,verdict:'SUPPORTED',evidence_paths:['/original_model/metrics/return15m']})),{claim_id:'CURRENT_REACCELERATION',verdict:{PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'UNKNOWN'}[decision],evidence_paths:[path,path2]}],
    supporting_evidence:decision==='PASS'?[ev(path),ev(path2)]:[],opposing_evidence:decision==='VETO'?[ev(path)]:[],
    missing_fields:[],summary:decision==='PASS'?'현재 시장 근거가 기존 매수 판단을 뒷받침합니다.':decision==='VETO'?'현재 근거가 기존 매수 판단과 충돌합니다.':'현재 자료만으로 판단을 확정하기 어렵습니다.'};
}
export function rawResponse(a){return {id:'resp_TEST_ONLY',status:'completed',model:MODEL,service_tier:'default',
  output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(a)}]}],
  usage:{input_tokens:1000,output_tokens:150,input_tokens_details:{cached_tokens:0}}};}
export function transport({decision='PASS',status=200,mutate=a=>a,hold=null,requests=[]}={}){
  return async(url,init)=>{
    requests.push({url,payload:JSON.parse(init.body),init});if(hold)await hold;
    const p=JSON.parse(JSON.parse(init.body).input[1].content);
    return new Response(JSON.stringify(rawResponse(toWireAnswer(mutate(answer(p,decision)),p))),{status,headers:{'content-type':'application/json','x-request-id':'req_TEST_ONLY'}});
  };
}
export function config(mode='ENFORCE'){return {mode,modeValid:true,approvalRef:'TEST_ONLY',apiBudgetUsd:10,maxCalls:50,enforceApproved:true};}
