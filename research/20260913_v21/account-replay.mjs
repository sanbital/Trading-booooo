#!/usr/bin/env node
/**
 * Independent chronological account replay for A/B/C/D.
 *
 * Signals and L1 books are point-in-time V18 observations. Exact completed 1m
 * candles and funding rates are post-hoc outcome inputs only. Missing V21 quote
 * RTT fields preserve the baseline, as fixed by protocol.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {entryFresh} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {exitDecision as baselineExitDecision} from '../../supabase/functions/_shared/leader-qv3-rules.mjs';
import {qv3Entry} from '../../supabase/functions/_shared/leader-qv3-runtime.mjs';
import {entryDecision,initialReclaimState,reclaimExitDecision} from './candidate-rules.mjs';

const [shadowFile,marketDir,snapshotFile,outputFile]=process.argv.slice(2);
if(!shadowFile||!marketDir||!snapshotFile||!outputFile)
  throw Error('Usage: node account-replay.mjs STRATEGY_SHADOW.jsonl.gz MARKET_DIR ACCOUNT_SNAPSHOTS.jsonl.gz OUTPUT.json');
const protocol=JSON.parse(fs.readFileSync(new URL('./protocol.json',import.meta.url)));
const MINUTE=60000,QV3_AT=Date.parse('2026-09-11T15:20:00Z');
const number=v=>v===null||v===''||v===undefined?NaN:Number(v);
const floor=(v,s)=>Number((Math.floor(v/s+1e-9)*s).toPrecision(14));
const ceil=(v,s)=>Number((Math.ceil(v/s-1e-9)*s).toPrecision(14));
const sum=(a,f=x=>x)=>a.reduce((s,x)=>s+Number(f(x)??0),0);
const round=(v,d=9)=>Number.isFinite(v)?Number(v.toFixed(d)):null;
const iso=t=>new Date(t).toISOString();
async function gzRows(file){const rows=[];const lines=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const line of lines)if(line.trim())rows.push(JSON.parse(line));return rows;}

function paperIntent(ask,rule,c){
  const step=number(rule?.step),min=number(rule?.minNotional),tick=number(rule?.tick);
  if(!(step>0&&tick>0&&min>0&&rule.trading===true))throw Error('SYMBOL_RULES_UNAVAILABLE');
  const target=c.marginUsdt*c.leverage;let quantity=ceil(target/ask,step);
  if(quantity*ask<target+.12&&(quantity+step)*ask/c.leverage<=c.marginUsdt+.25)quantity=floor(quantity+step,step);
  const limit=Math.max(ask*1.0003,(target+.12)/quantity);
  if(quantity*ask<min||quantity*ask/c.leverage>c.marginUsdt+.25+1e-9||quantity*limit/c.leverage>c.marginUsdt+.25+1e-9||
    (limit/ask-1)*10000>12+1e-8)throw Error('SIZING_OR_IOC_GUARD');
  return {quantity,limit,reserve:quantity*limit/c.leverage+Math.max(.10,quantity*limit*c.feeRate),step,tick};
}
function frame(row){
  const p=row.payload??row,m=p.source?.market,at=Date.parse(m?.observedAt??p.finishedAt??p.asOf);
  return {id:`${p.version}:${row.slot_at??p.asOf}`,at,scanId:p.source?.scan?.id??null,
    scanCapturedAt:Date.parse(p.source?.scan?.captured_at),quotes:m?.quotes??[],rules:m?.rules??{},
    signals:p.evaluationState==='EVALUATED'?(p.source?.confirmations??[]).filter(x=>x.feature)
      .map(x=>({id:`${x.feature.symbol}:${x.feature.signal5Close}`,features:x.feature})):[],
    complete:m?.version==='V18_PAPER_MARKET_1'&&p.evaluationState==='EVALUATED'};
}

const rawShadow=await gzRows(shadowFile);let frames=rawShadow.filter(r=>(r.payload??r).source?.market?.version==='V18_PAPER_MARKET_1')
  .map(frame).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
if(!frames.length)throw Error('NO_FRAMES');
const candleRows=await gzRows(`${marketDir}/candles.jsonl.gz`),candles=new Map();
for(const row of candleRows){
  if(!row.symbol||!Number.isSafeInteger(row.openTime)||row.openTime%MINUTE||row.closeTime!==row.openTime+MINUTE-1||
    ![row.open,row.high,row.low,row.close].map(number).every(Number.isFinite))throw Error('BAD_CANDLE');
  let list=candles.get(row.symbol);if(!list)candles.set(row.symbol,list=[]);list.push(row);
}
for(const list of candles.values())list.sort((a,b)=>a.openTime-b.openTime);
const rawFrameCount=frames.length,rawLastFrame=frames.at(-1).at;
const signalSymbols=[...new Set(frames.flatMap(f=>f.signals.map(s=>s.features.symbol)))].sort();
const missingCandleSymbols=signalSymbols.filter(symbol=>!(candles.get(symbol)?.length));
if(missingCandleSymbols.length)throw Error(`MISSING_SIGNAL_CANDLES:${missingCandleSymbols.join(',')}`);
const commonCandleStart=Math.max(...signalSymbols.map(symbol=>candles.get(symbol)[0].openTime));
const commonCandleEnd=Math.min(...signalSymbols.map(symbol=>candles.get(symbol).at(-1).closeTime));
// A frame in the minute immediately after commonCandleEnd can consume the
// final completed candle. Any later frame would silently run with a missing
// outcome path for at least one eligible symbol.
const exactFrameEnd=commonCandleEnd+1+MINUTE;
frames=frames.filter(f=>f.at>=commonCandleStart&&f.at<exactFrameEnd);
if(!frames.length)throw Error('NO_COMMON_CANDLE_COVERAGE');
const fundingRows=fs.readFileSync(`${marketDir}/funding.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const funding=fundingRows.filter(x=>x.ok).sort((a,b)=>a.fundingTime-b.fundingTime||a.symbol.localeCompare(b.symbol));
const fundingFailures=fundingRows.filter(x=>!x.ok);
const snapshotRows=(await gzRows(snapshotFile)).filter(x=>msSafe(x.captured_at)!==null).sort((a,b)=>msSafe(a.captured_at)-msSafe(b.captured_at));
function msSafe(v){const n=Date.parse(v);return Number.isFinite(n)?n:null;}
let snapshotCursor=0,latestSnapshot=null;
for(const f of frames){
  while(snapshotCursor<snapshotRows.length&&msSafe(snapshotRows[snapshotCursor].captured_at)<=f.at)latestSnapshot=snapshotRows[snapshotCursor++];
  const captured=msSafe(latestSnapshot?.captured_at),age=captured===null?Infinity:f.at-captured;
  f.snapshot={available:latestSnapshot?.positions_complete===true&&age>=0&&age<=90000,ageMs:Number.isFinite(age)?age:null,capturedAt:captured};
}

const variants=['A','B','C','D'];
function replay(settings){
  const c={initialBalance:100,marginUsdt:40,leverage:3,maxSlots:10,maxQuoteAgeMs:90000,maxFrameGapMs:90000,...settings};
  const accounts=Object.fromEntries(variants.map(variant=>[variant,{variant,wallet:c.initialBalance,positions:[],closed:[],pendingEntries:[],
    signalQueue:[],signalHistory:[],generatedSignalIds:new Set(),opportunityIds:new Set(),events:[],curve:[],liquidity:new Map(),fees:0,funding:0,turnover:0,incomplete:0,
    entryBlocks:0,candidateQuoteUnavailable:0,peakEquity:c.initialBalance,maxDrawdown:0,nextPositionId:1}]));
  const seenFrames=new Map(),seenScans=new Set();let priorAt=null;
  for(const f of frames){
    const serialized=JSON.stringify(f);if(seenFrames.has(f.id)){if(seenFrames.get(f.id)!==serialized)throw Error('CONFLICTING_FRAME');continue;}
    if(priorAt!==null&&f.at<=priorAt)throw Error('OUT_OF_ORDER_FRAME');seenFrames.set(f.id,serialized);
    const gap=priorAt!==null&&f.at-priorAt>c.maxFrameGapMs,scanEvent=f.scanId!==null&&!seenScans.has(f.scanId),quotes=new Map();
    if(scanEvent)seenScans.add(f.scanId);
    for(const raw of f.quotes){
      const q={symbol:raw.symbol,bid:number(raw.bid),ask:number(raw.ask),bidQty:number(raw.bidQty),askQty:number(raw.askQty),at:number(raw.at)};
      if(!q.symbol||quotes.has(q.symbol))throw Error('BAD_OR_DUPLICATE_QUOTE');
      if([q.bid,q.ask,q.bidQty,q.askQty,q.at].every(Number.isFinite)&&q.bid>0&&q.ask>=q.bid&&q.bidQty>=0&&q.askQty>=0&&
        q.at<=f.at&&f.at-q.at<=c.maxQuoteAgeMs)quotes.set(q.symbol,q);
    }
    for(const a of Object.values(accounts)){
      const event=(type,data={})=>a.events.push({at:f.at,type,...data});
      const depth=q=>{const key=JSON.stringify([q.at,q.bid,q.ask,q.bidQty,q.askQty]);if(a.liquidity.get(q.symbol)?.key!==key)a.liquidity.set(q.symbol,{key,bid:q.bidQty,ask:q.askQty});return a.liquidity.get(q.symbol);};
      const valuation=()=>a.positions.some(p=>!quotes.has(p.symbol))?null:a.wallet+sum(a.positions,p=>p.quantity*(quotes.get(p.symbol).bid-p.entryPrice));
      const free=()=>{const equity=valuation();return equity===null?null:Math.min(a.wallet,equity)-sum(a.positions,p=>p.quantity*p.entryPrice/c.leverage)-sum(a.pendingEntries,p=>p.reserve);};
      if(gap||!f.complete)a.incomplete++;
      // Funding occurs at its exchange timestamp while the position is open.
      if(priorAt!==null)for(const rate of funding){
        if(rate.fundingTime<=priorAt||rate.fundingTime>f.at)continue;
        for(const p of a.positions.filter(x=>x.symbol===rate.symbol&&x.entryAt<rate.fundingTime)){
          const payment=-p.quantity*rate.markPrice*rate.fundingRate;a.wallet+=payment;a.funding+=payment;p.net+=payment;
          p.funding.push({at:rate.fundingTime,rate:rate.fundingRate,markPrice:rate.markPrice,payment});event('FUNDING',{symbol:p.symbol,payment});
        }
      }
      const completeClose=(p,at,price,reason,fee,native=false)=>{
        const gross=p.quantity*(price-p.entryPrice);a.wallet+=gross-fee;a.fees+=fee;a.turnover+=p.quantity*price;p.net+=gross-fee;p.exitFees+=fee;
        p.exitFills.push({at,quantity:p.quantity,price,fee,native});p.quantity=0;p.closedAt=at;p.reason=reason;a.closed.push(p);a.positions=a.positions.filter(x=>x!==p);
        if(p.signal)p.signal.status='CLOSED';
        event('EXIT_FILL',{symbol:p.symbol,reason,price,native});
      };
      // Native stop is adverse-first. The paired SKIP bound ignores the
      // entry minute because OHLC cannot locate its low relative to entry.
      for(const p of [...a.positions]){
        const available=(candles.get(p.symbol)??[]).filter(x=>x.closeTime<f.at&&x.openTime>p.lastCandleOpen);
        let stopped=false;
        for(const bar of available){
          p.lastCandleOpen=bar.openTime;
          if(c.sameEntryCandle==='SKIP'&&bar.openTime===Math.floor(p.entryAt/MINUTE)*MINUTE)continue;
          if(number(bar.low)<=p.stopPrice){
            const rawPrice=Math.min(p.stopPrice,number(bar.open)),price=rawPrice*(1-c.baselineExitImpact),fee=p.quantity*price*c.feeRate;
            // The minute OHLC does not reveal when the low occurred. Booking
            // the exit at close avoids freeing capital optimistically.
            completeClose(p,bar.closeTime,price,'NATIVE_STOP_REPLAY',fee,true);stopped=true;break;
          }
        }
        if(stopped)continue;
        const q=quotes.get(p.symbol);if(!q){a.incomplete++;event('POSITION_QUOTE_UNAVAILABLE',{symbol:p.symbol});continue;}
        const bars=(candles.get(p.symbol)??[]).filter(x=>x.closeTime<f.at).map(x=>[x.openTime,x.open,x.high,x.low,x.close,x.volume,x.closeTime]);
        const baselinePosition={...p,entryFee:p.entryFee*p.quantity/p.originalQuantity};
        const baseline=baselineExitDecision(baselinePosition,q.bid,f.at,p.qv3?'EXIT_TWO':'BASELINE',bars);
        p.peakPrice=baseline.peakPrice;p.lastHighAt=baseline.lastHighAt;p.stopPrice=baseline.stopPrice;
        let reason=baseline.action==='CLOSE'?baseline.reason:null;
        if(!reason&&(a.variant==='C'||a.variant==='D')&&p.reclaimState){
          // V18 observation rows do not carry request/receive RTT. The
          // frozen fail-closed rule therefore cannot count this quote.
          const d=reclaimExitDecision({position:{id:p.id,ownership:'AUTO',side:'LONG',state:'OPEN',entryAt:p.entryAt,entryPrice:p.entryPrice},
            state:p.reclaimState,observation:{detectedAtMs:f.at,exchangeBookAtMs:q.at,bid:q.bid}});
          if(d.state)p.reclaimState=d.state;if(!d.available)a.candidateQuoteUnavailable++;if(d.wouldClose)reason=d.reason;
        }
        if(reason&&!p.pendingExit){p.pendingExit={due:f.at+c.latencyMs,signalAt:f.at,reason};event('EXIT_SIGNAL',{symbol:p.symbol,reason});}
        if(!p.pendingExit||p.pendingExit.due>f.at)continue;
        const liquidity=depth(q),qty=floor(Math.min(p.quantity,liquidity.bid),p.step);if(qty<=0){event('EXIT_NO_LIQUIDITY',{symbol:p.symbol});continue;}
        const impact=p.pendingExit.reason==='V21_RECLAIM_FAILURE_3'?c.candidateExitImpact:c.baselineExitImpact;
        const price=q.bid*(1-impact),fee=qty*price*c.feeRate,gross=qty*(price-p.entryPrice);
        a.wallet+=gross-fee;a.fees+=fee;a.turnover+=qty*price;liquidity.bid-=qty;p.quantity=Number((p.quantity-qty).toPrecision(14));p.net+=gross-fee;p.exitFees+=fee;
        p.exitFills.push({at:f.at,quantity:qty,price,fee,native:false});event('EXIT_FILL',{symbol:p.symbol,reason:p.pendingExit.reason,quantity:qty,remaining:p.quantity});
        if(p.quantity<=Math.max(1e-10,p.originalQuantity*1e-9)){p.quantity=0;p.closedAt=f.at;p.reason=p.pendingExit.reason;a.closed.push(p);a.positions=a.positions.filter(x=>x!==p);if(p.signal)p.signal.status='CLOSED';}
      }
      const reject=(signal,reason)=>{signal.status='REJECTED';signal.rejectReason=reason;event('SIGNAL_REJECTED',{symbol:signal.symbol,signalId:signal.id,reason});};
      const fillEntry=intent=>{
        const q=quotes.get(intent.symbol),fresh=q?entryFresh(intent.features,f.at,intent.limit):'ENTRY_QUOTE_UNAVAILABLE';
        if(fresh||q.ask*(1+c.entryImpact)>intent.limit){reject(intent.signal,fresh??'IOC_NO_FILL:EXPIRED');event('ENTRY_EXPIRED',{symbol:intent.symbol,reason:fresh??'IOC_LIMIT'});return false;}
        const liquidity=depth(q),quantity=floor(Math.min(intent.quantity,liquidity.ask),intent.step);if(quantity<=0){reject(intent.signal,'IOC_NO_FILL:EXPIRED');event('ENTRY_NO_LIQUIDITY',{symbol:intent.symbol});return false;}
        const price=q.ask*(1+c.entryImpact),fee=quantity*price*c.feeRate,available=free();
        if(available===null||available+1e-9<quantity*price/c.leverage+fee){reject(intent.signal,'PORTFOLIO_CHANGED');event('ENTRY_FUNDS_CHANGED',{symbol:intent.symbol});return false;}
        liquidity.ask-=quantity;a.wallet-=fee;a.fees+=fee;a.turnover+=quantity*price;
        const id=`paper:${a.variant}:${a.nextPositionId++}:${intent.id}`,candidateState=initialReclaimState({positionId:id,entryAt:f.at,entryPrice:price,features:intent.features,limitPrice:intent.limit});
        const p={id,symbol:intent.symbol,ownership:'AUTO',side:'LONG',state:'OPEN',signalId:intent.id,entryAt:f.at,entryPrice:price,
          originalQuantity:quantity,quantity,entryFee:fee,exitFees:0,net:-fee,peakPrice:price,lastHighAt:f.at,stopPrice:price*(1-intent.features.stopPct),
          step:intent.step,priceTick:intent.tick,policy:intent.features.exitPolicy??{},qv3:f.at>=QV3_AT,reclaimState:candidateState,
          lastCandleOpen:Math.floor(f.at/MINUTE)*MINUTE-MINUTE,exitFills:[],funding:[],signal:intent.signal};
        intent.signal.status='FILLED';a.positions.push(p);event('ENTRY_FILL',{symbol:p.symbol,signalId:p.signalId,quantity,price});return true;
      };
      for(const intent of [...a.pendingEntries])if(intent.due<=f.at){a.pendingEntries=a.pendingEntries.filter(x=>x!==intent);fillEntry(intent);}
      // Recreate the production generator only when v17_market_scan_runs
      // advances. The shadow observer samples every minute but the generator
      // actually scans about every five minutes.
      if(f.complete&&scanEvent){
        const candidates=[...f.signals].sort((x,y)=>x.features.rank-y.features.rank||x.id.localeCompare(y.id));
        for(const signal of candidates)a.opportunityIds.add(signal.id);
        const held=new Set(a.positions.map(p=>p.symbol)),capacity=Math.max(0,c.maxSlots-held.size);let inserted=0;
        for(const raw of candidates){
          if(inserted>=capacity)break;if(!raw.id||!raw.features?.symbol)throw Error('INVALID_SIGNAL');
          const ft=raw.features,symbol=ft.symbol,signalBarAt=number(ft.signal5Open);
          if(held.has(symbol)||entryFresh(ft,f.at,ft.referenceClose))continue;
          const recent=a.signalHistory.some(s=>s.symbol===symbol&&s.signalBarAt>=f.at-30*MINUTE&&['NEW','CLAIMED','ORDERED','FILLED','CLOSED'].includes(s.status));
          if(recent||a.generatedSignalIds.has(raw.id))continue;
          const signal={id:raw.id,symbol,features:ft,signalBarAt,entryBarAt:number(ft.signal5Close),createdAt:f.at,status:'NEW',rejectReason:null};
          a.generatedSignalIds.add(raw.id);a.signalHistory.push(signal);a.signalQueue.push(signal);inserted++;event('SIGNAL_GENERATED',{symbol,signalId:signal.id,scanId:f.scanId});
        }
      }
      // One executor cycle per observation. It claims the newest signal first
      // and may skip at most three symbol-scoped failures, matching production.
      if(f.complete&&a.positions.length+a.pendingEntries.length<c.maxSlots){
        const occupied=new Set([...a.positions.map(p=>p.symbol),...a.pendingEntries.map(p=>p.symbol)]);
        const queue=a.signalQueue.filter(s=>s.status==='NEW'&&s.entryBarAt>=f.at-5*MINUTE&&!occupied.has(s.symbol))
          .sort((x,y)=>y.entryBarAt-x.entryBarAt||number(x.features.rank)-number(y.features.rank)||x.id.localeCompare(y.id)).slice(0,3);
        for(const signal of queue){
          signal.status='CLAIMED';const ft=signal.features,q=quotes.get(signal.symbol);
          const initialFresh=entryFresh(ft,f.at,ft.referenceClose);if(initialFresh){reject(signal,initialFresh);continue;}
          if(!f.snapshot.available){reject(signal,`SNAPSHOT_INVALID:${f.snapshot.ageMs}`);break;}
          if(!/^[A-Z0-9]+USDT$/.test(signal.symbol)){reject(signal,'GW_400:only Binance USDT symbols are allowed');continue;}
          if(!(ft.stopPct>0&&ft.stopPct<1)){reject(signal,'V17_EXIT_POLICY_INVALID');break;}
          if(!q||((q.ask/q.bid-1)*10000>25)){reject(signal,`ENTRY_SPREAD:${q?(q.ask/q.bid-1)*10000:999}`);continue;}
          let intent;try{intent={...paperIntent(q.ask,f.rules[signal.symbol],c),id:signal.id,signal,features:ft,symbol:signal.symbol,due:f.at+c.latencyMs};}
          catch(error){reject(signal,String(error.message??error));continue;}
          const finalFresh=entryFresh(ft,f.at,intent.limit);if(finalFresh){reject(signal,finalFresh);continue;}
          if(f.at>=QV3_AT){
            const bars=(candles.get(signal.symbol)??[]).filter(x=>x.closeTime<f.at).map(x=>[x.openTime,x.open,x.high,x.low,x.close,x.volume,x.closeTime]);
            const gate=qv3Entry(bars,f.at);
            if(!gate.available||gate.wouldBlock){signal.status='NEW';event('QV3_ENTRY_DEFER',{symbol:signal.symbol,reason:gate.reason});break;}
          }
          if((a.variant==='B'||a.variant==='D')&&entryDecision(ft,intent.limit).wouldBlock){a.entryBlocks++;reject(signal,'V21_DECAY_NO_RECLAIM');event('V21_ENTRY_BLOCK',{symbol:signal.symbol});continue;}
          const available=free();if(available===null||available<intent.reserve){signal.status='NEW';event('FUNDS_UNAVAILABLE',{symbol:signal.symbol});break;}
          signal.status='ORDERED';event('ENTRY_INTENT',{symbol:signal.symbol,quantity:intent.quantity,limit:intent.limit});
          if(c.latencyMs===0){if(fillEntry(intent))break;}else{a.pendingEntries.push(intent);break;}
        }
      }
      const equity=valuation();if(equity!==null){a.peakEquity=Math.max(a.peakEquity,equity);a.maxDrawdown=Math.max(a.maxDrawdown,a.peakEquity-equity);}
      a.curve.push({at:f.at,wallet:a.wallet,equity,free:free(),positions:a.positions.length,reserved:sum(a.pendingEntries,p=>p.reserve)});
    }
    priorAt=f.at;
  }
  for(const a of Object.values(accounts)){
    const wins=a.closed.filter(p=>p.net>0),losses=a.closed.filter(p=>p.net<0),last=a.curve.at(-1),grossProfit=sum(wins,p=>p.net),grossLoss=-sum(losses,p=>p.net);
    const ordered=[...a.closed].sort((x,y)=>x.closedAt-y.closedAt),streak=ordered.reduce((s,p)=>({run:p.net<0?s.run+1:0,max:Math.max(s.max,p.net<0?s.run+1:0)}),{run:0,max:0});
    a.summary={startEquity:c.initialBalance,endEquity:round(last?.equity),netPnl:round(last?.equity-c.initialBalance),realizedNet:round(sum(a.closed,p=>p.net)),
      closed:a.closed.length,open:a.positions.length,pending:a.pendingEntries.length,opportunities:a.opportunityIds.size,generatedSignals:a.signalHistory.length,
      rejectedSignals:a.signalHistory.filter(s=>s.status==='REJECTED').length,entryBlocks:a.entryBlocks,
      winRate:round(a.closed.length?wins.length/a.closed.length:null),averageWin:round(wins.length?grossProfit/wins.length:null),averageLoss:round(losses.length?-grossLoss/losses.length:null),
      profitFactor:round(grossLoss?grossProfit/grossLoss:null),expectancy:round(a.closed.length?sum(a.closed,p=>p.net)/a.closed.length:null),
      fees:round(a.fees),funding:round(a.funding),maxDrawdown:round(a.maxDrawdown),worstTrade:round(a.closed.length?Math.min(...a.closed.map(p=>p.net)):null),
      maxConsecutiveLosses:streak.max,incompleteFrames:a.incomplete,candidateQuoteUnavailable:a.candidateQuoteUnavailable};
    a.generatedSignals=a.signalHistory.map(({id,symbol,signalBarAt,entryBarAt,createdAt,status,rejectReason})=>({id,symbol,signalBarAt,entryBarAt,createdAt,status,rejectReason}));
    delete a.signalQueue;delete a.signalHistory;delete a.generatedSignalIds;delete a.opportunityIds;delete a.liquidity;
  }
  return {settings:c,accounts};
}

const scenarioSettings={
  normal_adverse:{feeRate:.0005,entryImpact:0,baselineExitImpact:0,candidateExitImpact:.001,latencyMs:0,sameEntryCandle:'ADVERSE_FIRST'},
  normal_skip:{feeRate:.0005,entryImpact:0,baselineExitImpact:0,candidateExitImpact:.001,latencyMs:0,sameEntryCandle:'SKIP'},
  stress_adverse:{feeRate:.001,entryImpact:.0002,baselineExitImpact:.002,candidateExitImpact:.002,latencyMs:0,sameEntryCandle:'ADVERSE_FIRST'},
  stress_skip:{feeRate:.001,entryImpact:.0002,baselineExitImpact:.002,candidateExitImpact:.002,latencyMs:0,sameEntryCandle:'SKIP'},
  stress_delay_adverse:{feeRate:.001,entryImpact:.0002,baselineExitImpact:.002,candidateExitImpact:.002,latencyMs:60000,sameEntryCandle:'ADVERSE_FIRST'},
  stress_delay_skip:{feeRate:.001,entryImpact:.0002,baselineExitImpact:.002,candidateExitImpact:.002,latencyMs:60000,sameEntryCandle:'SKIP'},
};
const scenarios=Object.fromEntries(Object.entries(scenarioSettings).map(([name,settings])=>[name,replay(settings)]));
const result={protocol:protocol.protocol,model:'V21_INDEPENDENT_ACCOUNT_REPLAY_2',executionEnabled:false,livePromotion:false,
  generatedAt:new Date().toISOString(),input:{shadowFile,marketDir,snapshotFile,snapshotRows:snapshotRows.length,rawShadowRows:rawShadow.length,rawFrames:rawFrameCount,excludedFrames:rawFrameCount-frames.length,
    rawLastFrame:iso(rawLastFrame),frames:frames.length,firstFrame:iso(frames[0].at),lastFrame:iso(frames.at(-1).at),signalSymbols:signalSymbols.length,
    commonCandleStart:iso(commonCandleStart),commonCandleEnd:iso(commonCandleEnd),candleRows:candleRows.length,candleSymbols:candles.size,
    fundingRows:funding.length,fundingFailures},scenarios,
  limitations:['Point-in-time L1 depth is an execution assumption, not a queue guarantee','V21 exit freshness is unavailable in V18 frames and therefore preserves baseline',
    'Same-entry-minute native stop uses explicit adverse-first and skip bounds','Starts each candidate flat with independent 100 USDT rather than inheriting live positions',
    'Frames after the common exact-candle horizon are excluded instead of being forward-filled']};
fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({input:result.input,summaries:Object.fromEntries(Object.entries(scenarios).map(([name,x])=>[name,Object.fromEntries(variants.map(v=>[v,x.accounts[v].summary]))]))},null,2));
