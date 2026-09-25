// LE-SHADOW-1 logic: KST-midnight velocity validity, no-lookahead, lanes/shortlist, ALT1 contract
// (SKIP always offered, invalid => ABSTAIN), WAIT lifecycle (TTL 10 min, <=1 re-ask, invalidation),
// GPT budget/stand-down gating. PGlite-backed where the database participates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupDb,addObserver,symbols,world,MIN} from './leader-emerging-shadow-helpers.mjs';
import {klines} from '../development/gpt-final-decision/tests/fixtures.mjs';
import {createGuard} from '../supabase/functions/leader-emerging-shadow/guard.mjs';
import {kstDayStart,velocityWindow,rankUniverse,observerPrices} from '../supabase/functions/leader-emerging-shadow/universe.mjs';
import {classify,shortlist,softCategories,ruleBaseline,LANE_RULES} from '../supabase/functions/leader-emerging-shadow/select.mjs';
import {preciseRead} from '../supabase/functions/leader-emerging-shadow/features.mjs';
import {wireSchema,validateAnswer,WAIT_TTL_MS,DECISIONS,RECHECK_DECISIONS} from '../supabase/functions/leader-emerging-shadow/contract.mjs';
import {callAlt1,standDown,gptGate,buildPacket,payloadFor} from '../supabase/functions/leader-emerging-shadow/gpt.mjs';
import {evaluateWait} from '../supabase/functions/leader-emerging-shadow/wait.mjs';
import {labelOutcome} from '../supabase/functions/leader-emerging-shadow/outcome.mjs';
import {runScan,runWait} from '../supabase/functions/leader-emerging-shadow/shadow.mjs';

const DAY0=Date.parse('2026-09-24T15:00:00Z'); // KST 2026-09-25 00:00

test('velocity is void inside 60 min after KST midnight and for references from the previous KST day', ()=>{
  const ref=t=>({observedAt:t,rankOrder:[]});
  let v=velocityWindow(DAY0+59*MIN,{m15:ref(DAY0+44*MIN),m30:ref(DAY0+29*MIN),m60:ref(DAY0-MIN)});
  assert.equal(v.blackout,true);assert.equal(v.valid15||v.valid30||v.valid60,false);
  v=velocityWindow(DAY0+61*MIN,{m15:ref(DAY0+46*MIN),m30:ref(DAY0+31*MIN),m60:ref(DAY0+MIN)});
  assert.deepEqual([v.blackout,v.valid15,v.valid30,v.valid60],[false,true,true,true]);
  v=velocityWindow(DAY0+61*MIN,{m15:ref(DAY0+46*MIN),m30:null,m60:ref(DAY0-2*MIN)});
  assert.deepEqual([v.valid15,v.valid30,v.valid60],[true,false,false]);
  // a symbol that jumps 30 ranks across midnight is NOT emerging
  const ranked=[...Array(40)].map((_,i)=>({symbol:'S'+i+'USDT',rank:i+1,dayReturn:.1-i/1000,price:1}));
  const old={observedAt:DAY0-5*MIN,rankOrder:ranked.map(r=>r.symbol).reverse()};
  const rows=classify(ranked,DAY0+10*MIN,{cycles:[old],today:[]});
  assert.ok(rows.every(r=>r.lane!=='EMERGING'&&r.velocityValid===false));
});

