import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {untrackedFuturesExposures} from '../../supabase/functions/market-autotrader/p10-entry-reconciliation.ts';
const position={market:'GTCUSDT',side:'LONG',quantity:1944.6};
const lock={exchange:'binance_futures',asset:'GTC',state:'LOCKED',metadata:{v17ManualPosition:true,side:'LONG',maxQuantity:1944.6}};
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
