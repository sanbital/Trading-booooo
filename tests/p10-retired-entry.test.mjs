import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

test('real P10 scan preserves accounting, snapshots and lock cleanup but never reads or claims entry signals',async()=>{
  const source=await readFile(new URL('../supabase/functions/market-autotrader/index.ts',import.meta.url),'utf8');
  const start=source.indexOf('async function p10ScanCycle('),end=source.indexOf('async function p10FetchJson(',start);
  assert.ok(start>=0&&end>start);
  const calls=[];
  const record=name=>async()=>{calls.push(name);return[];};
  const forbidden=()=>assert.fail('retired P10 entry path executed');
  const sandbox={performance,console,P10_STRATEGY_KEY:'unchanged-production-key',P10_REVISION:'unchanged-revision',
    P10_SCAN_PORTFOLIO_CONCURRENCY:3,
    enabledExchanges:()=>['binance_futures'],
    finite:(v,f=0)=>Number.isFinite(Number(v))?Number(v):f,
    clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),
    mapConcurrentOrdered:(items,fn)=>Promise.all(items.map(fn)),
    gateway:async()=>({positions:[],prices:{},available_quote:100,total_equity_quote:100}),
    managedPortfolio:async()=>({managed:{managedAvailableQuote:100,managedCapitalQuote:100,capitalBaseQuote:100}}),
    accountStats:async()=>({}),exchangeLimits:()=>({minOrder:5}),evaluateCircuit:()=>({allowNewEntry:true}),
    db:async path=>{calls.push(path);return path.startsWith('trading_asset_locks')?[{exchange:'binance_futures'}]:[];},
    untrackedFuturesExposures:()=>[],isP10Position:()=>true,
    reconcileFeeLedger:record('fees'),detectExternalQuoteFlow:record('external-flow'),
    snapshotAccount:record('snapshot'),recordJointObjectiveSnapshot:record('accounting'),
    openOrderAssets:record('open-orders'),reconcilePersistedAssetLocks:record('lock-reconciliation'),
    sweepResidualInventory:record('cleanup'),patchTradingHeartbeat:record('heartbeat'),
    event:record('event'),loadP10Signals:forbidden,enterP10Signal:forbidden,
  };
  const fn=vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start,end))};p10ScanCycle`,sandbox);
  const result=await fn('isolated-cycle',{mode:'LIVE_LIMITED',scalp_position_slots:3,residual_sweep_enabled:true});
  assert.equal(result.reason,'P10_ENTRY_PATH_RETIRED');assert.equal(result.maintenance.errors.length,0);
  for(const expected of ['fees','snapshot','accounting','open-orders','lock-reconciliation','cleanup','heartbeat']) {
    assert.ok(calls.includes(expected),expected+' must remain active');
  }
  assert.equal(calls.some(x=>x.includes('v2_live_signals')),false);
});