test('lanes and shortlist: LEADER first Top3 entry <=1, EMERGING <=2 by velocity then lower vr15, cooldown 30 min', ()=>{
  const t=DAY0+5*3600_000,syms=[...Array(60)].map((_,i)=>'S'+String(i).padStart(2,'0')+'USDT');
  const ranked=syms.map((s,i)=>({symbol:s,rank:i+1,dayReturn:.3-i/1000,price:1}));
  const past=[...syms];past.splice(0,0,...past.splice(8,1));past.splice(1,0,...past.splice(9,1));   // S08 and S09 were ~2nd..3rd
  for(const s of ['S05USDT','S06USDT','S07USDT']){const i=past.indexOf(s);past.splice(i,1);past.push(s);}  // 5-7 came from the bottom
  const cyc={observedAt:t-60*MIN,rankOrder:past},c15={observedAt:t-15*MIN,rankOrder:past};
  const today=[{observedAt:t-20*MIN,top10:['S01USDT','S02USDT','S00USDT']}];
  const rows=classify(ranked,t,{cycles:[cyc,c15],today});
  const lane=s=>rows.find(r=>r.symbol===s).lane;
  assert.equal(lane('S00USDT'),'LEADER');assert.equal(lane('S05USDT'),'EMERGING');assert.equal(lane('S06USDT'),'EMERGING');
  assert.equal(lane('S07USDT'),'EMERGING');assert.equal(lane('S20USDT'),'CONTROL');
  // S00 was already Top3 today -> not a first entry; S01/S02 same; so no LEADER is shortlisted
  const sl=shortlist(rows,{vr15Of:s=>({S05USDT:5,S06USDT:1.2,S07USDT:3})[s]});
  assert.ok(sl.selected.length<=3);
  assert.equal(sl.reason.get('S00USDT'),'LEADER_NOT_FIRST_ENTRY');
  // equal velocity (all came from rank 60->5,6,7 differs) -> highest velocity first
  assert.deepEqual(sl.selected.filter(s=>lane(s)==='EMERGING').length,2);
  const cooled=shortlist(rows,{recentShortlisted:new Set(sl.selected)});
  for(const s of sl.selected)assert.equal(cooled.reason.get(s),'COOLDOWN_30M');
});

test('ranking uses COIN perpetuals with an anchor only', ()=>{
  const p=observerPrices({'BF:AUSDT':2,'BF:BUSDT':1.5,'BF:XAUUSDT':5,'BS:AUSDT':9,'BF:NEWUSDT':3});
  const {ranked,unanchored}=rankUniverse(p,{AUSDT:1,BUSDT:1,XAUUSDT:1},['AUSDT','BUSDT','NEWUSDT']);
  assert.deepEqual(ranked.map(r=>r.symbol),['AUSDT','BUSDT']);assert.equal(unanchored,1);
});

test('no lookahead: every bar used by the precise read closes strictly before asOf', async()=>{
  const asOf=Date.parse('2026-09-24T10:07:31Z');
  const future=[];
  // a Binance that also returns the still-open current bar (as the real API does)
  const fetchFn=async(url)=>{
    const u=new URL(url),lim=Number(u.searchParams.get('limit')),iv={'1m':MIN,'5m':5*MIN,'15m':15*MIN}[u.searchParams.get('interval')];
    const end=u.searchParams.has('endTime')?Number(u.searchParams.get('endTime'))+1:asOf;
    const J=x=>new Response(JSON.stringify(x),{status:200,headers:{'x-mbx-used-weight-1m':'10'}});
    if(u.pathname==='/fapi/v1/klines'){const rows=klines(lim,iv,end);const open=klines(1,iv,Math.floor(asOf/iv)*iv+iv);future.push(open[0]);return J([...rows,...open]);}
    if(u.pathname==='/futures/data/openInterestHist')return J([{timestamp:asOf+60000,sumOpenInterest:1,sumOpenInterestValue:1},{timestamp:Math.floor(asOf/300000)*300000-300000,sumOpenInterest:1,sumOpenInterestValue:1}]);
    if(u.pathname==='/fapi/v1/premiumIndexKlines')return J([[Math.floor(asOf/MIN)*MIN,'0','0','0','0.9','0',Math.floor(asOf/MIN)*MIN+MIN-1]]);
    if(u.pathname==='/fapi/v1/premiumIndex')return J({lastFundingRate:'0.0001'});
    if(u.pathname==='/fapi/v1/depth')return J({bids:[[1,5000]],asks:[[1.0001,5000]]});
    return new Response('x',{status:404});
  };
  const g=createGuard({fetchFn});
  const r=await preciseRead(g,{symbol:'AUSDT',rank:5,dayReturn:.1,price:1},{asOf,btc15:klines(9,15*MIN,Math.floor(asOf/(15*MIN))*15*MIN),btcCache:new Map()});
  assert.ok(r.facts.quality.last_close_at_ms<asOf);
  assert.equal(r.facts.values.premium_index,null,'a premium bar closing after asOf is not used');
  assert.ok(r.v17.signal15Close<=asOf&&r.b06133.decisionAt<=asOf);
  for(const b of r.b06133?Object.values(r.b06133):[])void b;
  assert.ok(future.length>0);
  // outcomes are labeled only after maturity, from bars at/after entry: labels never feed selection
  const lab=labelOutcome({at:asOf,price:1,beyondAskBps:1},klines(241,MIN,Math.floor(asOf/MIN)*MIN+241*MIN));
  assert.equal(lab.data_complete,true);
});

