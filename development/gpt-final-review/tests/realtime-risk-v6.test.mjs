import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAnswer,riskAssessment,RISK_RULES,REVIEW_CONTRACT_V6,decisionIdentity} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {compactInputV6,expandWireV6,toWireV6,WIRE_OUTPUT_SCHEMA_V6,FACT_PATHS} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';
import {payloadFor,DEFAULT_PROFILE} from '../../../supabase/functions/_shared/gpt-final-review/openai.mjs';
import {SYSTEM_PROMPT_V6} from '../../../supabase/functions/_shared/gpt-final-review/prompt.mjs';
import {buildPacket} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
import {T,candidate,marketData,microData,answerV6} from './helpers.mjs';
const pk=async(micro=microData())=>{const s=candidate();return buildPacket(decisionIdentity(s),marketData(s,T+1000,micro),T+1000);};
const lv=(p0,step,q='100')=>Array.from({length:20},(_,i)=>[String(Number((p0+step*i).toFixed(6))),q]);
const ev=(p,k)=>({field_path:'/current_market/metrics/'+k,observed_value:p.current_market.metrics[k].value,unit:p.current_market.metrics[k].unit,interpretation:'x'});
const roundTrip=(a,p)=>validateAnswer(expandWireV6(toWireV6(a),p),p);

