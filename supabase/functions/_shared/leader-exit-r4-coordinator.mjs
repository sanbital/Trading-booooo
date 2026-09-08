/** Dependency-injected integration layer. No credentials, transport, startup,
 * schedule changes or I/O on import. Tests supply a simulated broker only.
 * Store CAS must atomically persist decision state, accounting and the outbox.
 * broker snapshots must contain exact cumulative fills including commissions.
 */
import {R4_CANDIDATE,newR4State,nextR4Exit,restoreR4State,r4PolicyKey} from './leader-exit-r4.mjs';
const clone=x=>structuredClone(x),terminal=new Set(['FILLED','CANCELED','EXPIRED','REJECTED']);
const tolerance=1e-7;
const sum=a=>a.reduce((s,x)=>s+x,0);
async function stableId(positionId,leg,generation){
 const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([positionId,leg,generation])));
 return 'tb-r4-'+Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('').slice(0,28);
}
export function newR4Journal(position,policy=R4_CANDIDATE){
 if(position.strategy!=='LEADER_MOMENTUM_V17'||position.side!=='LONG'||position.manual===true||
   !position.symbol||!Number.isFinite(position.remainingQuantity)||position.remainingQuantity!==position.quantity)
   throw Error('R4_REQUIRES_EXCLUSIVELY_OWNED_UNREDUCED_V17_LONG');
 const engine=newR4State(position,policy);
 return {revision:0,positionId:position.positionId,symbol:position.symbol,policy:{...policy},engine,
   entryPrice:position.entryPrice,quantityStep:position.quantityStep,originalQuantity:position.quantity,
   legs:{risk:{allocated:engine.riskQuantity,filled:0,requested:false,generation:0},
     runner:{allocated:engine.runnerQuantity,filled:0,requested:false,generation:0}},
   remainingQuantity:position.quantity,realizedPnl:-position.entryFee,exitQuote:0,state:'OPEN',outbox:[],
   protectionIds:[],nativeReceipts:[],health:'INITIALIZED',updatedAt:position.entryAt};
}
function remaining(j,leg){return Math.max(0,j.legs[leg].allocated-j.legs[leg].filled);}
function checkUnits(quantity,step){return Number.isFinite(quantity)&&quantity>=0&&Math.abs(quantity/step-Math.round(quantity/step))<1e-6;}
function reconcileTotals(j){
 j.remainingQuantity=Math.max(0,sum(Object.values(j.legs).map(x=>x.allocated-x.filled)));
 j.state=j.remainingQuantity<=tolerance?'CLOSED':'OPEN';
}
async function plan(j,leg,reason,at,maxAttempts){
 const l=j.legs[leg],quantity=remaining(j,leg);
 if(quantity<=tolerance||j.outbox.some(x=>x.leg===leg&&!x.terminal))return;
 if(l.generation>=maxAttempts){j.health='RETRY_LIMIT';return;}
 const generation=++l.generation,clientId=await stableId(j.positionId,leg,generation);
 j.outbox.push({clientId,leg,generation,reason,at,quantity,status:'PLANNED',terminal:false,
   appliedQuantity:0,appliedQuote:0,appliedCommission:0});
}
function accountOrder(j,snapshot){
 const order=j.outbox.find(x=>x.clientId===snapshot.clientId);
 if(!order)throw Error('UNKNOWN_ORDER_RECEIPT');
 if(snapshot.exact!==true||snapshot.commissionComplete!==true)throw Error('FILL_ACCOUNTING_INCOMPLETE');
 if(snapshot.symbol!==j.symbol||snapshot.side!=='SELL'||snapshot.reduceOnly!==true||snapshot.requestedQuantity!==order.quantity)
   throw Error('ORDER_IDENTITY_MISMATCH');
 const q=snapshot.filledQuantity,f=snapshot.cumulativeQuote,c=snapshot.commissionQuote;
 if(!checkUnits(q,j.quantityStep)||!Number.isFinite(f)||f<0||!Number.isFinite(c)||q>order.quantity+tolerance||q<order.appliedQuantity-tolerance)
   throw Error('INVALID_CUMULATIVE_FILL');
 if(!['NEW','PARTIALLY_FILLED',...terminal].includes(snapshot.status))throw Error('UNKNOWN_ORDER_STATUS');
 if(snapshot.status==='FILLED'&&Math.abs(q-order.quantity)>tolerance)throw Error('FALSE_FILLED_STATUS');
 const dq=q-order.appliedQuantity,df=f-order.appliedQuote,dc=c-order.appliedCommission;
 if(dq>remaining(j,order.leg)+tolerance||df< -tolerance||(q===0&&f!==0))throw Error('FILL_ACCOUNTING_MISMATCH');
 j.legs[order.leg].filled+=dq;j.realizedPnl+=df-j.entryPrice*dq-dc;j.exitQuote+=df;
 if(Number.isFinite(snapshot.lastFillAt))j.lastFillAt=Math.max(j.lastFillAt??0,snapshot.lastFillAt);
 Object.assign(order,{status:snapshot.status,terminal:terminal.has(snapshot.status),appliedQuantity:q,
   appliedQuote:f,appliedCommission:c,exchangeOrderId:snapshot.exchangeOrderId??order.exchangeOrderId});
 reconcileTotals(j);
}
function accountNative(j,fill){
 if(!j.protectionIds.includes(fill.clientId)||fill.symbol!==j.symbol||fill.side!=='SELL'||fill.reduceOnly!==true||
   fill.exact!==true||typeof fill.tradeId!=='string'||!fill.tradeId||!checkUnits(fill.quantity,j.quantityStep)||
   fill.quantity<=0||!Number.isFinite(fill.quote)||fill.quote<=0||!Number.isFinite(fill.commissionQuote))throw Error('INVALID_PROTECTIVE_FILL');
 const id=fill.clientId+':'+fill.tradeId;
 const prior=j.nativeReceipts.find(x=>x.id===id);
 if(prior){if(prior.quantity!==fill.quantity||prior.quote!==fill.quote||prior.commissionQuote!==fill.commissionQuote)
   throw Error('PROTECTIVE_RECEIPT_CONFLICT');return;}
 if(fill.quantity>j.remainingQuantity+tolerance)throw Error('NATIVE_FILL_EXCEEDS_OWNERSHIP');
 let left=fill.quantity;
 const reserved=leg=>j.outbox.some(o=>o.leg===leg&&!o.terminal&&o.status!=='PLANNED');
 for(const leg of ['risk','runner'].sort((a,b)=>Number(reserved(a))-Number(reserved(b)))){
   const used=Math.min(left,remaining(j,leg));j.legs[leg].filled+=used;left-=used;}
 j.realizedPnl+=fill.quote-j.entryPrice*fill.quantity-fill.commissionQuote;j.exitQuote+=fill.quote;
 if(Number.isFinite(fill.lastFillAt))j.lastFillAt=Math.max(j.lastFillAt??0,fill.lastFillAt);
 j.nativeReceipts.push({id,quantity:fill.quantity,quote:fill.quote,commissionQuote:fill.commissionQuote});reconcileTotals(j);
}

