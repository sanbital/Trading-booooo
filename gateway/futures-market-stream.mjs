// Book integrity has one committed implementation, also used by the 120s collector.
import {Book,BOOK_STATE,normalizeSymbol,transportFresh} from './capture-book-core.mjs';
const failure=reason=>Object.assign(Error(reason),{code:reason,status:503});

export function createExecutionMarkets({fetchDepth,now=Date.now}={}){
 const states=new Map();let recoveries=0,quoteReads=0,activeRecoveries=0;const snapshotTimes=[],routineTimes=[];
 function state(symbol){const s=states.get(symbol);if(!s)throw failure('EXECUTION_STREAM_NOT_WATCHED');return s;}
 return {
  setSymbols(symbols){const wanted=new Set(symbols.map(normalizeSymbol).filter(Boolean));
   for(const s of states.keys())if(!wanted.has(s))states.delete(s);
   for(const symbol of wanted)if(!states.has(symbol))states.set(symbol,{symbol,book:new Book(),generation:1,trades:[],mark:null,flight:null,retryAt:0,bootstrap:true,lastRecoveryAt:0,failures:0,snapshotError:null});
   return [...states.keys()];
  },
  disconnect(kind){for(const s of states.values()){
   if(kind==='book'){s.generation++;s.bootstrap=true;s.book.reset('EXECUTION_SOCKET_DISCONNECTED');}
   else {s.trades=[];s.mark=null;s.lastTradeId=null;}
  }},
  event(e){const symbol=normalizeSymbol(e?.s),s=states.get(symbol);if(!s)return;
   const t=now();if(!transportFresh(e,t)){if(e.e==='depthUpdate')s.book.markUnsynced('EXECUTION_EVENT_STALE',null,t);return;}
   if(e.e==='depthUpdate'){s.book.event(e,t);if(s.book.ready){s.bootstrap=false;s.failures=0;s.snapshotError=null;}}
   if(e.e==='aggTrade'){
    const id=Number(e.a);if(!Number.isSafeInteger(id)||Number(e.T)>t||s.lastTradeId!=null&&id!==s.lastTradeId+1){s.trades=[];}
    if(s.lastTradeId!=null&&id<=s.lastTradeId)return;
    s.lastTradeId=id;s.trades.push({price:Number(e.p),qty:Number(e.q),ts:Number(e.T),buyerTaker:e.m===false});
    s.trades=s.trades.filter(x=>x.ts>=t-30000).slice(-100);
   }
   if(e.e==='markPriceUpdate'&&Number(e.p)>0&&Number(e.E)<=t)s.mark={price:Number(e.p),event_at_ms:Number(e.E),received_at_ms:t};
  },
  async recover(symbol){const s=state(symbol),t=now();
   if(s.flight)return s.flight;
   const drift=s.book.needsCoverageRefresh(t),stale=s.book.needsStaleResync(t);
   if(s.book.state===BOOK_STATE.SYNCED&&!drift&&!stale)return;
   if(t<s.retryAt)return;
   while(snapshotTimes.length&&snapshotTimes[0]<=t-60000)snapshotTimes.shift();
   while(routineTimes.length&&routineTimes[0]<=t-60000)routineTimes.shift();
   // A new/reconnected socket needs every member bootstrapped, even after process
   // startup. Bound ALL recovery to 500 weight/min, routine drift to 100/min.
   // Never enqueue a quote or writer request behind book recovery.
   if(activeRecoveries>=2||snapshotTimes.length>=25||!s.bootstrap&&routineTimes.length>=5)return;
   if(drift||stale){s.generation++;s.book.reset(drift?'EXECUTION_COVERAGE_DRIFT':'EXECUTION_BOOK_STALE');}
   const generation=s.generation;s.book.beginResync(t);s.retryAt=t+5000;s.lastRecoveryAt=t;recoveries++;activeRecoveries++;snapshotTimes.push(t);if(!s.bootstrap)routineTimes.push(t);
   const failed=reason=>{s.snapshotError=reason;s.failures++;s.retryAt=now()+Math.min(60000,10000*2**Math.min(s.failures-1,3));};
   s.flight=Promise.resolve().then(()=>fetchDepth(symbol)).then(depth=>{
    if(states.get(symbol)!==s||generation!==s.generation)return;
    const result=s.book.snapshot(depth,now());if(result.status===BOOK_STATE.UNSYNCED)failed(result.reason??'EXECUTION_SNAPSHOT_SEQUENCE_FAILED');
    else if(s.book.ready){s.bootstrap=false;s.failures=0;s.snapshotError=null;}
   }).catch(error=>{if(states.get(symbol)===s&&generation===s.generation){s.book.failResync('EXECUTION_SNAPSHOT_UNAVAILABLE');failed(String(error.code??error.message??'EXECUTION_SNAPSHOT_UNAVAILABLE').slice(0,100));s.retryAt=Math.max(s.retryAt,Number(error.retryAtMs)||0);}})
    .finally(()=>{s.flight=null;activeRecoveries--;});return s.flight;
  },
  mark(symbol){return states.get(symbol)?.mark??null;},
  symbols(){return [...states.keys()];},
  recoverySymbols(){return [...states.values()].sort((a,b)=>a.lastRecoveryAt-b.lastRecoveryAt).map(s=>s.symbol);},
  quote(symbol){const s=state(symbol),t=now(),m=s.book.metrics(t);
   // Enforce the executor's existing 1.5s book boundary here too. Do not stamp an
   // old depth as a freshly received quote or fall back to REST on every candidate.
   if(!m.book_complete||t-s.book.received>1500||t-s.book.at>1500)throw failure('EXECUTION_STREAM_BOOK_UNAVAILABLE');
   const bids=[...s.book.bids].sort((a,b)=>b[0]-a[0]).map(([price,size])=>({price,size}));
   const asks=[...s.book.asks].sort((a,b)=>a[0]-b[0]).map(([price,size])=>({price,size}));
   quoteReads++;return {exchange:'binance_futures',market:symbol,current:m.mid,best_ask:m.best_ask,best_bid:m.best_bid,bids,asks,
    trades:structuredClone(s.trades),raw:{book_update_id:s.book.last,book_generation:s.generation},
    timing:{requested_at_ms:t,received_at_ms:s.book.received,validated_at_ms:t,book_captured_at_ms:s.book.at,
     gateway_elapsed_ms:0,source:'BINANCE_DEPTH_STREAM',mode:'SEQUENCED_LOCAL_BOOK'}};
  },
  status(){return {watched:states.size,synced:[...states.values()].filter(s=>s.book.state===BOOK_STATE.SYNCED).length,
   fresh:[...states.values()].filter(s=>s.book.ready&&now()-s.book.received<=1500&&now()-s.book.at<=1500).length,
   mark_fresh:[...states.values()].filter(s=>s.mark&&now()-s.mark.received_at_ms<=2500).length,recoveries,quote_reads:quoteReads,
   recovery_in_flight:activeRecoveries,recovery_requests_last_minute:snapshotTimes.filter(t=>t>now()-60000).length,
   unsynced:[...states.values()].filter(s=>!s.book.ready).map(s=>({symbol:s.symbol,state:s.book.state,generation:s.generation,
    reason:s.snapshotError??s.book.lastIncident?.reason,last_recovery_at_ms:s.lastRecoveryAt,retry_at_ms:s.retryAt,buffered_events:s.book.buffer.length})).slice(0,32)};},
 };
}