test('ALT1 contract: BUY/WAIT/SKIP/ABSTAIN always offered (SKIP never removed), re-ask drops only WAIT', ()=>{
  assert.deepEqual(wireSchema().properties.d.enum,['BUY','WAIT','SKIP','ABSTAIN']);
  assert.deepEqual(wireSchema({recheck:true}).properties.d.enum,['BUY','SKIP','ABSTAIN']);
  assert.ok(DECISIONS.includes('SKIP')&&RECHECK_DECISIONS.includes('SKIP'));
  // with no SOFT category active, SKIP is still valid via NO_EDGE_OVER_COST
  const packet={attempt:1,facts:{return_5m:.01,spread_bps:3},soft:{VOLUME_OVERHEATED:false},cost:{breakeven_bps:20}};
  const skip=validateAnswer({d:'SKIP',reasons:[{c:'NO_EDGE_OVER_COST',e:['return_5m']}],support:[],expected_move_bps:5,wait:{trigger:'NONE',param:null},n:'x'},packet);
  assert.equal(skip.decision,'SKIP');
  assert.throws(()=>validateAnswer({d:'SKIP',reasons:[{c:'VOLUME_OVERHEATED',e:['return_5m']}],support:[],expected_move_bps:null,wait:{trigger:'NONE',param:null},n:'x'},packet),/SOFT_NOT_ACTIVE/);
  assert.throws(()=>validateAnswer({d:'BUY',reasons:[],support:['return_5m','spread_bps'],expected_move_bps:15,wait:{trigger:'NONE',param:null},n:'x'},packet),/BELOW_BREAKEVEN/);
  assert.equal(validateAnswer({d:'BUY',reasons:[],support:['return_5m','spread_bps'],expected_move_bps:35,wait:{trigger:'NONE',param:null},n:'x'},packet).decision,'BUY');
  assert.throws(()=>validateAnswer({d:'WAIT',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'PULLBACK_HOLD',param:80},n:'x'},packet),/PARAM_RANGE/);
  assert.throws(()=>validateAnswer({d:'WAIT',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'FLOW_TURN',param:3},n:'x'},packet),/PARAM_FORBIDDEN/);
  assert.equal(validateAnswer({d:'WAIT',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'BREAKOUT_CONFIRM',param:20},n:'x'},packet).wait.ttl_ms,WAIT_TTL_MS);
  assert.throws(()=>validateAnswer({d:'WAIT',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'FLOW_TURN',param:null},n:'x'},{...packet,attempt:2}),/ENUM|WAIT_AFTER_WAIT/);
});

