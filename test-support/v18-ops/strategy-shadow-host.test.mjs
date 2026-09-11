import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHandler} from '../../supabase/functions/v18-strategy-shadow/handler.mjs';
const at=Date.parse('2026-09-11T11:31:00Z'),cut5=at-60000,cut15=cut5;
const root='https://etaajwpernzrcdrifdnw.supabase.co';
const feature={symbol:'METUSDT',rank:1,atr:.01,dayReturn:.1,return15m:.02,
  return30m:.03,return60m:.05,volumeRatio:2,qv24:10000000,signal15Close:cut15};
const bars=Array.from({length:14},(_,i)=>{const t=cut5-(14-i)*300000,c=100+i*.2;
  return [t,String(c-.1),String(c+.1),String(c-.2),String(c),100,t+299999,1000,2,50,500];});
bars[13][2]='107.1';bars[13][4]='107';
function fixture(options={}){
  const calls=[],logs=[];
  const fake=async(input,init={})=>{
    const u=new URL(input),method=init.method||'GET';calls.push({url:u.href,method,body:init.body});
    const answer=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    if(u.origin===root){
      assert.equal(init.headers.apikey,'TEST_SERVICE_KEY');
      const table=u.pathname.split('/').at(-1);
      if(method==='POST'){
        assert.equal(table,'v18_strategy_shadow_runs','only isolated analytics table can be written');
        if(options.writeFail)return answer({},503);
        return answer(options.duplicate?[]:[JSON.parse(init.body)]);
      }
      assert.equal(method,'GET');
      if(table==='edge_internal_tokens')return answer([{token:'TEST_DIAGNOSTIC_TOKEN'}]);
      if(table==='v17_market_scan_runs')return answer([{id:975,captured_at:new Date(cut15+1000).toISOString(),
        signal_close_at:new Date(options.stale?cut15-900000:cut15).toISOString(),coverage:options.coverage??1,
        details:{top10:[feature],blocked:null}}]);
      if(table==='v11_long_regime_positions'){
        if(options.pageFail && Number(u.searchParams.get('offset'))===200)return answer({},503);
        if(options.pageFail && u.searchParams.get('state')==='eq.CLOSED')return answer(Array.from({length:200},(_,i)=>({id:String(i)})));
        return answer([]);
      }
      throw Error('Unexpected DB read '+table);
    }
    assert.equal(u.origin,'https://fapi.binance.com');assert.equal(method,'GET');
    assert.equal(init.headers,undefined,'no credentials on public market reads');
    if(u.pathname==='/fapi/v1/time')return answer({serverTime:at+(options.clockSkew||0)});
    if(u.pathname==='/fapi/v1/ticker/bookTicker')return answer(options.bookFail?{}:[{symbol:'METUSDT',bidPrice:'107',askPrice:'107.01',bidQty:'5',askQty:'2',time:at}]);
    if(u.pathname==='/fapi/v1/exchangeInfo')return answer({symbols:[{symbol:'METUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',underlyingType:'COIN',
      filters:[{filterType:'LOT_SIZE',stepSize:'1'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]});
    assert.equal(u.pathname,'/fapi/v1/klines');
    if(options.marketError)return answer({},options.marketError);
    assert.equal(u.searchParams.get('endTime'),String(cut5-1));
    return answer(bars);
  };
  return {calls,logs,handler:createHandler({url:root,key:'TEST_SERVICE_KEY',fetchFn:fake,now:()=>at,log:x=>logs.push(x)})};
}
const request=(token='TEST_DIAGNOSTIC_TOKEN',body={mode:'evaluate'})=>new Request(root,{method:'POST',
  headers:token?{'x-v16-diagnostic-token':token}:{},body:JSON.stringify(body)});
test('no token rejected before any DB or public request',async()=>{
  const x=fixture();assert.equal((await x.handler(request(null))).status,401);assert.equal(x.calls.length,0);
});
test('incorrect token cannot reach market or store observations',async()=>{
  const x=fixture();assert.equal((await x.handler(request('WRONG'))).status,401);assert.equal(x.calls.length,1);
});
test('run/order modes and user supplied timestamps cannot activate anything',async()=>{
  for(const body of [{mode:'run'},{mode:'evaluate',asOf:1},{mode:'create_order'}]){
    const x=fixture();assert.equal((await x.handler(request(undefined,body))).status,400);assert.equal(x.calls.length,1);
  }
});
test('fresh full scan evaluates 5 variants independently of all live entry controls',async()=>{
  const x=fixture(),r=await x.handler(request()),d=await r.json();
  assert.equal(r.status,200);assert.equal(d.evaluationState,'EVALUATED');assert.equal(d.entryDecisions.length,5);
  assert.equal(d.entryDecisions.find(x=>x.variant==='SPIKE_3PCT').verdict,'WOULD_FILTER');
  assert.equal(d.executionEnabled,false);assert.equal(d.persistedNew,true);
  assert.equal(d.collectorVersion,'V18_MARKET_OBSERVER_2');
  assert.equal(d.source.market.quotes[0].askQty,2);
  assert.equal(d.source.market.rules.METUSDT.step,1);
  assert.ok(x.calls.every(x=>!/(gateway|runtime|operator_control|trading_settings|regime_orders|regime_signals)/.test(x.url)));
  assert.ok(!JSON.stringify(x.logs).includes('TEST_SERVICE_KEY'));
});
test('malformed public book cannot become a saved executable paper observation',async()=>{
  const x=fixture({bookFail:true}),r=await x.handler(request());
  assert.equal(r.status,503);assert.ok(!x.calls.some(c=>c.method==='POST'));
});
test('stale or incomplete scan is saved as unavailable, never a successful strategy evaluation',async()=>{
  for(const opts of [{stale:true},{coverage:.5}]){
    const x=fixture(opts),d=await (await x.handler(request())).json();
    assert.equal(d.evaluationState,'DATA_UNAVAILABLE');assert.equal(d.entryDecisions.length,0);
  }
});
test('history pagination failure cannot publish a partial success',async()=>{
  const x=fixture({pageFail:true}),r=await x.handler(request());
  assert.equal(r.status,503);assert.ok(!x.calls.some(c=>c.method==='POST'));
});
test('clock skew aborts before strategy or storage',async()=>{
  const x=fixture({clockSkew:5001});assert.equal((await x.handler(request())).status,503);
  assert.ok(!x.calls.some(c=>c.method==='POST'));
});
test('rate or regional denial has no retry and no alternate host',async()=>{
  for(const code of [418,429,451]){
    const x=fixture({marketError:code});assert.equal((await x.handler(request())).status,503);
    assert.equal(x.calls.filter(c=>c.url.includes('/klines')).length,1);
    assert.ok(!x.calls.some(c=>c.method==='POST'));
  }
});
test('duplicate minute preserves first immutable snapshot; failed storage is explicit',async()=>{
  const x=fixture({duplicate:true}),d=await (await x.handler(request())).json();assert.equal(d.persistedNew,false);
  const y=fixture({writeFail:true});assert.equal((await y.handler(request())).status,503);
});
test('storage denies client roles and refuses payloads with missing safety fields',async()=>{
  const module=process.env.PGLITE_MODULE;
  assert.ok(module,'PGLITE_MODULE must point to the pinned installed PGlite');
  const {PGlite}=await import(module),db=new PGlite();
  try{
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20260911112129_v18_strategy_shadow_observations.sql',import.meta.url),'utf8'));
    const acl=await db.query("select has_table_privilege('anon','v18_strategy_shadow_runs','SELECT') a, has_table_privilege('authenticated','v18_strategy_shadow_runs','INSERT') b");
    assert.deepEqual(acl.rows[0],{a:false,b:false});
    await assert.rejects(db.query("insert into v18_strategy_shadow_runs values ('x',now(),now(),'{}')"),/check constraint/);
    await db.query("insert into v18_strategy_shadow_runs values ('x',now(),now(),'{\"version\":\"x\",\"executionEnabled\":false,\"readOnlyTrading\":true}')");
    assert.equal((await db.query('select count(*)::int n from v18_strategy_shadow_runs')).rows[0].n,1);
  }finally{await db.close();}
});
