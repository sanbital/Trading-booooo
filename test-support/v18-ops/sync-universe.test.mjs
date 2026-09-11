import test from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../../supabase/functions/exchange-trade-sync/futures-sync.ts';

test('closed V17 and pending entry symbols remain collectable when portfolio and legacy tables are empty',()=>{
  const result=sync.futuresMarketUniverse({portfolioPositions:[],orders:[],positions:[],syncStates:[],
    leaderPositions:[{symbol:'PIEVERSEUSDT'},{symbol:'BIRBUSDT'},{symbol:'哈基米USDT'}],leaderOrders:[{symbol:'牛来USDT'},{symbol:'BIRBUSDT'}]});
  assert.deepEqual(new Set(result),new Set(['PIEVERSEUSDT','BIRBUSDT','哈基米USDT','牛来USDT']));
});

function fakeDb(rows,failTable=null){const reads=[];return {reads,from(table){return {
  select(columns){assert.equal(columns,'id,symbol');return this;},
  order(key,{ascending}){assert.equal(key,'id');assert.equal(ascending,true);return this;},
  async range(start,end){reads.push({table,start,end});return table===failTable?{error:{message:'READ_FAILED'},data:null}:{error:null,data:rows[table].slice(start,end+1)};},
};}};}

test('V17 market sources use explicit pagination beyond PostgREST response limits',async()=>{
  const positions=Array.from({length:1001},(_,i)=>({id:String(i).padStart(5,'0'),symbol:`COIN${i}USDT`}));
  const db=fakeDb({v11_long_regime_positions:positions,v11_long_regime_orders:[{id:'pending',symbol:'NEWUSDT'}]});
  const r=await sync.readLeaderMarketRows(db);
  assert.equal(r.leaderPositions.length,1001);assert.equal(r.leaderOrders.length,1);
  assert.deepEqual(db.reads.filter(x=>x.table==='v11_long_regime_positions').map(x=>[x.start,x.end]),[[0,499],[500,999],[1000,1499]]);
});

test('collection-source errors fail explicitly instead of claiming complete coverage',async()=>{
  const db=fakeDb({v11_long_regime_positions:[],v11_long_regime_orders:[]},'v11_long_regime_positions');
  await assert.rejects(()=>sync.readLeaderMarketRows(db),/LEADER_MARKETS.*READ_FAILED/);
});