const api=(wire,{status=200,model='gpt-5.4-mini-2026-03-17',hang=false}={})=>{
  const calls=[];
  return {calls,fetchFn:async(url,init)=>{calls.push(JSON.parse(init.body));if(hang)return new Promise(()=>{});
    return new Response(JSON.stringify({model,status:'completed',usage:{input_tokens:3000,output_tokens:90,input_tokens_details:{cached_tokens:0}},
      output:[{type:'message',content:[{type:'output_text',text:typeof wire==='string'?wire:JSON.stringify(wire)}]}]}),{status,headers:{'x-request-id':'r'}});}};
};
const ledger=()=>{const st={n:0,settled:[]};return {st,reserve:async()=>({ok:true,reservation_id:++st.n}),settle:async(id,usd)=>{st.settled.push([id,usd]);}};};
const P={attempt:1,facts:{return_5m:.01,spread_bps:3},soft:{},cost:{breakeven_bps:20}};

test('invalid / error / timeout / wrong model => ABSTAIN, one request, never retried, budget settled', async()=>{
  for(const [wire,opt,err] of [['not json',{},/ALT_API_OR_VALIDATION_ERROR/],[{d:'MAYBE'},{},/TYPE|ENUM|REQUIRED/],[{d:'SKIP',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'NONE',param:null},n:'x'},{},/ALT_SKIP_NEEDS_REASON/],
    [{},{status:429},/HTTP_429/],[{},{model:'gpt-x'},/MODEL_MISMATCH/],[{},{hang:true},/API_TIMEOUT/]]){
    const a=api(wire,opt),l=ledger();
    const r=await callAlt1(P,{apiKey:'k',fetchFn:a.fetchFn,reserve:l.reserve,settle:l.settle,timeoutMs:50});
    assert.equal(r.decision,'ABSTAIN');assert.equal(r.valid,false);assert.match(r.error,err);
    assert.equal(a.calls.length,1);assert.equal(l.st.settled.length,1);
  }
  const noKey=api({}),l=ledger();
  const r=await callAlt1(P,{apiKey:null,fetchFn:noKey.fetchFn,reserve:l.reserve,settle:l.settle});
  assert.equal(r.error,'ALT_KEY_MISSING');assert.equal(noKey.calls.length,0);assert.equal(l.st.n,0);
  const denied=api({}),r2=await callAlt1(P,{apiKey:'k',fetchFn:denied.fetchFn,reserve:async()=>({ok:false,reason:'SHADOW_BUDGET_CALLS'}),settle:async()=>{}});
  assert.equal(r2.error,'ALT_BUDGET:SHADOW_BUDGET_CALLS');assert.equal(denied.calls.length,0);
});

test('stand-down: production 429/quota, error rate > 20%, >=250 production calls today, disabled control, missing key', ()=>{
  const ok={n_60m:10,n_err_60m:1,n_quota_60m:0,ledger_calls_today:19};
  assert.equal(standDown(ok),null);
  assert.equal(standDown({...ok,n_quota_60m:1}),'PRODUCTION_429_OR_QUOTA_60M');
  assert.equal(standDown({...ok,n_err_60m:3}),'PRODUCTION_ERROR_RATE_60M');
  assert.equal(standDown({...ok,ledger_calls_today:250}),'PRODUCTION_CALLS_TODAY');
  assert.equal(standDown(null),'PRODUCTION_HEALTH_UNKNOWN');
  assert.equal(gptGate({control:{enabled:true,gpt_enabled:false},apiKey:'k',health:ok}),'GPT_DISABLED');
  assert.equal(gptGate({control:{enabled:true,gpt_enabled:true},apiKey:null,health:ok}),'SHADOW_KEY_MISSING');
  assert.equal(gptGate({control:{enabled:true,gpt_enabled:true},apiKey:'k',health:ok}),null);
  const pk=buildPacket({candidate:{symbol:'AUSDT',observedAt:1,lane:'EMERGING',rank:12,rank15m:30,rank30m:35,rank60m:40,velocity15:18,velocity60:28,firstTop10Today:false,minutesInTop10Today:0,dayReturn:.1},
    rich:{facts:{values:{return_5m:.01,position_return:null}},vr15:2,cost:{breakeven_bps:20},soft:{},b06133:{factors:{absorption:true},allowed:true,branch:'R62'},v30:{admitted:true,failed:[]},cec:{ewma_usdt:-4,training_count:126}}});
  assert.ok(!('allowed' in pk.b06133_factors)&&!('branch' in pk.b06133_factors));
  assert.ok(pk.cec.label.includes('이 후보와 무관'));assert.ok(!('position_return' in pk.facts));
  assert.equal(payloadFor(pk).model,'gpt-5.4-mini-2026-03-17');
});

