import test from 'node:test';
import assert from 'node:assert/strict';
import {computeMicro,readMicro,MICRO_FIELDS,MICRO_MAX_AGE_MS} from '../../../supabase/functions/_shared/gpt-final-review/micro.mjs';
import {collectMarket,buildPacket} from '../../../supabase/functions/_shared/gpt-final-review/market.mjs';
import {decisionIdentity} from '../../../supabase/functions/_shared/gpt-final-review/contract.mjs';
import {FACT_PATHS,compactInputV5} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';
import {payloadFor} from '../../../supabase/functions/_shared/gpt-final-review/openai.mjs';
import {candidate,bars} from './helpers.mjs';
const AS=1_790_000_000_000;
const src=(data,age=500,lat=80)=>({data,requestedAt:AS-age-lat,receivedAt:AS-age});
const book={bids:[['99.9','10'],['99.8','20'],['99.0','1000']],asks:[['100.1','5'],['100.2','10'],['101','1000']]};
const premium={markPrice:'100',indexPrice:'99.9',lastFundingRate:'0.0001'};
const hist=Array.from({length:13},(_,i)=>({timestamp:AS-(13-i)*300000,sumOpenInterest:String(1000+i*10)}));
test('computes spread, 25bp depth, imbalance, slot coverage, funding, premium and OI from fresh sources',()=>{
  const {metrics:m,availability}=computeMicro({book:src(book),premium:src(premium),oi:src({openInterest:'50'}),oiHist:src(hist)},AS);
  assert.ok(Math.abs(m.spread.value-20)<1e-9);assert.equal(m.spread.unit,'bps');
  assert.ok(Math.abs(m.bid_depth_25bps.value-(99.9*10+99.8*20))<1e-9);assert.ok(Math.abs(m.depth.value-(100.1*5+100.2*10))<1e-9);
  assert.ok(m.book_imbalance_25bps.value>0);assert.ok(Math.abs(m.ask_depth_to_slot_notional.value-m.depth.value/600)<1e-12);
  assert.equal(m.funding.value,0.0001);assert.ok(Math.abs(m.mark_index_premium.value-(100/99.9-1))<1e-12);
  assert.equal(m.open_interest_usdt.value,5000);assert.ok(Math.abs(m.oi_change_5m.value-(1120/1110-1))<1e-12);assert.ok(Math.abs(m.oi_change_60m.value-(1120/1000-1))<1e-12);
  assert.ok(availability.every(x=>x.ok&&x.age_at_snapshot_ms===500&&x.request_ms===80));
});
test('sources older than the freshness limit are withheld, not used',()=>{
  const {metrics:m,availability}=computeMicro({book:src(book,MICRO_MAX_AGE_MS+1),premium:src(premium),oi:src({openInterest:'50'}),oiHist:src(hist)},AS);
  assert.equal(m.spread.value,null);assert.equal(m.depth.missing_reason,'STALE_OR_INVALID_TIMING');assert.equal(m.funding.value,0.0001);
  assert.equal(availability.find(x=>x.source==='book').ok,false);
});
test('a failed source blanks only its own fields; future timestamps are rejected',()=>{
  const {metrics:m}=computeMicro({book:{error:'HTTP_418'},premium:{data:premium,requestedAt:AS+1,receivedAt:AS+5},oi:src({openInterest:'50'}),oiHist:src(hist)},AS);
  assert.equal(m.spread.missing_reason,'SOURCE_UNAVAILABLE');assert.equal(m.funding.value,null);
  assert.equal(m.open_interest_usdt.value,null);assert.equal(m.oi_change_5m.value!==null,true);
});
test('every microstructure field is a selectable C_ fact',()=>{for(const k of Object.keys(MICRO_FIELDS))assert.ok(FACT_PATHS['C_'+k],k);});
function fakeFetch({failDepth=false,calls=[]}={}){
  return async url=>{calls.push(url);const u=new URL(url);let body;
    if(u.pathname==='/fapi/v1/klines'){const i=u.searchParams.get('interval'),n=Number(u.searchParams.get('limit'));body=bars(n,i==='5m'?300000:60000,u.searchParams.get('symbol')==='BTCUSDT'?60000:100);}
    else if(u.pathname==='/fapi/v1/depth'){if(failDepth)return new Response('x',{status:500});body=book;}
    else if(u.pathname==='/fapi/v1/premiumIndex')body=premium;else if(u.pathname==='/fapi/v1/openInterest')body={openInterest:'50'};
    else if(u.pathname==='/futures/data/openInterestHist')body=hist;else return new Response('no',{status:404});
    return new Response(JSON.stringify(body),{status:200});};
}
test('live collection reads the four public endpoints alongside candles and feeds the packet',async()=>{
  const s=candidate(),calls=[];const T=Number(s.features.v17Setup.triggerAt),clock=()=>Date.now();
  const cur=await collectMarket(decisionIdentity(s),{fetchFn:fakeFetch({calls}),now:clock,deadlineMs:Date.now()+5000,signal:AbortSignal.timeout(5000)});
  for(const p of ['/fapi/v1/depth','/fapi/v1/premiumIndex','/fapi/v1/openInterest','/futures/data/openInterestHist'])assert.ok(calls.some(u=>u.includes(p)),p);
  assert.ok(calls.every(u=>u.startsWith('https://fapi.binance.com/')&&!/signature|apiKey|timestamp=/.test(u)));
  assert.equal(cur.quality.microstructure_complete,true);assert.ok(Math.abs(cur.metrics.spread.value-20)<1e-9);
  const p=await buildPacket(decisionIdentity(s),cur,Date.now()),input=compactInputV5(p);
  assert.ok(Math.abs(input.facts.rows.C_spread[0]-20)<1e-9);assert.equal(input.current_market.microstructure_availability.length,4);
  assert.ok(!JSON.stringify(payloadFor(p)).includes('TESTUSDT'));
});
test('microstructure failure does not fail the candle snapshot',async()=>{
  const s=candidate();
  const cur=await collectMarket(decisionIdentity(s),{fetchFn:fakeFetch({failDepth:true}),now:Date.now,deadlineMs:Date.now()+5000,signal:AbortSignal.timeout(5000)});
  assert.equal(cur.metrics.depth.value,null);assert.equal(cur.metrics.funding.value,0.0001);assert.equal(cur.quality.microstructure_complete,false);
});
test('a shifted replay clock never pairs historical candles with the current book',async()=>{
  const s=candidate(),calls=[],shift=3600000;
  const cur=await collectMarket(decisionIdentity(s),{fetchFn:fakeFetch({calls}),now:()=>Date.now()-shift,deadlineMs:Date.now()-shift+5000,signal:AbortSignal.timeout(5000)});
  assert.ok(!calls.some(u=>/depth|premiumIndex|openInterest/.test(u)));assert.equal(cur.metrics.spread.missing_reason,'NOT_POINT_IN_TIME_REPLAY');
});
test('readMicro refuses malformed symbols before any request',async()=>{let n=0;await assert.rejects(readMicro('BTC/USDT',{fetchFn:async()=>{n++;}}),/SYMBOL/);assert.equal(n,0);});
