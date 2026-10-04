import {randomUUID} from 'node:crypto';

const err=reason=>Object.assign(Error(reason),{code:reason,status:503});
// This is a read cache, not an order or position ledger. Existing REST snapshots
// and existing DB identities remain the recovery authority. Any venue change,
// local mutation, missing pong or socket generation change invalidates the cache.
export function createAccountContinuity({readSnapshot,now=Date.now,maxSnapshotAge=900000}={}) {
 let generation=0,revision=0,connected=false,pong=0,snapshot=null,flight=null,writes=0;
 let retryAt=0,lastReason='ACCOUNT_STREAM_STARTING',reads=0,restSnapshots=0;
 const eventTimes=new Map();
 function invalidate(reason){revision++;snapshot=null;lastReason=reason;}
 function healthy(){const t=now();return connected&&pong>0&&t>=pong&&t-pong<=2500;}
 async function synchronize(){
  if(!healthy())throw err('ACCOUNT_STREAM_DISCONNECTED_OR_STALE');
  if(writes)throw err('ACCOUNT_STREAM_MUTATION_IN_FLIGHT');
  if(snapshot&&now()-snapshot.received_at_ms<=maxSnapshotAge)return;
  if(now()<retryAt)throw err(lastReason);
  if(!flight){const g=generation;
   flight=(async()=>{
    for(let attempt=0;attempt<2;attempt++){
     const r=revision,requested_at_ms=now();restSnapshots++;
     const data=await readSnapshot();
     if(g!==generation||!healthy()||writes)throw err('ACCOUNT_STREAM_CHANGED_DURING_RECOVERY');
     if(r!==revision)continue; // Do not replay an event over an ambiguous REST boundary.
     if(!Array.isArray(data.account?.positions)||!Array.isArray(data.account?.assets)||
        ![data.account.availableBalance,data.account.totalWalletBalance].every(x=>x!=null&&Number.isFinite(Number(x)))||
        !Array.isArray(data.orders)||!Array.isArray(data.algos))throw err('ACCOUNT_STREAM_SNAPSHOT_INCOMPLETE');
     snapshot={...structuredClone(data),id:randomUUID(),requested_at_ms,received_at_ms:now(),generation:g,revision:r};
     lastReason=null;return;
    }
    throw err('ACCOUNT_STREAM_CHANGED_DURING_RECOVERY');
   })().catch(error=>{lastReason=error.code??'ACCOUNT_STREAM_RECOVERY_FAILED';retryAt=Math.max(now()+1000,Number(error.retryAtMs)||0);throw error;});
   const current=flight;current.then(()=>{if(flight===current)flight=null;},()=>{if(flight===current)flight=null;});
  }
  await flight;
 }
 return {
  open(){generation++;connected=true;pong=0;retryAt=0;eventTimes.clear();invalidate('ACCOUNT_STREAM_RECONNECTED');return generation;},
  close(g){if(g!==generation)return;connected=false;pong=0;invalidate('ACCOUNT_STREAM_DISCONNECTED');},
  pong(g){if(g===generation&&connected)pong=now();},
  event(g,e){
   if(g!==generation||!connected)return;
   if(e?.e==='listenKeyExpired'){connected=false;invalidate('ACCOUNT_STREAM_EXPIRED');return;}
   if(!e||typeof e.e!=='string'){connected=false;invalidate('ACCOUNT_STREAM_INVALID_EVENT');return;}
   const t=Number(e.E),previous=eventTimes.get(e.e);
   if(!Number.isSafeInteger(t)||t>now()+1000||now()-t>10000||(previous!=null&&t<previous)){
    connected=false;invalidate('ACCOUNT_STREAM_EVENT_TIME_INVALID');return;
   }
   eventTimes.set(e.e,t);
   // Unknown private events also invalidate: future event types cannot silently
   // hide a balance, order, mode or margin change.
   invalidate('ACCOUNT_STREAM_VENUE_CHANGE');
  },
  beginMutation(){writes++;invalidate('ACCOUNT_STREAM_LOCAL_MUTATION');let released=false;return ()=>{if(released)return;released=true;writes--;invalidate('ACCOUNT_STREAM_MUTATION_COMPLETED');};},
  async read(){const requested=now();await synchronize();
   if(!snapshot||!healthy()||writes||snapshot.generation!==generation||snapshot.revision!==revision)throw err('ACCOUNT_STREAM_CHANGED_AT_READ');
   reads++;const s=structuredClone(snapshot),at=now();
   return {...s,observation:{id:randomUUID(),source:'BINANCE_ACCOUNT_STREAM',requested_at_ms:requested,received_at_ms:at,
    continuity:{connected:true,synchronized:true,generation,revision,last_pong_at_ms:pong,validated_at_ms:at,
     snapshot_id:s.id,snapshot_requested_at_ms:s.requested_at_ms,snapshot_received_at_ms:s.received_at_ms,max_snapshot_age_ms:maxSnapshotAge}}};
  },
  status(){return {connected,healthy:healthy(),synchronized:!!snapshot,generation,revision,last_pong_at_ms:pong||null,
   snapshot_received_at_ms:snapshot?.received_at_ms??null,reason:lastReason,reads,rest_snapshots:restSnapshots,writes};},
  positionSymbols(){return snapshot?.account?.positions.filter(p=>Number(p.positionAmt)!==0).map(p=>p.symbol)??[];},
  assertSubmission(o){const c=o?.continuity,t=now();
   if(o?.source!=='BINANCE_ACCOUNT_STREAM'||!healthy()||writes||!snapshot||
      c?.generation!==generation||c.revision!==revision||c.snapshot_id!==snapshot.id||
      !Number.isSafeInteger(o.requested_at_ms)||!Number.isSafeInteger(o.received_at_ms)||
      o.requested_at_ms>o.received_at_ms||o.received_at_ms>t||t-o.requested_at_ms>3000)
    throw Object.assign(err('ACCOUNT_STREAM_CHANGED_BEFORE_SUBMIT'),{exchangeSubmissionAttempted:false,submissionPhase:'PRE_SEND'});
   return true;
  },
 };
}

