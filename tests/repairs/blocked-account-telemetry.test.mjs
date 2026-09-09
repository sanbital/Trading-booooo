import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('supabase/functions/market-autotrader/index.ts','utf8');
const helper=source.split('// BEGIN BLOCKED_ACCOUNT_TELEMETRY_20260908')[1].split('// END BLOCKED_ACCOUNT_TELEMETRY_20260908')[0];
const factory=new Function('portfolioExchanges','portfolios','portfolioCapturedAt','maintenancePositions','settings','snapshotAccount','authenticatedFuturesSnapshot',helper+'\nreturn persistBlockedAccountSnapshots;');
const at='2026-01-01T00:00:00.000Z';
const raw=()=>({total_equity_quote:100,available_quote:60,locked_quote:40,accounts:[],positions:[]});
function setup(portfolios,{writer,positions=[]}={}) {
  const calls=[];const settings=Object.freeze({pause_new_entries:true,mode:'LIVE_LIMITED'});
  const venues=Object.keys(portfolios);
  const fn=factory(venues,portfolios,Object.fromEntries(venues.map(x=>[x,at])),positions,settings,async(...args)=>{calls.push(args);if(writer)await writer(...args);},(_exchange,p)=>({complete:Array.isArray(p.positions)&&p.positions.every(x=>x.market&&['LONG','SHORT'].includes(x.side)&&x.quantity>0)}));
  return {fn,calls,settings};
}
test('paused scans still save valid account observations',async()=>{const x=setup({binance:raw(),binance_futures:raw()});assert.deepEqual(await x.fn(),[]);assert.equal(x.calls.length,2);assert.equal(x.settings.pause_new_entries,true);});
test('untracked futures exposure is retained, never converted to zero',async()=>{const p=raw();p.positions=[{market:'TESTUSDT',side:'LONG',quantity:7}];const x=setup({binance_futures:p});await x.fn();assert.equal(x.calls[0][1].positions[0].quantity,7);});
test('missing portfolio cannot generate a zero-account snapshot',async()=>{const x=setup({binance_futures:null});assert.equal((await x.fn()).length,1);assert.equal(x.calls.length,0);});
test('a malformed futures position blocks only its own snapshot',async()=>{const p=raw();p.positions=[{market:'TESTUSDT',side:'LONG',quantity:0}];const x=setup({binance:raw(),binance_futures:p});assert.equal((await x.fn()).length,1);assert.equal(x.calls.length,1);assert.equal(x.calls[0][0],'binance');});
test('valid empty position list is accepted',async()=>{const x=setup({binance_futures:raw()});assert.deepEqual(await x.fn(),[]);assert.deepEqual(x.calls[0][1].positions,[]);});
test('snapshot failure is reported rather than escaping the entry safety branch',async()=>{const x=setup({binance:raw(),binance_futures:raw()},{writer:async(e)=>{if(e==='binance_futures')throw Error('WRITE_FAILED');}});const errors=await x.fn();assert.equal(errors.length,1);assert.equal(errors[0].error,'WRITE_FAILED');assert.equal(x.calls.length,2);});
test('original capture time and open-position subset are preserved',async()=>{const x=setup({binance_futures:raw()},{positions:[{state:'OPEN',id:1},{state:'CLOSED',id:2}]});await x.fn();assert.equal(x.calls[0][5],at);assert.deepEqual(x.calls[0][2],[{state:'OPEN',id:1}]);});
test('missing monetary values are not fabricated as zero',async()=>{for(const bad of [null,'',false,NaN]){const p=raw();p.available_quote=bad;const x=setup({binance_futures:p});assert.equal((await x.fn()).length,1);assert.equal(x.calls.length,0);}});
test('both entry safety branches keep their latch and return',()=>{for(const [begin,end] of [['  if (futuresObservationError) {','  const futuresPortfolio ='],['  if (untrackedFutures.length) {','  const snapshotPositions =']]){const b=source.split(begin)[1].split(end)[0];assert.ok(b.indexOf('await latchP10EntrySafety')<b.indexOf('await persistBlockedAccountSnapshots'));assert.ok(b.includes('skipped: true'));assert.ok(b.includes('reason: safetyReason'));assert.equal((b.match(/await persistBlockedAccountSnapshots/g)||[]).length,1);assert.ok(!b.includes('create_order'));}});