export function createR4Coordinator({store,broker,verifyLease,clock=Date.now,maxAttempts=3,checkpointMs=1000}){
 if(!Number.isInteger(maxAttempts)||maxAttempts<1||!Number.isFinite(checkpointMs)||checkpointMs<0)throw Error('INVALID_COORDINATOR_CONFIG');
 let hot=null,lastPersist=0,busy=false,recoveryBase=null;
 async function exclusive(fn){if(busy)throw Error('R4_HANDLER_BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function read(){if(!hot){hot=await store.load();if(!hot)throw Error('R4_JOURNAL_MISSING');
   recoveryBase=clone(hot.engine);
   if(hot.engine.lastTickAt!==null||hot.engine.lastBarClose!==null)hot.engine=restoreR4State(hot.engine,hot.policy);
   lastPersist=clock();}return hot;}
 async function save(next){const prior=await read();next.revision=prior.revision+1;next.updatedAt=clock();
   if(!await store.compareAndSwap(prior.revision,next)){hot=null;throw Error('R4_CAS_CONFLICT');}
   hot=next;lastPersist=clock();return clone(next);}
 async function settle(snapshot){
   const j=clone(await read());
   for(const o of snapshot.orders??[])accountOrder(j,o);
   for(const f of snapshot.nativeFills??[])accountNative(j,f);
   for(const leg of ['risk','runner'])if(j.legs[leg].requested)await plan(j,leg,'R4_TERMINAL_RESIDUAL',clock(),maxAttempts);
   // Unsent intents may be exhausted by a concurrent reduce-only protective fill.
   for(const o of j.outbox)if(o.status==='PLANNED'&&remaining(j,o.leg)<=tolerance){o.status='EXHAUSTED';o.terminal=true;}
   if(j.health!=='RETRY_LIMIT')j.health=j.state==='CLOSED'?'CLOSED':
     j.outbox.some(o=>!o.terminal&&o.status!=='PLANNED')?'RECONCILIATION_PENDING':'READY';
   return save(j);
 }
 return {
  async onEvent(event){return exclusive(async()=>{
   const before=await read();recoveryBase=null;
   const next=clone(before),o=nextR4Exit(next.engine,event,next.policy);next.engine=o.state;
   for(const signal of o.signals){next.legs[signal.leg].requested=true;await plan(next,signal.leg,signal.reason,signal.at,maxAttempts);}
   if(o.signals.length||clock()-lastPersist>=checkpointMs)return save(next);
   hot=next;return clone(next);
  });},
  async flush(){return exclusive(async()=>save(clone(await read())));},
  async recoverMarketWindow({events,complete,latestSequence,asOf}){return exclusive(async()=>{
   const j=clone(await read()),base=recoveryBase;
   if(!base||!Number.isSafeInteger(base.lastSequence)||complete!==true||!Array.isArray(events)||
     !Number.isSafeInteger(latestSequence)||!Number.isFinite(asOf)||asOf>clock()||asOf<base.lastEventAt)
     throw Error('R4_RECOVERY_PROOF_MISSING');
   const ticks=events.filter(e=>e.type==='tick').sort((a,b)=>a.sequence-b.sequence);
   let expected=base.lastSequence+1,lastAt=base.lastTickAt;
   for(const e of ticks){if(e.sequence!==expected++||!Number.isFinite(e.at)||e.at<lastAt||e.at>asOf)throw Error('R4_RECOVERY_TICK_GAP');lastAt=e.at;}
   if(expected-1!==latestSequence)throw Error('R4_RECOVERY_TICK_GAP');
   const bars=events.filter(e=>e.type==='bar').sort((a,b)=>a.closeAt-b.closeAt);
   let nextBar=base.lastBarClose!==null?base.lastBarClose+60000:Math.ceil(base.entryAt/60000)*60000+60000;
   for(const b of bars){if(b.closeAt!==nextBar||b.closeAt>asOf)throw Error('R4_RECOVERY_BAR_GAP');nextBar+=60000;}
   if(nextBar<=Math.floor(asOf/60000)*60000)throw Error('R4_RECOVERY_BAR_GAP');
   const ordered=[...events].sort((a,b)=>(a.at??a.closeAt)-(b.at??b.closeAt)||(a.type==='bar'?-1:b.type==='bar'?1:a.sequence-b.sequence));
   let engine=clone(base);const missed=[];
   for(const e of ordered){const at=e.at??e.closeAt;
     const out=nextR4Exit(engine,{...e,receivedAt:at},j.policy);engine=out.state;missed.push(...out.signals);}
   j.engine=engine;
   // Recovered signals become CURRENT intents; never invent a historical fill.
   for(const s of missed){j.legs[s.leg].requested=true;await plan(j,s.leg,'R4_RECOVERED_'+s.reason,clock(),maxAttempts);}
   j.recovery={throughSequence:latestSequence,asOf,recoveredAt:clock(),events:events.length};
   const saved=await save(j);recoveryBase=null;return saved;
  });},
  async reconcile(snapshot){return exclusive(async()=>settle(snapshot));},
  async dispatchNext(){return exclusive(async()=>{
   let j=await read();await verifyLease();
   const snap=await broker.snapshot({positionId:j.positionId,symbol:j.symbol,
     orderIds:j.outbox.filter(o=>o.status!=='PLANNED'&&o.status!=='EXHAUSTED').map(o=>o.clientId),protectionIds:j.protectionIds});
   j=await settle(snap);
   if(snap.complete!==true||snap.oneWay!==true||snap.manualComplete!==true||!Array.isArray(snap.manualSymbols)||
     !Number.isFinite(snap.capturedAt)||clock()-snap.capturedAt>3000||snap.capturedAt>clock()||snap.symbol!==j.symbol||
     (snap.quantity>0?snap.side!=='LONG':!['LONG','FLAT'].includes(snap.side))||
     (snap.manualSymbols??[]).includes(j.symbol)||!Number.isFinite(snap.quantity)||Math.abs(snap.quantity-j.remainingQuantity)>tolerance)
     throw Error('R4_PORTFOLIO_OWNERSHIP_MISMATCH');
   if(j.outbox.some(o=>o.status!=='PLANNED'&&!o.terminal))return {status:'RECONCILIATION_PENDING'};
   if(j.state==='CLOSED')return {status:'CLOSED'};
   const proposed=j.outbox.find(o=>o.status==='PLANNED');if(!proposed)return {status:'IDLE'};
   const protection=await broker.ensureProtection({positionId:j.positionId,symbol:j.symbol,quantity:j.remainingQuantity,
     triggerPrice:j.engine.entryPrice*(1-j.policy.emergencyStopPct)});
   if(protection.active!==true||protection.quantity!==j.remainingQuantity||
     !Number.isFinite(protection.triggerPrice)||protection.triggerPrice<j.engine.entryPrice*(1-j.policy.emergencyStopPct)||
     !Array.isArray(protection.clientIds)||!protection.clientIds.length||protection.clientIds.some(x=>typeof x!=='string'||!x))
     throw Error('R4_NATIVE_PROTECTION_UNCONFIRMED');
   const next=clone(j),o=next.outbox.find(x=>x.clientId===proposed.clientId);
   next.protectionIds=[...new Set([...next.protectionIds,...protection.clientIds])];
   o.quantity=Math.min(o.quantity,remaining(next,o.leg));o.status='SUBMITTING';o.submittingAt=clock();
   j=await save(next);await verifyLease();
   // A timeout never transitions back to PLANNED. Recovery queries this id only.
   const request={clientId:o.clientId,positionId:j.positionId,symbol:j.symbol,side:'SELL',type:'MARKET',
     quantity:o.quantity,reduceOnly:true,positionSide:'BOTH'};
   let response;
   try{response=await broker.submitReduceOnly(request);}catch(error){
     const failed=clone(j);failed.health='SUBMISSION_UNCERTAIN';failed.lastError=String(error?.message??error);
     await save(failed);return {status:'RECONCILIATION_PENDING',clientId:o.clientId};
   }
   const updated=await settle({orders:[response]});return {status:updated.state,clientId:o.clientId};
  });},
  async status(){const j=await read();return {state:j.state,remainingQuantity:j.remainingQuantity,
   decisionComplete:j.engine.risk.closed&&j.engine.runnerClosed,unresolved:j.outbox.filter(o=>!o.terminal).length,
   realizedPnl:j.realizedPnl,health:j.health,policyKey:r4PolicyKey(j.policy)};},
 };
}