export function startAccountStream({WebSocketClient,listenKey,readSnapshot,now=Date.now,onConfig=()=>{}}){
 const continuity=createAccountContinuity({readSnapshot,now});let socket=null,stopped=false,retryTimer=null,keepaliveTimer=null,pingTimer=null;
 let failures=0,g=0,key=null;
 function reconnect(){
  if(stopped||retryTimer)return;
  const delay=Math.min(60000,1000*2**Math.min(6,failures++));
  retryTimer=setTimeout(()=>{retryTimer=null;connect().catch(()=>reconnect());},delay);retryTimer.unref?.();
 }
 async function connect(){
  key=await listenKey('POST');if(stopped)return;
  const ws=new WebSocketClient('wss://fstream.binance.com/private/ws/'+encodeURIComponent(key));socket=ws;
  ws.on('open',()=>{if(socket!==ws)return;g=continuity.open();const generation=g;failures=0;
   const probes=new Map();
   ws.on('pong',data=>{const token=String(data);if(socket===ws&&probes.has(token)&&now()-probes.get(token)<=2500){probes.delete(token);continuity.pong(generation);continuity.read().catch(()=>{});}});
   const ping=()=>{if(socket!==ws)return;for(const [token,t] of probes)if(now()-t>2500)probes.delete(token);
    if(ws.readyState!==1)return;const token=randomUUID();probes.set(token,now());ws.ping(token);
   };
   ping();pingTimer=setInterval(ping,1000);pingTimer.unref?.();
   keepaliveTimer=setInterval(()=>listenKey('PUT').catch(()=>ws.close()),30*60000);keepaliveTimer.unref?.();
  });
  ws.on('message',raw=>{if(socket!==ws)return;try{const e=JSON.parse(String(raw));continuity.event(g,e);if(e.e==='ACCOUNT_CONFIG_UPDATE')onConfig();
    if(!continuity.status().connected)ws.close();
   }catch{continuity.close(g);ws.close();}});
  const closed=()=>{if(socket!==ws)return;socket=null;continuity.close(g);clearInterval(pingTimer);clearInterval(keepaliveTimer);reconnect();};
  ws.on('close',closed);ws.on('error',()=>{ws.terminate();closed();});
 }
 connect().catch(()=>reconnect());
 return {...continuity,stop(){stopped=true;clearTimeout(retryTimer);clearInterval(pingTimer);clearInterval(keepaliveTimer);socket?.terminate();}};
}

// Passive position quantities remain exact until an account event. Mark-to-market
// capacity may only DECREASE from the authenticated recovery snapshot between events.
// Positive PnL never creates extra spending authority. Missing mark evidence refuses
// entry and triggers a bounded, honest REST recovery instead of inventing a balance.
export function conservativeStreamAccount(snapshot,readMark,now=Date.now()){
 const account=structuredClone(snapshot.account),positions=account.positions.filter(p=>Number(p.positionAmt)!==0);
 let penalty=0,pnl=0,margin=0;
 for(const p of positions){
  const mark=readMark(p.symbol),amount=Number(p.positionAmt),entry=Number(p.entryPrice),leverage=Number(p.leverage);
  if(!mark||now-mark.received_at_ms>2500||now-mark.event_at_ms>3000||!(mark.price>0&&entry>0&&leverage>0)||p.positionSide!=='BOTH'||!p.symbol.endsWith('USDT'))throw err('ACCOUNT_STREAM_MARK_OR_MODE_UNVERIFIED');
  const u=(mark.price-entry)*amount,im=Math.abs(amount)*mark.price/leverage;
  if(![u,im,Number(p.unrealizedProfit),Number(p.initialMargin)].every(Number.isFinite))throw err('ACCOUNT_STREAM_MARGIN_UNVERIFIED');
  penalty+=Math.max(0,Number(p.unrealizedProfit)-u)+Math.max(0,im-Number(p.initialMargin));
  p.unrealizedProfit=String(u);p.initialMargin=String(im);pnl+=u;margin+=im;
 }
 if(!Number.isFinite(Number(account.availableBalance))||!Number.isFinite(Number(account.totalWalletBalance)))throw err('ACCOUNT_STREAM_MARGIN_UNVERIFIED');
 account.availableBalance=String(Math.max(0,Number(account.availableBalance)-penalty));
 account.totalUnrealizedProfit=String(pnl);
 account.totalMarginBalance=String(Number(account.totalWalletBalance)+pnl);
 account.totalInitialMargin=String(margin+Number(account.totalOpenOrderInitialMargin??0));
 account.capacity_basis='CONSERVATIVE_AUTHENTICATED_SNAPSHOT_AND_STREAM_MARK';
 return account;
}
