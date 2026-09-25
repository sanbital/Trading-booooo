import test from 'node:test';
import assert from 'node:assert/strict';
import {runFd1Audit,fd1Packet,FD1_SQL} from './fd1-audit.mjs';
import {MODEL} from './v2/contract.mjs';

const at=Date.parse('2026-09-25T06:40:00Z');
const healthy={n_60m:10,n_err_60m:0,n_quota_60m:0,ledger_calls_today:12};
const review=(task,key)=>({job_key:key,task,symbol:'FOLKSUSDT',signal_id:'s1',decision:task==='HOLD'?'HOLD':'SKIP',
  created_at:'2026-09-25T06:39:00Z',packet:{task,facts:{values:{position_return:-.016,position_peak_return:.0009,
    taker_buy_ratio_5m:.25,distance_trigger_reference:-.014,return_15m:.01}},initial:{facts:{return_15m:.02}},
    change:{price_change:-.005},position:{stop_stage:'INITIAL'}}});
const response=a=>({ok:true,headers:{get:()=>null},json:async()=>({status:'completed',model:MODEL,
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(a)}]}],
  usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0}}})});

test('both tasks are independent research records without exposing the production decision to GPT',async()=>{
  const asks=[],updates=[];
  const db={query:async(sql,p)=>{
    if(sql===FD1_SQL.fetchReview)return [review('RECHECK','r1'),review('HOLD','h1')];
    if(sql===FD1_SQL.claimReview)return [{job_key:p[0]}];
    if(sql===FD1_SQL.finishReview){updates.push(p);return [{job_key:p[0]}];}
    throw Error('Unexpected SQL');
  }};
  const guard={fetch:async(url,opt)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const packet=JSON.parse(opt.body).input[1].content;
    asks.push(JSON.parse(packet));
    const hold=asks.length===2;
    return response({decision:hold?'EXIT_ENTRY_FAILURE':'WAIT_RECHECK',trend_valid:true,entry_valid:false,micro_only:!hold,
      e:hold?['position_return','position_peak_return','taker_buy_ratio_5m']:['change.price_change','initial_facts.return_15m','nonexistent_metric'],reason:'Test'});
  }};
  const result=await runFd1Audit({db,store:{gptHealth:async()=>healthy},guard,apiKey:'test',now:()=>at});
  assert.equal(result.gpt_calls,2);assert.equal(result.orders,0);
  assert.deepEqual(updates.map(x=>x[1]),['WAIT_RECHECK','EXIT_ENTRY_FAILURE']);
  assert.deepEqual(JSON.parse(updates[0][5]),['change.price_change','initial_facts.return_15m']);
  assert.match(updates[0][13],/IGNORED_UNSUPPORTED_EVIDENCE/);
  for(const p of asks){assert.equal(p.production_decision,undefined);assert.equal(p.actual_outcome,undefined);}
  assert.equal(asks[1].position_stage,'INITIAL');
});

test('production quota stands down without a claim or GPT request',async()=>{
  const result=await runFd1Audit({db:{query:()=>{throw Error('DB should not be read');}},
    store:{gptHealth:async()=>({...healthy,n_quota_60m:1})},guard:{fetch:()=>{throw Error('No API');}},apiKey:'test'});
  assert.equal(result.gpt_calls,0);assert.equal(result.gate,'PRODUCTION_429_OR_QUOTA_60M');
});

test('packet excludes production judgment and future fields',()=>{
  const packet=fd1Packet({...review('HOLD','x'),packet:{...review('HOLD','x').packet,answer:{decision:'HOLD'},outcome:{pnl:100}}});
  assert.equal(packet.answer,undefined);assert.equal(packet.outcome,undefined);assert.equal(packet.position_stage,'INITIAL');
});