const W=(o={})=>({trigger:'PULLBACK_HOLD',param:30,snapshot_at_ms:DAY0,expires_at_ms:DAY0+WAIT_TTL_MS,mid:100,high60:101,spread_bps:8,rank:12,...o});
const bar=(t,o,h,l,c,q=100,buy=60)=>[t,String(o),String(h),String(l),String(c),'0',t+MIN-1,String(q),0,String(buy),String(buy),'0'];
const bookAt=m=>({bids:[[m*.9999,10000]],asks:[[m*1.0001,10000]]});

test('WAIT: TTL 10 min fixed, +-1% and rank -10 invalidation, triggers only on bars after the snapshot', ()=>{
  assert.equal(evaluateWait(W(),{now:DAY0+WAIT_TTL_MS,bars:[],book:bookAt(100)}).state,'EXPIRED');
  assert.equal(evaluateWait(W({expires_at_ms:DAY0+60*MIN}),{now:DAY0+WAIT_TTL_MS+1,bars:[],book:bookAt(100)}).state,'EXPIRED','TTL cannot be extended');
  assert.equal(evaluateWait(W(),{now:DAY0+MIN,bars:[],book:bookAt(98.9)}).reason,'PRICE_DOWN_1PCT');
  assert.equal(evaluateWait(W(),{now:DAY0+MIN,bars:[],book:bookAt(101.1)}).reason,'PRICE_UP_1PCT');
  assert.equal(evaluateWait(W(),{now:DAY0+6*MIN,bars:[],book:bookAt(100),rankLatest:{observedAt:DAY0+5*MIN,rank:22}}).reason,'RANK_DROP_10');
  // pullback touched BEFORE the snapshot minute does not count
  const pre=[bar(DAY0-MIN,100,100,99.5,100.2)];
  assert.equal(evaluateWait(W(),{now:DAY0+2*MIN,bars:pre,book:bookAt(100.1)}).state,'PENDING');
  const post=[bar(DAY0,100,100,99.6,99.8),bar(DAY0+MIN,99.8,100.3,99.8,100.2)];
  assert.equal(evaluateWait(W(),{now:DAY0+2*MIN+1,bars:post,book:bookAt(100.2)}).state,'TRIGGERED');
  assert.equal(evaluateWait(W({trigger:'RANK_CONFIRM',param:null}),{now:DAY0+6*MIN,bars:[],book:bookAt(100),rankFirst:{observedAt:DAY0+5*MIN,rank:14}}).reason,'RANK_NOT_CONFIRMED');
  assert.equal(evaluateWait(W({trigger:'RANK_CONFIRM',param:null}),{now:DAY0+6*MIN,bars:[],book:bookAt(100),rankFirst:{observedAt:DAY0+5*MIN,rank:11}}).state,'TRIGGERED');
  assert.equal(evaluateWait(W({trigger:'SPREAD_NORMALIZE',param:null}),{now:DAY0+MIN,bars:[],book:bookAt(100)}).state,'TRIGGERED');
});

