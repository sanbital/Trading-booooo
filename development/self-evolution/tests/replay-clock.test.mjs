import test from 'node:test';import assert from 'node:assert/strict';
import {receiptCutoffMs,quote,portfolioJob} from '../../../supabase/functions/self-evolution-worker/portfolio-jobs.mjs';
import {emptyPortfolio} from '../../../supabase/functions/_shared/self-evolution/portfolio.mjs';
test('microsecond receipts never appear before arrival',()=>{
 const base=Date.parse('2026-09-26T17:52:11.566Z');
 assert.equal(receiptCutoffMs('2026-09-26T17:52:11.566114Z'),base+1);
 assert.equal(receiptCutoffMs('2026-09-26T17:52:11.566000+00:00'),base);
 assert.equal(receiptCutoffMs('2026-09-26T17:52:11.999999Z'),base+434);
 assert.equal(receiptCutoffMs(base+.1),base+1);
 assert.throws(()=>receiptCutoffMs('invalid'),/INVALID_RECEIPT/);
 const q=quote({at:'2026-09-26T17:52:05Z',received_at:'2026-09-26T17:52:11.566114Z',payload:{}});
 assert.equal(q.received_at_ms,base+1);
});
test('portfolio restart consumes the remainder of one microsecond receipt batch exactly once',async()=>{
 const receipt='2026-09-20T00:03:11.566114Z',at=receiptCutoffMs(receipt);
 const capital={capital_usdt:332,margin_usdt:150,leverage:3,max_slots:10};
 const frames=['2026-09-20T00:03:00.000Z','2026-09-20T00:03:05.000Z'].map(t=>({symbol:'QUSDT',at:t,received_at:receipt,payload:{}}));
 const initial=emptyPortfolio(capital,at);initial.last_id='frame:QUSDT:'+frames[0].at;initial.events=1;
 const persisted=new Map(),bounds=[];
 const store={table(name){return {name,filters:{},select(){return this;},eq(k,v){this.filters[k]=v;return this;},gte(k,v){this.lower={k,v};return this;},lte(){return this;},in(){return this;},order(){return this;},limit(){return this;},single(){return this;},maybeSingle(){return this;}};},
  async read(q){
   if(q.name==='evolution_policy_bundles')return {version:q.filters.version,parent_version:'BASE',created_at:'2026-09-20T00:00:00Z'};
   if(q.name==='evolution_control')return {capital_manifest:capital};
   if(q.name==='evolution_portfolios')return q.filters.id?{state:persisted.get(q.filters.id)??initial}:[];
   if(q.name==='evolution_opportunities')return [{id:'admission-old',symbol:'QUSDT',at_ms:at-1000,context:{source:'MARKET',admission_eligible:false},packet:{}}];
   if(q.name==='evolution_market_frames'){bounds.push(Date.parse(q.lower.v));return Date.parse(q.lower.v)<=at-1?frames:[];}
   throw Error(q.name);
  },async write(name,row){assert.equal(name,'evolution_portfolios');persisted.set(row.id,row.state);}
 };
 await portfolioJob(store,'TEST',{});
 for(const value of persisted.values()){assert.equal(value.events,2);assert.equal(value.last_id,'frame:QUSDT:'+frames[1].at);assert.equal(value.last_ms,at);}
 assert.ok(persisted.size>=2);assert.ok(bounds.every(b=>b===at-1));
 await portfolioJob(store,'TEST',{});
 for(const value of persisted.values())assert.equal(value.events,2,'restart must not duplicate observations');
});
