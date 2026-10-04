import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {confirmedManualProtectiveOrder,confirmedLiveProtection} from '../../supabase/functions/_shared/leader-ops-isolation.mjs';
import {untrackedFuturesExposures} from '../../supabase/functions/market-autotrader/p10-entry-reconciliation.ts';
const position={market:'GTCUSDT',side:'LONG',quantity:1944.6};
const lock={exchange:'binance_futures',asset:'GTC',state:'LOCKED',metadata:{v17ManualPosition:true,side:'LONG',maxQuantity:1944.6}};
const allowance={symbol:'GTCUSDT',side:'LONG',maxQuantity:1944.6};
const protective={symbol:'GTCUSDT',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',algoStatus:'NEW',algoId:'123',clientAlgoId:'manual-stop',triggerPrice:'0.11',closePosition:true,quantity:'0'};
test('only bounded protective orders on confirmed manual inventory permit recovery',()=>{
 const check=o=>confirmedManualProtectiveOrder(o,[allowance],[position]);
 assert.equal(check(protective),true);assert.equal(check({...protective,closePosition:false,reduceOnly:true,quantity:1944.6}),true);
 for(const o of [{...protective,side:'BUY'},{...protective,symbol:'AKTUSDT'},
   {...protective,closePosition:false,reduceOnly:false,quantity:1944.6},
   {...protective,closePosition:false,reduceOnly:true,quantity:1944.7},
   {...protective,clientAlgoId:'tb-v11-stop'}, {...protective,algoStatus:'UNKNOWN'}])assert.equal(check(o),false);
 assert.equal(confirmedManualProtectiveOrder(protective,[],[position]),false);
 assert.equal(confirmedManualProtectiveOrder(protective,[allowance],[{...position,quantity:2000}]),false);
 assert.equal(confirmedManualProtectiveOrder(protective,[allowance],[position],[{symbol:'GTCUSDT'}]),false);
 const now=Date.now(),live={complete:true,orders:[],algos:[protective],observed_at_ms:now};
 assert.equal(confirmedLiveProtection(live,[],now),false);
 assert.equal(confirmedLiveProtection(live,[],now,{manual:[allowance],exchangePositions:[position]}),true);
 assert.equal(confirmedLiveProtection({...live,orders:[{side:'BUY'}]},[],now,{manual:[allowance],exchangePositions:[position]}),false);
});
test('confirmed manual holding and partial reduction do not become unexplained bot inventory',()=>{
  assert.deepEqual(untrackedFuturesExposures([position],[],[lock]),[]);
  assert.deepEqual(untrackedFuturesExposures([{...position,quantity:100}],[],[lock]),[]);
  assert.deepEqual(untrackedFuturesExposures([position],[]),[position]);
});
test('manual allowance refuses increase, reversal, another asset, released and malformed records',()=>{
  for(const p of [{...position,quantity:1944.7},{...position,side:'SHORT'},{...position,market:'AKTUSDT'}])
    assert.deepEqual(untrackedFuturesExposures([p],[],[lock]),[p]);
  for(const l of [{...lock,state:'RELEASED'},{...lock,exchange:'binance'},
    {...lock,metadata:{...lock.metadata,v17ManualPosition:'true'}},
    ...[null,0,-1,'Infinity','bad'].map(maxQuantity=>({...lock,metadata:{...lock.metadata,maxQuantity}}))])
    assert.deepEqual(untrackedFuturesExposures([position],[],[l]),[position]);
  assert.deepEqual(untrackedFuturesExposures([position],[],[lock,lock]),[position]);
});
test('manual allowance cannot mask increased bot inventory or an unknown second holding',()=>{
  const tracked={...position,quantity:100};
  assert.deepEqual(untrackedFuturesExposures([position],[tracked],[lock]),
    [{...position,tracked_quantity:100,unmatched_quantity:1844.6}]);
  const foreign={market:'AKTUSDT',side:'LONG',quantity:2};
  assert.deepEqual(untrackedFuturesExposures([position,foreign],[],[lock]),[foreign]);
});
test('real maintenance keeps a held manual lock and requires complete flat evidence to clean it',async()=>{
  const source=readFileSync(new URL('../../supabase/functions/market-autotrader/index.ts',import.meta.url),'utf8');
  const start=source.indexOf('async function reconcilePersistedAssetLocks(');
  const end=source.indexOf('\nasync function ',start+1);
  const fn=stripTypeScriptTypes(source.slice(start,end));
  for(const [portfolio,orders,status] of [
    [{positions_complete:true,positions:[position]},new Set(),'MISMATCH'],
    [{positions_complete:true,positions:[{...position,quantity:100}]},new Set(),'MISMATCH'],
    [{positions_complete:true,positions:[]},new Set(),'CLEAN'],
    [{positions_complete:false,positions:[]},new Set(),'QUERY_FAILED'],
    [{positions_complete:true,positions:[]},null,'QUERY_FAILED']]){
    const checks=[];
    const run=new Function('db','rpc','finite',fn+';return reconcilePersistedAssetLocks;')(
      async()=>[lock],async(name,args)=>checks.push({name,args}),value=>Number(value)||0);
    await run('binance_futures',portfolio,[],orders,'test');
    assert.equal(checks.length,1);assert.equal(checks[0].args.p_status,status);
  }
});