export function startExecutionStreams({WebSocketClient,fetchDepth,watch,now=Date.now,watchIntervalMs=5000}){
 const markets=createExecutionMarkets({fetchDepth,now}),sockets=new Map(),timers=new Set();let stopped=false,nextId=1,watchFlight=null;
 const watchState={last_attempt_at_ms:null,last_success_at_ms:null,error:null,failures:0};
 const schedule=(work,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);if(!stopped)work();},ms);timers.add(timer);timer.unref?.();};
 const streams=(kind,symbols)=>symbols.flatMap(s=>kind==='book'?[s.toLowerCase()+'@depth@100ms']:
  [s.toLowerCase()+'@aggTrade',s.toLowerCase()+'@markPrice@1s']);
 function connect(kind){
  if(stopped||sockets.has(kind))return;const initial=streams(kind,markets.symbols());if(!initial.length)return;
  const route=kind==='book'?'public':'market';
  const ws=new WebSocketClient('wss://fstream.binance.com/'+route+'/stream?streams='+initial.map(encodeURIComponent).join('/'));
  const entry={ws,subscribed:new Set(initial),lastPong:0,ping:null};sockets.set(kind,entry);
  ws.on('open',()=>{if(sockets.get(kind)!==entry)return;
   ws.on('pong',()=>{entry.lastPong=now();});entry.lastPong=now();
   entry.ping=setInterval(()=>{if(now()-entry.lastPong>5000){ws.terminate();return;}if(ws.readyState===1)ws.ping();},1500);entry.ping.unref?.();
   updateSubscriptions();
   if(kind==='book')for(const symbol of markets.symbols())markets.recover(symbol);
  });
  ws.on('message',raw=>{if(sockets.get(kind)!==entry)return;try{const p=JSON.parse(String(raw));if(p.code!=null)throw failure('EXECUTION_STREAM_SUBSCRIPTION_FAILED');
    const e=p.data??p;if(e.e)markets.event(e);
   }catch{ws.terminate();}});
  const closed=()=>{if(sockets.get(kind)!==entry)return;clearInterval(entry.ping);sockets.delete(kind);markets.disconnect(kind);schedule(()=>connect(kind),5000);};
  ws.on('close',closed);ws.on('error',()=>{ws.terminate();closed();});
 }
 function updateSubscriptions(){for(const kind of ['book','market']){
  const entry=sockets.get(kind);if(!entry){connect(kind);continue;}if(entry.ws.readyState!==1)continue;
  const wanted=new Set(streams(kind,markets.symbols())),add=[...wanted].filter(s=>!entry.subscribed.has(s)),remove=[...entry.subscribed].filter(s=>!wanted.has(s));
  if(remove.length)entry.ws.send(JSON.stringify({method:'UNSUBSCRIBE',params:remove,id:nextId++}));
  if(add.length)entry.ws.send(JSON.stringify({method:'SUBSCRIBE',params:add,id:nextId++}));entry.subscribed=wanted;
  if(kind==='book'&&add.length)for(const symbol of markets.symbols())markets.recover(symbol);
 }}
 function refresh(){if(stopped)return Promise.resolve();if(watchFlight)return watchFlight;
  watchState.last_attempt_at_ms=now();
  watchFlight=Promise.resolve().then(watch).then(symbols=>{
   if(stopped)return;markets.setSymbols(symbols);updateSubscriptions();
   watchState.last_success_at_ms=now();watchState.error=null;watchState.failures=0;
  }).catch(error=>{
   // Retained books cannot grant membership; expose failed watch refreshes instead
   // of reporting a healthy count for a permanently obsolete subscription set.
   watchState.error=String(error?.code??error?.message??'EXECUTION_WATCH_UNAVAILABLE').slice(0,100);watchState.failures++;
  }).finally(()=>{watchFlight=null;});return watchFlight;
 }
 async function quoteReady(symbol){
  if(!markets.symbols().includes(symbol))await refresh();
  try{return markets.quote(symbol);}catch(error){
   if(error.code!=='EXECUTION_STREAM_BOOK_UNAVAILABLE')throw error;
   // One bounded recovery shares the existing budget and sequence checks. A late
   // member is warmed before the executor starts spending its approval lifetime.
   if(sockets.get('book')?.ws.readyState===1)await markets.recover(symbol);
   return markets.quote(symbol);
  }
 }
 refresh();const watchTimer=setInterval(refresh,watchIntervalMs),recoveryTimer=setInterval(()=>{
  if(sockets.get('book')?.ws.readyState===1)for(const symbol of markets.recoverySymbols())markets.recover(symbol);
 },1000);watchTimer.unref?.();recoveryTimer.unref?.();
 return {...markets,refresh,quoteReady,status(){return {...markets.status(),watched_symbols:markets.symbols(),watch:{...watchState,in_flight:watchFlight!==null},
  sockets:Object.fromEntries([...sockets].map(([kind,e])=>[kind,{connected:e.ws.readyState===1,subscriptions:e.subscribed.size,last_pong_at_ms:e.lastPong}]))};},stop(){stopped=true;clearInterval(watchTimer);clearInterval(recoveryTimer);for(const t of timers)clearTimeout(t);
  for(const e of sockets.values()){clearInterval(e.ping);e.ws.terminate();}sockets.clear();}};
}
