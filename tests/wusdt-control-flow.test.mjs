import * as leader20LegacyBindings from '../test-support/leader20-legacy-bindings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import * as b from '../supabase/functions/_shared/leader-b06133-entry.mjs';
import * as c from '../supabase/functions/_shared/leader-cec0040.mjs';
import * as front from '../supabase/functions/_shared/gpt-final-review/contract.mjs';
import * as lifecycle from '../supabase/functions/v10-lane-executor/entry-lifecycle.mjs';
const source=readFileSync(new URL('../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const historical=JSON.parse(readFileSync(new URL('./fixtures/wusdt-signals-20260927.json',import.meta.url))).signals;
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const dir=new URL('../supabase/migrations/',import.meta.url),read=f=>readFileSync(new URL(f,dir),'utf8');
const before=readFileSync(new URL('./fixtures/cec0040-production-before.sql',import.meta.url),'utf8');
const patch=read(readdirSync(dir).find(f=>f.endsWith('_wusdt_symbol_lifecycle.sql')));
const pg=new PGlite();
await pg.exec(`create role anon;create role authenticated;create role service_role;
 create table v11_long_regime_signals(id uuid primary key);
 create table v11_long_regime_positions(id uuid primary key,signal_id uuid,entry_at timestamptz,entry_price numeric);`);
await pg.exec(read('20260920114124_cec0040_operational_state.sql'));
await pg.exec(read('20260924041645_cec0040_tables_accept_v30_branch.sql'));
await pg.exec(before);
await pg.exec('update v11_cec0040_state set bootstrap_complete=true,enforcement_enabled=true');
// Deliberately synthetic completed candles: only control flow is under test. No price,
// profit or historical controller-state reconstruction is claimed.
function candles(url){const u=new URL(url),q=u.searchParams,step=q.get('interval')==='1m'?60000:900000;
 return Array.from({length:Number(q.get('limit'))},(_,i)=>{const t=Number(q.get('startTime'))+i*step;
  return [t,'1','1.2','.9',String(1+i*.001),'100',t+step-1,'100',10,'30','30']});}
function harness(original,{old=false,fail=null}={}){
 const row=structuredClone(original);row.status='NEW';row.reject_reason=null;delete row.features.b06133;delete row.features.cec0040;
 const at=row.features.v17Setup.triggerAt+9000,audits=[],requests=[];
 const db={rpc:async(name,p)=>{if(fail)return {error:{message:fail}};try{return {data:(await pg.query('select v11_cec0040_decide($1,$2,$3,$4,$5) d',[p.p_signal_id,p.p_decision_at,p.p_symbol,p.p_branch,p.p_bootstrap])).rows[0].d}}catch(e){return {error:{message:e.message}}}},
  from:name=>{let patch;const q={update:x=>(patch=x,q),eq:()=>q,in:()=>q,select:()=>q,
   maybeSingle:async()=>{Object.assign(row,patch);return {data:structuredClone(row)}},
   insert:async x=>{audits.push(x);return {}},then:(resolve,reject)=>{if(patch)Object.assign(row,patch);return Promise.resolve({}).then(resolve,reject)}};return q}};
 const fetchFn=async url=>{requests.push(url);return Response.json(candles(url))};
 const ctx={...b,...c,...front,...lifecycle,console,Date:class extends Date{static now(){return at}},Number,String,Error,
  rec:x=>x??{},REVISION:'test',PATCH:'test',verifyExecutionLease:async()=>{},audit:async(...x)=>audits.push(x),
  fetchB06133Inputs:old?async symbol=>{assert.equal(symbol,'WUSDT');throw Error('B06133_MARKET_INPUT')}:((s,t)=>b.fetchB06133Inputs(s,t,fetchFn))};
 Object.assign(ctx,leader20LegacyBindings);vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('async function noteEntryLifecycle('),source.indexOf('/**\n * Terminal accounting')),ctx);
 vm.runInContext(source.slice(source.indexOf('async function applyB06133Selection('),source.indexOf('async function registerCec0040Target(')),ctx);
 return {row,ctx,db,requests,audits};
}
for(const original of historical)test('historical '+original.id+' before -> after reaches GPT boundary without orders',async()=>{
 await pg.exec(before);await pg.query('insert into v11_long_regime_signals values($1)',[original.id]);
 const pre=harness(original,{old:true});const selected=await pre.ctx.applyB06133Selection(pre.db,pre.row,pre.row.features.v17Setup);
 assert.equal(selected.row.features.b06133.error,'B06133_MARKET_INPUT');assert.equal(pre.requests.length,0);
 await assert.rejects(()=>pre.ctx.applyCec0040Selection(pre.db,selected.row,pre.row.features.v17Setup),/CEC0040_DECISION_INPUT_INVALID/);
 await pg.exec(patch);const post=harness(original);const evidence=await post.ctx.applyB06133Selection(post.db,post.row,post.row.features.v17Setup);
 assert.equal(post.requests.length,2);assert.equal(evidence.row.features.b06133.source.prebars.length,3);
 assert.equal(evidence.row.features.b06133.source.btcBars.length,9);
 const controlled=await post.ctx.applyCec0040Selection(post.db,evidence.row,post.row.features.v17Setup);
 assert.equal(controlled.allowed,true);assert.equal(controlled.stamp.ready,true);
 // The real queue regression separately proves executable rows go to gptFilterExecutable.
 assert.equal(controlled.row.symbol,'WUSDT');assert.equal(controlled.row.status,'NEW');
});
test('RPC failure persisted by actual executor helper survives later note and expiry',async()=>{
 const h=harness(historical[0],{fail:'CEC0040_DECISION_INPUT_INVALID'});
 const selected=await h.ctx.applyB06133Selection(h.db,h.row,h.row.features.v17Setup);
 let error;try{await h.ctx.applyCec0040Selection(h.db,selected.row,h.row.features.v17Setup)}catch(e){error=e}
 const recorded=await h.ctx.recordEntryTechnicalFailure(h.db,selected.row,'CEC0040',error);
 await h.ctx.noteEntryLifecycle(h.db,recorded,lifecycle.lifecycleNote({at:Date.now(),stage:'QUEUE',reason:'WAIT'}));
 assert.equal(h.row.features.entryLifecycle.technicalFailure.root.code,'CEC0040_DECISION_INPUT_INVALID');
 assert.equal(lifecycle.expiredTriggerReason(h.row.features.entryLifecycle),'STALE:TRIGGER_WINDOW_CLOSED');
 const event=h.audits.find(x=>x.details?.kind==='TECHNICAL_ERROR');assert.equal(event.details.stage,'CEC0040');
 assert.equal(event.details.lifecycle.technicalFailure.latest.gptAttempted,false);assert.equal(event.details.orderDispatched,false);
 assert.ok(JSON.stringify(event).length<2500);
});
test.after(()=>pg.close());
