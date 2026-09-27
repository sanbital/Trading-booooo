import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEpoch,epochBoundary,nextBoundary,membership,LEADER20} from '../supabase/functions/_shared/leader20/universe.mjs';
import {validEvent,leaderIdentity,reviewRequest,campaignOutcome} from '../supabase/functions/_shared/leader20/campaign.mjs';
import {validCapture,dynamicWire} from '../test-support/dynamic-fixtures.mjs';
import {compactDynamic,DYNAMIC_VERSION} from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import {entryExecutionWindow} from '../supabase/functions/v10-lane-executor/entry-evidence.mjs';
import {validateDecision,wireSchema} from '../supabase/functions/_shared/gpt-final-decision/contract.mjs';
import {buildDecisionPacket,modelInput} from '../supabase/functions/_shared/gpt-final-decision/api.mjs';
import {computeFacts} from '../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {src,entryWire} from '../development/gpt-final-decision/tests/fixtures.mjs';
const T=1800000000200;
export function sources(at=T) {
 const symbols=Array.from({length:25},(_,i)=>({symbol:'C'+String(i).padStart(2,'0')+'USDT',status:'TRADING',
  contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN'}));
 const tickers=symbols.map((s,i)=>({symbol:s.symbol,priceChangePercent:String(i-30),quoteVolume:'100',openTime:at-86400000,closeTime:at}));
 return {exchangeInfo:{symbols},tickers,requestedAt:at,observedAt:at+1};
}
function event(){return {id:'signal',symbol:'C01USDT',status:'NEW',features:{referenceClose:1,rank:1,exitPolicy:{stopPct:.025},
 v17Setup:{state:'EXPIRED'},b06133:{allowed:false},v30Front:{admitted:false},cec0040:{action:'REJECT'},
 leader20:{version:LEADER20,symbol:'C01USDT',epoch_id:'epoch',event_id:'event',generation:1,requested_at_ms:T,expires_at_ms:T+120000}}};}
test('numeric rolling24h sorting keeps exactly twenty, including an all-negative market',async()=>{
 const x=sources();x.tickers[0].priceChangePercent='9';x.tickers[1].priceChangePercent='100';
 x.tickers[2].priceChangePercent='9';x.tickers[2].quoteVolume='500';
 const e=await selectEpoch(x);assert.equal(e.members.length,20);assert.deepEqual(e.members.slice(0,3).map(x=>x.symbol),['C01USDT','C02USDT','C00USDT']);
 assert.ok((await selectEpoch(sources())).members.every(x=>x.price_change_percent<0));
 assert.equal(e.covered_count,25);assert.match(e.source_hash,/^[a-f0-9]{64}$/);
});
test('non-coin, delivery, spot-like and non-USDT metadata cannot enter the universe',async()=>{
 const x=sources();for(const [i,patch] of [{underlyingType:'EQUITY'},{contractType:'CURRENT_QUARTER'},{quoteAsset:'USDC'},{status:'SETTLING'}].entries())Object.assign(x.exchangeInfo.symbols[i],patch);
 const e=await selectEpoch(x);assert.equal(e.expected_count,21);assert.ok(e.members.every(m=>Number(m.symbol.slice(1,3))>=4));
});
test('missing/duplicate/stale/false/null tickers fail the whole epoch',async()=>{
 for(const mutate of [x=>x.tickers.pop(),x=>x.tickers.push(x.tickers[0]),x=>x.tickers[0].priceChangePercent=false,
   x=>x.tickers[0].quoteVolume=null,x=>x.tickers.forEach(t=>t.closeTime-=40000),x=>x.tickers[0].closeTime+=2000]){
  const x=sources();mutate(x);await assert.rejects(selectEpoch(x),/LEADER20_/);
 }
});
test('KST six-hour boundaries, bootstrap and restart do not backdate rankings',async()=>{
 const at=Date.parse('2026-09-27T01:12:00+09:00');
 assert.equal(epochBoundary(at),Date.parse('2026-09-27T00:00:00+09:00'));
 assert.equal(nextBoundary(at),Date.parse('2026-09-27T06:00:00+09:00'));
 const e=await selectEpoch(sources(at));assert.equal(e.kind,'BOOTSTRAP');assert.equal(e.scheduled_at_ms,at);
 await assert.rejects(selectEpoch({...sources(at+1000),previous:e}),/EPOCH_NOT_DUE/);
 const n=await selectEpoch({...sources(e.next_refresh_at_ms),previous:e});assert.equal(n.kind,'SCHEDULED');assert.equal(n.scheduled_at_ms,e.next_refresh_at_ms);
});
test('expired membership defers entry while held symbols remain managed',async()=>{
 const e=await selectEpoch(sources());
 assert.equal(membership(e,e.members[0].symbol,e.next_refresh_at_ms).reason,'DEFER_UNIVERSE_STALE');
 assert.equal(membership(e,'OUTUSDT',T,true).manage_only,true);
 assert.equal(membership(e,'OUTUSDT',T,false).watch,false);
});
test('legacy reject/missing setup has no authority over a new event; identity binds generation',()=>{
 const s=event();assert.equal(validEvent(s),true);assert.equal(leaderIdentity(s).trigger_at_ms,T);
 const window=entryExecutionWindow(s,false,120000,{});assert.equal(window.basis,'LEADER20_REVIEW_EVENT');assert.equal(window.expiresAt,T+120000);
 const b=structuredClone(s);b.features.leader20.generation++;assert.notDeepEqual(leaderIdentity(s),leaderIdentity(b));
 b.features.leader20.symbol='OTHERUSDT';assert.equal(validEvent(b),false);
});
test('first full capture and fair reevaluation need no bullish AND; duplicates coalesce',()=>{
 const c=validCapture(T);for(const h of Object.values(c.dynamics.horizons)){h.return=-.01;h.net_taker_flow=-10;h.buy_share=.1;}
 assert.equal(reviewRequest(null,c,{at:T,member:true}).request,true);
 const w={last_review_at_ms:T-120001,last_capture_end_ms:c.end_ms-5000,capture:c};
 assert.equal(reviewRequest(w,c,{at:T,member:true}).reason,'FAIR_REEVALUATION');
 assert.equal(reviewRequest({...w,last_capture_end_ms:c.end_ms},c,{at:T,member:true}).request,false);
 assert.equal(reviewRequest({...w,in_flight:true},c,{at:T,member:true}).reason,'SINGLE_FLIGHT');
 assert.equal(reviewRequest(w,c,{at:T,member:true,settledAt:c.start_ms+1}).reason,'POST_SETTLEMENT_EVIDENCE_PENDING');
});
test('23 buckets and gaps stay unavailable; one symbol never contaminates another',()=>{
 const a=validCapture(T);a.trajectory.pop();assert.equal(reviewRequest(null,a,{at:T,member:true}).request,false);
 assert.equal(reviewRequest(null,validCapture(T),{at:T,member:true}).request,true);
 for(const d of ['SKIP','WAIT','ABSTAIN'])assert.equal(campaignOutcome(d).state,'DEFERRED');
});
test('model compression contains all 24 aligned price/flow/book/time rows and preserves zeros',()=>{
 const c=validCapture(T);c.trajectory[3].aggressive_buy=0;const p=compactDynamic(c,{fullPath:true});
 assert.equal(p.ordered_path.length,24);
 for(const key of ['start_ms','end_ms','mid','start_mid','aggressive_buy','aggressive_sell','trade_count','spread_bps','bid_depth_25_usdt','ask_depth_25_usdt']){
  const k=p.ordered_path_columns.indexOf(key);assert.ok(k>=0);assert.deepEqual(p.ordered_path.map(row=>row[k]),c.trajectory.map(row=>row[key]??null));
 }
});
test('non-bearish DEFER is valid and counter-evidence/action fabrication is rejected',async()=>{
 const facts=computeFacts(src(T),{asOf:T});facts.capture_context=validCapture(T);
 const p=await buildDecisionPacket({task:'ENTRY',subjectId:'leader',symbol:'C01USDT',dataMode:'LIVE',facts,judgments:{}});
 Object.assign(p,{dynamic_policy:DYNAMIC_VERSION,dynamic_as_of_ms:T,leader20:event().features.leader20});
 const w=dynamicWire(entryWire({t:'ENTRY',c:p.candidate_id,d:'SKIP',n:'Observed opportunity is insufficient'}),p);
 Object.assign(w,{d:'SKIP',action:'DEFER',pressure_state:'MIXED',decision_reason:'Execution cost outweighs present opportunity',counter_evidence:[],
  thesis_invalidation:'Demand fails to move price',next_review_conditions:'Fresh flow and book change',
  reasons:[{r:'EV_UNFAVORABLE',e:['return_5m']}]});
 assert.equal(validateDecision(w,p).action,'DEFER');
 assert.ok(wireSchema('ENTRY',p).required.includes('pressure_state'));
 assert.throws(()=>validateDecision({...w,action:'ENTER'},p),/ACTION_MISMATCH/);
 assert.throws(()=>validateDecision({...w,counter_evidence:['invented']},p),/COUNTER_EVIDENCE_INVALID|ENUM/);
});

test('positions from the old route also receive the full new HOLD contract when adopted',async()=>{
 const facts=computeFacts(src(T),{asOf:T});facts.capture_context=validCapture(T);
 const p=await buildDecisionPacket({task:'HOLD',subjectId:'position',symbol:'OUTUSDT',dataMode:'LIVE',facts,judgments:{},position:{positionId:'p',generation:'g'}});
 Object.assign(p,{dynamic_policy:DYNAMIC_VERSION,dynamic_as_of_ms:T,leader20:{version:LEADER20,scope:'HELD_POSITION'}});
 const input=modelInput(p),schema=wireSchema('HOLD',p);
 assert.equal(input.capture_context.ordered_path.length,24);
 assert.ok(input.capture_context.ordered_path_columns.includes('aggressive_sell'));
 assert.deepEqual(schema.properties.action.enum,['DEFER','HOLD','PROTECT','EXIT']);
});

test('quiet contracts with older closeTime do not veto a freshly retrieved market universe',async()=>{
 const x=sources();
 // Binance live response 2026-09-27 13:01 UTC: AIOT was 55.586s and JCT 31.718s old.
 x.tickers[0].closeTime-=55586;x.tickers[0].priceChangePercent='100';
 x.tickers[1].closeTime-=31718;x.tickers[1].priceChangePercent='99';
 const e=await selectEpoch(x);
 assert.equal(e.covered_count,25);assert.equal(e.members.length,20);
 assert.equal(e.members[0].symbol,'C00USDT');assert.equal(e.members[0].ticker_age_ms,55587);
 assert.equal(e.members[1].symbol,'C01USDT');
 assert.equal(e.source_freshest_close_ms,T);
});

test('actual Binance Unicode COIN contracts participate in the complete numeric Top20',async()=>{
 const x=sources();const names=['龙虾USDT','哈基米USDT','牛来USDT','币安人生USDT','我踏马来了USDT'];
 for(const [i,name]of names.entries()){x.exchangeInfo.symbols[i].symbol=name;x.tickers[i].symbol=name;x.tickers[i].priceChangePercent=String(100+i);}
 const e=await selectEpoch(x);assert.equal(e.expected_count,25);assert.equal(e.covered_count,25);
 assert.deepEqual(e.members.slice(0,5).map(m=>m.symbol),[...names].reverse());
});