test('GPT stage end-to-end on PGlite: WAIT -> trigger -> mechanical entry + exactly one re-ask; no second WAIT', async()=>{
  const {store,admin}=await setupDb();
  const t=Date.now()-20_000;if(t-kstDayStart(t)<90*MIN)return;
  const syms=symbols(520);
  await addObserver(admin,kstDayStart(t)+5000,Object.fromEntries(syms.map(s=>[s,1])));
  const at=k=>Object.fromEntries(syms.map((s,i)=>[s,1+(520-i)/1000+(s==='C040USDT'&&k===0?.035:0)]));
  for(const k of [60,30,15])await addObserver(admin,t-k*MIN,at(k));
  await addObserver(admin,t,at(0));
  for(const k of [60,30,15])await admin.query(`insert into shadow_le.cycles(mode,status,started_at,finished_at,kst_day,observation_bucket,observed_at,rank_order,arms_active,patch)
    values ('SCAN','OK',$1,$1,$2,$3,$1,$4,'[]','seed')`,[new Date(t-k*MIN).toISOString(),new Date(kstDayStart(t)+9*3600_000).toISOString().slice(0,10),
    new Date(Math.floor((t-k*MIN)/300000)*300000+2000).toISOString(),JSON.stringify(syms)]);
  await admin.query(`update shadow_le.control set gpt_enabled=true, set_by='test', reason='stage 2 test'`);
  let asked=0;
  const openai=body=>{asked++;const input=JSON.parse(body.input[1].content);
    const wire=input.attempt===2?{d:'SKIP',reasons:[{c:'NO_EDGE_OVER_COST',e:['return_5m']}],support:[],expected_move_bps:5,wait:{trigger:'NONE',param:null},n:'비용 대비 부족'}
      :{d:'WAIT',reasons:[],support:[],expected_move_bps:null,wait:{trigger:'SPREAD_NORMALIZE',param:null},n:'스프레드 정상화 대기'};
    return new Response(JSON.stringify({model:'gpt-5.4-mini-2026-03-17',status:'completed',usage:{input_tokens:3000,output_tokens:90,input_tokens_details:{cached_tokens:0}},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire)}]}]}),{status:200});};
  const w=world({exchangeSymbols:syms,openai});
  const out=await runScan({store,guard:createGuard({fetchFn:w.fetchFn}),now:Date.now,apiKey:'k'});
  assert.equal(out.gpt_state,'ENABLED',JSON.stringify(out));
  assert.ok(out.gpt_calls>=1&&out.gpt_calls<=3);
  const waits=await admin.query(`select decision_id, wait_expires_at, snapshot_at from shadow_le.decisions where decision='WAIT'`);
  assert.ok(waits.length>=1);
  for(const x of waits)assert.equal(new Date(x.wait_expires_at)-new Date(x.snapshot_at),WAIT_TTL_MS);
  const before=asked;
  // spread in the fake book is ~8 bps; make the book tight so SPREAD_NORMALIZE fires
  const tight=world({exchangeSymbols:syms,openai,depth:{bids:[[1.19999,50000]],asks:[[1.20001,50000]]}});
  // the world's 1m klines drift upward: keep the book mid within +-1% of the snapshot mid
  const r1=await runWait({store,guard:createGuard({fetchFn:tight.fetchFn}),now:Date.now,apiKey:'k'});
  const trig=r1.waits.filter(x=>x.state==='TRIGGERED').length;
  assert.equal(asked-before,trig,'one re-ask per triggered WAIT');
  const r2=await runWait({store,guard:createGuard({fetchFn:tight.fetchFn}),now:Date.now,apiKey:'k'});
  assert.equal(r2.status,'NO_ACTIVE_WAIT');assert.equal(asked-before,trig,'no second re-ask');
  const d2=await admin.query(`select arm, attempt, decision from shadow_le.decisions where attempt=2 or arm='WAIT_MECHANICAL' order by decision_id`);
  assert.equal(d2.filter(x=>x.arm==='GPT_ALT1'&&x.attempt===2).length,trig);
  assert.ok(d2.every(x=>x.decision!=='WAIT'));
  const b=await store.q('budgetState').then(r=>r[0].r);assert.equal(Number(b.calls),asked);
});
