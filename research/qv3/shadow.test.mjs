import test from 'node:test';import assert from 'node:assert/strict';
import {createHandler,SHADOW_VERSION} from '../../supabase/functions/qv3-entry-exit-shadow/handler.mjs';
const at=Date.parse('2026-09-11T14:15:20Z'),cut5=Math.floor(at/300000)*300000,cut15=Math.floor(at/900000)*900000;
const k=(t,o,c,m)=>[t,o,Math.max(o,c)+1,Math.min(o,c)-1,c,1,t+m-1,100,10,50,50];
function fixture({circuit=true,missing=false,duplicate=false,dbFail=false,marketFail=false}={}){
 const calls=[],writes=[];
 const feature={symbol:'4USDT',rank:1,dayReturn:.1,qv24:1e8,return15m:.01,return30m:.02,return60m:.03,volumeRatio:2,atr:1,signal15Close:cut15};
 const tables={edge_internal_tokens:[{token:'fixture-token'}],v17_market_scan_runs:[{id:1,captured_at:new Date(cut5).toISOString(),signal_close_at:new Date(cut15).toISOString(),coverage:1,details:{blocked:null,top10:[feature]}}],
 v11_long_regime_positions:[],v11_long_regime_orders:[],v18_strategy_shadow_runs:[],trading_asset_locks:[],
 trading_account_snapshots:[{captured_at:new Date(cut5).toISOString(),available_quote:100,positions_complete:true,positions:[]}],
 v11_long_regime_runtime:[{live_enabled:true,circuit_open:circuit}],v17_operator_control:[{entry_enabled:true,legacy_entries_retired:true}],
 trading_settings:[{mode:'LIVE_LIMITED',binance_futures_leverage:3,binance_futures_allocation_usdt:40}]};
 const fetchFn=async(url,init)=>{
  const u=new URL(url);calls.push({url,method:init.method});let result;
  if(u.hostname==='etaajwpernzrcdrifdnw.supabase.co'){
   const table=u.pathname.split('/').at(-1);
   assert.ok(Object.hasOwn(tables,table));
   if(init.method==='POST'){assert.equal(table,'v18_strategy_shadow_runs');const row=JSON.parse(init.body);writes.push(row);if(dbFail)return new Response('{}',{status:503});result=duplicate?[]:[row];}
   else{assert.equal(init.method,'GET');result=tables[table];}
  }else{
   assert.equal(u.hostname,'fapi.binance.com');assert.equal(init.method,'GET');
   if(marketFail)return new Response('{}',{status:429});
   if(u.pathname.endsWith('/time'))result={serverTime:at};
   else if(u.pathname.endsWith('/bookTicker'))result={bidPrice:104.19,askPrice:104.2};
   else if(u.pathname.endsWith('/klines')){
    if(u.searchParams.get('interval')==='5m')result=Array.from({length:14},(_,i)=>k(cut5-(14-i)*300000,100+i*.3,100+(i+1)*.3,300000));
    else result=missing?[]:[k(cut5-180000,104,103,60000),k(cut5-120000,103,102,60000),k(cut5-60000,102,101,60000)];
   }else throw Error('UNEXPECTED_PUBLIC_PATH');
  }
  return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
 };
 const handler=createHandler({url:'https://etaajwpernzrcdrifdnw.supabase.co',key:'fixture-not-secret',fetchFn,now:()=>at});
 const run=(body={mode:'evaluate'},token='fixture-token')=>handler(new Request('https://fixture',{method:'POST',headers:{'x-v16-diagnostic-token':token},body:JSON.stringify(body)}));
 return {run,calls,writes,tables};
}
test('shadow evaluates exact ENTRY_EXIT_TWO while real circuit remains blocked',async()=>{
 const h=fixture(),r=await h.run(),d=await r.json();assert.equal(r.status,200);assert.equal(d.evaluationState,'EVALUATED');assert.equal(d.entryDecisions.length,1);
 assert.equal(d.entryDecisions[0].qv3.wouldBlock,true);assert.equal(d.executionEnabled,false);assert.equal(d.livePromotion,false);assert.ok(d.liveBlocks.includes('RUNTIME_OR_CIRCUIT_BLOCK'));
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].policy_version,SHADOW_VERSION);
});
test('shadow cannot accept arbitrary actions, activation or other candidates',async()=>{
 for(const body of [{mode:'run'},{mode:'evaluate',activate:true},{mode:'evaluate',variant:'EXIT_ONE'}]){const h=fixture();assert.equal((await h.run(body)).status,400);assert.equal(h.writes.length,0);}
});
test('authentication failure causes no market reads or writes',async()=>{
 const h=fixture();assert.equal((await h.run({mode:'evaluate'},'wrong')).status,401);assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);
});
test('missing candles remain data unavailable, never a normal pass',async()=>{
 const h=fixture({missing:true}),d=await(await h.run()).json();assert.equal(d.evaluationState,'DATA_UNAVAILABLE');assert.equal(d.entryDecisions[0].qv3.available,false);
});
test('duplicate slot does not claim newly persisted independent observation',async()=>{
 const h=fixture({duplicate:true}),d=await(await h.run()).json();assert.equal(d.persistedNew,false);
});
test('DB delay/failure cannot report successful durable shadow write',async()=>{
 const h=fixture({dbFail:true});assert.equal((await h.run()).status,503);
});
test('rate limit stops collection without retries or alternate hosts',async()=>{
 const h=fixture({marketFail:true});assert.equal((await h.run()).status,503);assert.equal(h.calls.filter(x=>x.url.includes('fapi.binance.com')).length,1);assert.equal(h.writes.length,0);
});