test('production profile is V6 real-time risk review',async()=>{
  assert.equal(DEFAULT_PROFILE,'V6');const p=await pk(),x=payloadFor(p);
  assert.equal(x.input[0].content,SYSTEM_PROMPT_V6);assert.deepEqual(x.text.format.schema,WIRE_OUTPUT_SCHEMA_V6);
  assert.equal(JSON.parse(x.input[1].content).w,'RTRISK6');
});
test('V6 input carries only current-market facts, risk flags and read-only machine context',async()=>{
  const i=compactInputV6(await pk());
  assert.ok(Object.keys(i.facts.rows).length>0&&Object.keys(i.facts.rows).every(id=>id.startsWith('C_')));
  for(const k of ['spread','depth','bid_depth_25bps','book_imbalance_25bps','ask_depth_to_slot_notional','funding','mark_index_premium','open_interest_usdt','oi_change_5m','oi_change_60m','return_5m','volume_ratio_3m'])
    assert.ok(Object.hasOwn(i.facts.rows,'C_'+k),k);
  assert.equal(i.machine_decision.status,'ADMITTED_BY_V17_B06133_CEC0040');assert.equal(i.machine_decision.selector_branch,'R62');
  assert.ok(i.risk_flags.SPREAD_ABNORMAL&&i.risk_flags.DATA_INCOMPLETE);assert.ok(!JSON.stringify(i).includes('TESTUSDT'));
  // No schema slot exists for re-auditing the B06133 factors.
  assert.ok(!JSON.stringify(WIRE_OUTPUT_SCHEMA_V6).includes('absorption'));
});
test('healthy snapshot: every flag CLEAR, PASS valid without any B06133 re-audit',async()=>{
  const p=await pk(),r=riskAssessment(p);assert.deepEqual(r.hard,[]);assert.deepEqual(r.soft,[]);
  assert.equal(roundTrip(answerV6(p,'PASS'),p).decision,'PASS');
});
test('a VETO citing a CLEAR category is invalid (NIL 2026-09-23: deep ask book read as thin)',async()=>{
  const p=await pk();assert.ok(p.current_market.metrics.ask_depth_to_slot_notional.value>5);
  const a=answerV6(p,'VETO',[{risk_id:'THIN_ASK_LIQUIDITY',evidence:[ev(p,'ask_depth_to_slot_notional')]}]);
  assert.throws(()=>roundTrip(a,p),/VETO_RISK_NOT_PRESENT:THIN_ASK_LIQUIDITY/);
});
test('"already rose / volatile" cannot be a VETO basis: no such category, and price facts outside a category are refused',async()=>{
  const p=await pk();
  assert.throws(()=>expandWireV6({...toWireV6(answerV6(p,'VETO')),risks:[{r:'OVEREXTENDED',e:['C_return_60m']}]},p),/ENUM/);
  const wide={bids:[['105','500']],asks:[['106.2','500']]},q=await pk(microData({book:wide}));
  const a=answerV6(q,'VETO',[{risk_id:'SPREAD_ABNORMAL',evidence:[ev(q,'return_60m')]}]);
  assert.throws(()=>roundTrip(a,q),/VETO_EVIDENCE_OUTSIDE_RISK/);
});
test('real new risks are VETO-able with the fact on the risk side',async()=>{
  const cases=[
    ['SPREAD_ABNORMAL','spread',{book:{bids:lv(105,-0.01),asks:lv(106.2,0.01)}}],
    ['THIN_ASK_LIQUIDITY','ask_depth_to_slot_notional',{book:{bids:lv(106.18,-0.01),asks:lv(106.2,0.01,'0.1')}}],
    ['SELL_WALL_IMBALANCE','book_imbalance_25bps',{book:{bids:lv(106.18,-0.01,'10'),asks:lv(106.2,0.01,'1000')}}],
    ['FUNDING_EXTREME','funding',{premium:{markPrice:'106.2',indexPrice:'106.19',lastFundingRate:'0.002'}}],
    ['PREMIUM_EXTREME','mark_index_premium',{premium:{markPrice:'107',indexPrice:'106',lastFundingRate:'0.0001'}}],
  ];
  for(const [risk,k,m] of cases){
    const p=await pk(microData(m)),f=riskAssessment(p).flags[risk];assert.ok(['SOFT','HARD'].includes(f.level),risk+':'+f.level);
    assert.equal(roundTrip(answerV6(p,'VETO',[{risk_id:risk,evidence:[ev(p,k)]}]),p).decision,'VETO',risk);
  }
});
test('HARD risk or incomplete data makes PASS impossible regardless of the model',async()=>{
  const p=await pk(microData({book:{bids:lv(106.18,-0.01),asks:lv(106.2,0.01,'0.01')}}));
  assert.ok(riskAssessment(p).hard.includes('THIN_ASK_LIQUIDITY'));assert.throws(()=>roundTrip(answerV6(p,'PASS'),p),/PASS_WITH_HARD_RISK/);
  const s=candidate(),q=await buildPacket(decisionIdentity(s),marketData(s,T+1000,null),T+1000);
  assert.ok(riskAssessment(q).hard.includes('DATA_INCOMPLETE'));assert.throws(()=>roundTrip(answerV6(q,'PASS'),q),/PASS_WITH_HARD_RISK:.*DATA_INCOMPLETE/);
  assert.equal(roundTrip(answerV6(q,'VETO',[{risk_id:'DATA_INCOMPLETE',evidence:[]}]),q).decision,'VETO');
});
test('PASS still needs a current fact, a clean identity and no named risk',async()=>{
  const p=await pk(),a=answerV6(p,'PASS');
  assert.throws(()=>roundTrip({...a,supporting_evidence:[]},p),/PASS_REQUIRES_CURRENT_FACT/);
  assert.throws(()=>roundTrip({...a,candidate_id:'other'},p),/IDENTITY/);
  assert.throws(()=>roundTrip({...a,summary:'승률 90'},p),/NUMERICAL/);
  assert.throws(()=>roundTrip({...a,risks:[{risk_id:'SPREAD_ABNORMAL',evidence:[ev(p,'spread')]}]},p),/PASS_WITH_NAMED_RISK/);
});
test('V6 wire refuses original-model facts and extra fields',async()=>{
  const p=await pk(),w=toWireV6(answerV6(p,'PASS'));
  assert.throws(()=>expandWireV6({...w,support_now:['O_return15m']},p),/ENUM/);
  assert.throws(()=>expandWireV6({...w,k:[]},p),/EXTRA/);
  const walk=x=>{if(!x||typeof x!=='object')return;if(x.type==='object')assert.equal(x.additionalProperties,false);Object.values(x).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));};walk(WIRE_OUTPUT_SCHEMA_V6);
  for(const r of Object.values(RISK_RULES))for(const k of r.facts)assert.ok(FACT_PATHS['C_'+k],k);
});
