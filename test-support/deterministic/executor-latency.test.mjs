import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateModule,mockDb} from './harness.mjs';
const flat=()=>({positions:[],manual:[],orders:[],quarantines:[],match:{ok:true,safe:[],issues:[],accounting:[]},pf:{observation:{requested_at_ms:Date.now()}}});
const short=(h,db)=>{h.value('shortWriterModes').set(db,true);};
test('healthy flat cycle takes no recovery writer and keeps a fresh final account read',async()=>{
 const h=await evaluateModule(),db={},pair=flat();short(h,db);let writers=0,reads=0,entries=0,telemetry=0;
 h.ctx.withAccountMutation=async()=>{writers++;assert.fail('idle recovery acquired a writer');};
 h.ctx.verifyExecutionLease=async()=>{};h.ctx.readOpsPair=async()=>{reads++;return structuredClone(pair);};
 h.ctx.opsControls=async()=>({runtime:{circuit_open:false},control:{},settings:{}});
 h.ctx.operatorAllowsRecovery=()=>true;h.ctx.readClosedProtectionBacklog=async()=>({rows:[],complete:true});
 h.ctx.runEntryQueue=async()=>{entries++;return {entered:false,reason:'NO_DETERMINISTIC_BUY'};};
 h.ctx.writeRuntimeTelemetry=async()=>{telemetry++;};
 const result=await h.ctx.run(db);
 assert.equal(writers,0);assert.equal(reads,2);assert.equal(entries,1);assert.equal(telemetry,1);assert.equal(result.protectionHealth,'FLAT');
});
test('recovered account skips a writer; restart recovery rereads readiness inside the writer',async()=>{
 let ready=true;const {db}=mockDb(q=>{assert.equal(q.rpc,'v17_account_recovery_state');return {data:{ready,postmaster_at:'fixture'}};}),h=await evaluateModule();short(h,db);let writers=0,readInside=false;
 h.ctx.withAccountMutation=async(client,operation)=>{writers++;ready=true;readInside=true;return operation();};
 assert.equal(await h.ctx.ensureShortWriterRecovery(db),true);assert.equal(writers,0);
 ready=false;assert.equal(await h.ctx.ensureShortWriterRecovery(db),true);assert.equal(writers,1);assert.equal(readInside,true);
});
test('held-position management retains priority and account refreshes around reconciliation',async()=>{
 const h=await evaluateModule(),db={},pair=flat(),events=[];pair.positions=[{id:'held',symbol:'TESTUSDT',metadata:{}}];pair.match.safe=pair.positions;
 h.ctx.verifyExecutionLease=async()=>{};h.ctx.readOpsPair=async()=>{events.push('read');return structuredClone(pair);};h.ctx.recordMismatch=async()=>[];
 h.ctx.opsControls=async()=>({runtime:{circuit_open:false},control:{},settings:{}});h.ctx.scopedGateway=()=>()=>{};
 h.ctx.manageLeader=async()=>{events.push('manage');return{};};h.ctx.reconcileOps=async()=>{events.push('reconcile');return [{positionId:'held'}];};
 h.ctx.attemptSymbolRecoveries=async()=>[];h.ctx.attemptOpsRecovery=async()=>({resolved:false});h.ctx.operatorAllowsRecovery=()=>true;
 h.ctx.readClosedProtectionBacklog=async()=>({rows:[],complete:true});h.ctx.runEntryQueue=async()=>{events.push('entry');return {entered:false,reason:'NO_DETERMINISTIC_BUY'};};h.ctx.writeRuntimeTelemetry=async()=>{};
 await h.ctx.run(db);assert.equal(events.filter(e=>e==='read').length,5);assert.ok(events.indexOf('manage')<events.indexOf('reconcile'));assert.ok(events.indexOf('reconcile')<events.indexOf('entry'));assert.equal(events.at(-1),'read');
});
test('failed recovery readiness cannot enter a writer or entry body',async()=>{
 const {db}=mockDb(()=>({error:{code:'544'}})),h=await evaluateModule();short(h,db);
 h.ctx.withAccountMutation=()=>assert.fail('unproven readiness acquired writer');h.ctx.runEntryQueue=()=>assert.fail('unproven readiness entered');
 await assert.rejects(()=>h.ctx.ensureShortWriterRecovery(db),/ACCOUNT_RECOVERY_READINESS_UNAVAILABLE/);
});
test('unknown orders, affected positions and closed protection all retain fenced fresh reconciliation',async()=>{
 for(const type of ['UNKNOWN','POSITION','CLOSED']){
  const h=await evaluateModule(),db={},pair=flat();short(h,db);let writers=0,refreshes=0;
  if(type==='UNKNOWN')pair.orders=[{id:'order',state:'UNKNOWN'}];
  if(type==='POSITION'){pair.positions=[{id:'position'}];pair.match.issues=[{positionId:'position'}];}
  h.ctx.readClosedProtectionBacklog=async()=>({rows:type==='CLOSED'?[{id:'closed'}]:[],complete:true});
  h.ctx.readOpsPair=async()=>{refreshes++;return pair;};h.ctx.scopedGateway=()=>()=>assert.fail('zero budget sent command');
  h.ctx.withAccountMutation=async(client,operation)=>{writers++;h.ctx.currentAccountOwner=()=> 'fixture-writer';return operation();};
  await h.ctx.reconcileOps(db,pair,{remaining:()=>0});assert.equal(writers,1,type);assert.equal(refreshes,1,type);
 }
});
test('new account incident is reread after writer admission; cleared incident cannot mutate recovery',async()=>{
 const h=await evaluateModule(),db={},pair=flat();short(h,db);let writers=0,controls=0,refreshes=0;
 h.ctx.opsControls=async()=>({runtime:{circuit_open:++controls===1},settings:{},control:{}});
 h.ctx.readOpsPair=async()=>{refreshes++;return pair;};
 h.ctx.withAccountMutation=async(client,operation)=>{writers++;h.ctx.currentAccountOwner=()=> 'fixture-writer';return operation();};
 h.ctx.opsGateway=()=>()=>assert.fail('cleared incident fetched venue orders');
 const result=await h.ctx.attemptOpsRecovery(db,pair,new Set());assert.equal(result.resolved,false);assert.equal(writers,1);assert.equal(controls,2);assert.equal(refreshes,1);
});
test('account DB and signed venue reads overlap but orders retain the current position manifest',async()=>{
 const h=await evaluateModule(),events=[];let venueStarted=false,release;const venue=new Promise(r=>{release=r;});
 const {db}=mockDb(q=>{events.push(q.table);if(q.table==='v18_ops_incidents'){assert.equal(venueStarted,true);release({positions_complete:true,positions:[]});}return {data:[]};});
 h.ctx.readOpsPositions=async()=>{assert.equal(venueStarted,true);events.push('positions');return [{id:'manifest'}];};
 h.ctx.manualPositionAllowances=async()=>[];h.ctx.readOpsOrders=async(client,positions)=>{assert.equal(positions[0].id,'manifest');events.push('orders');return[];};
 h.ctx.classifyPortfolio=()=>({ok:true});
 const gw=async()=>{venueStarted=true;events.push('venue');return venue;};
 await h.ctx.readOpsPair(db,gw);assert.ok(events.indexOf('venue')<events.indexOf('orders'));
});
test('parallel account DB failures fail closed and never make a venue mutation',async()=>{
 const h=await evaluateModule(),{db}=mockDb(q=>({error:{code:'UNAVAILABLE'}}));let actions=[];
 h.ctx.readOpsPositions=async()=>[];h.ctx.manualPositionAllowances=async()=>[];h.ctx.readOpsOrders=async()=>[];
 await assert.rejects(()=>h.ctx.readOpsPair(db,async command=>{actions.push(command.action);return{};}),/SYMBOL_QUARANTINE_READ/);
 assert.deepEqual(actions,['p10_portfolio']);
});
