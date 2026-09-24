import {toWireV4 as toWireAnswer,toWireV5,toWireV6,FACT_PATHS} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';
import {REVIEW_CONTRACT_V6} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {arithmeticCheck,decisionIdentity,MODEL} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
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
/** Seconds-old order book / funding / OI fixture: deep, balanced, calm (no V6 risk). */
export function microData({book=null,premium=null,oiHist=null}={}){
  const src=data=>({data,requestedAt:T+200,receivedAt:T+300});
  const lv=(p0,step)=>Array.from({length:20},(_,i)=>[String(p6(p0+step*i)),'100']);
  const p6=x=>Number(x.toFixed(6));
  return {book:src(book??{bids:lv(106.18,-0.01),asks:lv(106.2,0.01)}),premium:src(premium??{markPrice:'106.2',indexPrice:'106.19',lastFundingRate:'0.0001'}),
    oi:src({openInterest:'1000'}),oiHist:src(oiHist??Array.from({length:13},(_,i)=>({timestamp:T-(13-i)*300000,sumOpenInterest:String(10000+i)})))};
}
export function marketData(s=candidate(),at=T+1000,micro=microData()){
  return computeMarket(decisionIdentity(s),{one:{rows:bars(61,60000),requestedAt:T+100,receivedAt:T+300},
    five:{rows:bars(12,300000),requestedAt:T+100,receivedAt:T+300},
    btc:{rows:bars(16,60000,60000),requestedAt:T+100,receivedAt:T+300},micro},at);
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
    const input=JSON.parse(JSON.parse(init.body).input[1].content);
    const wire=input.w==='RTRISK6'?toWireV6(mutate(answerV6(packetFromV6(input),decision))):
      input.w==='FACTREF5'?(p=>toWireV5(mutate(answer(p,decision)),p))(packetFromV5(input)):toWireAnswer(mutate(answer(input,decision)),input);
    return new Response(JSON.stringify(rawResponse(wire)),{status,headers:{'content-type':'application/json','x-request-id':'req_TEST_ONLY'}});
  };
}
export function config(mode='ENFORCE'){return {mode,modeValid:true,approvalRef:'TEST_ONLY',apiBudgetUsd:10,maxCalls:50,enforceApproved:true};}
/** Rebuilds the fact view a V5 request exposes, so the mock answers only from what it was sent. */
export function packetFromV5(input){
  const p={candidate_id:input.c,snapshot_hash:input.h,original_model:{...input.original_model,metrics:{},factors:{}},current_market:{quality:input.current_market.quality,metrics:{}}};
  for(const [id,path] of Object.entries(FACT_PATHS)){const [value,unit]=input.facts.rows[id];const [,a,b,k]=path.split('/');p[a][b][k]={value,unit};}
  return p;
}

/** Canonical V6 answer built only from what a V6 request exposes. */
export function answerV6(p,decision='PASS',risks=null){
  const ev=k=>({field_path:'/current_market/metrics/'+k,observed_value:p.current_market.metrics[k].value,unit:p.current_market.metrics[k].unit,interpretation:'x'});
  return {review_contract:REVIEW_CONTRACT_V6,candidate_id:p.candidate_id,snapshot_hash:p.snapshot_hash,decision,
    assessment:{PASS:'SUPPORTED',VETO:'CONTRADICTED',ABSTAIN:'INSUFFICIENT_EVIDENCE'}[decision],
    risks:risks??(decision==='VETO'?[{risk_id:'SPREAD_ABNORMAL',evidence:[ev('spread')]}]:[]),checked_claims:[],
    supporting_evidence:decision==='PASS'?[ev('return_5m'),ev('ask_depth_to_slot_notional')]:[],opposing_evidence:[],missing_fields:[],
    summary:decision==='PASS'?'새로운 실시간 위험이 확인되지 않습니다.':decision==='VETO'?'실시간 주문 위험이 확인됩니다.':'판단할 수 없습니다.'};
}
export function packetFromV6(input){
  const p={candidate_id:input.c,snapshot_hash:input.h,current_market:{quality:input.current_market.quality,metrics:{}}};
  for(const [id,[value,unit]] of Object.entries(input.facts.rows))p.current_market.metrics[id.slice(2)]={value,unit};
  return p;
}
