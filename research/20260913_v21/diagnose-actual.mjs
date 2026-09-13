#!/usr/bin/env node
/**
 * Reconstructs realized bot trades and sampled paths without treating sampled
 * peaks/bids as complete MFE/MAE. Read-only; no venue or database calls.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';

const [inputFile,replayFile,shadowFile,outputFile]=process.argv.slice(2);
if(!inputFile||!replayFile||!shadowFile||!outputFile)
  throw Error('Usage: node diagnose-actual.mjs INPUT.json REPLAY.json SHADOW.jsonl.gz OUTPUT.json');
const input=JSON.parse(fs.readFileSync(inputFile,'utf8'));
const replay=JSON.parse(fs.readFileSync(replayFile,'utf8'));
const num=v=>v===null||v===''||v===undefined?null:(Number.isFinite(Number(v))?Number(v):null);
const ms=v=>Number.isFinite(Date.parse(v))?Date.parse(v):null;
const sum=(rows,fn=x=>x)=>rows.reduce((s,x)=>s+Number(fn(x)??0),0);
const round=(v,d=9)=>Number.isFinite(v)?Number(v.toFixed(d)):null;
const quantile=(values,q)=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*q,l=Math.floor(i),h=Math.ceil(i);return round(a[l]+(a[h]-a[l])*(i-l));};
const bump=(o,k,n=1)=>o[k]=(o[k]??0)+n;
async function gzRows(file){const rows=[];const lines=readline.createInterface({input:fs.createReadStream(file).pipe(zlib.createGunzip()),crlfDelay:Infinity});for await(const line of lines)if(line.trim())rows.push(JSON.parse(line));return rows;}

const qv3At=Date.parse('2026-09-11T15:20:00Z');
const devCutoff=Date.parse('2026-09-13T00:17:57.553824Z');
const priorValidationEnd=Date.parse('2026-09-12T12:54:14.867543Z');
const signals=new Map(input.signals.map(x=>[x.id,x]));
const ordersByPosition=new Map(),fillsByPosition=new Map(),decisionsByPosition=new Map();
for(const x of input.orders){if(!x.position_id)continue;let a=ordersByPosition.get(x.position_id);if(!a)ordersByPosition.set(x.position_id,a=[]);a.push(x);}
for(const x of input.fills){if(!x.v17_position_id)continue;let a=fillsByPosition.get(x.v17_position_id);if(!a)fillsByPosition.set(x.v17_position_id,a=[]);a.push(x);}
for(const x of input.decisions){if(!x.position_id)continue;let a=decisionsByPosition.get(x.position_id);if(!a)decisionsByPosition.set(x.position_id,a=[]);a.push(x);}
for(const m of [ordersByPosition,fillsByPosition,decisionsByPosition])for(const a of m.values())a.sort((x,y)=>ms(x.created_at??x.executed_at??x.decided_at)-ms(y.created_at??y.executed_at??y.decided_at));

function cohort(t){return t<qv3At?'PRE_QV3':t<=priorValidationEnd?'QV3_EARLY':t<=devCutoff?'QV3_LATE_DEV':'LOCKED_HOLDOUT';}
function band(v,cuts,labels){if(!Number.isFinite(v))return 'MISSING';for(let i=0;i<cuts.length;i++)if(v<cuts[i])return labels[i];return labels.at(-1);}
const positions=input.positions.filter(p=>p.state==='CLOSED'&&p.side==='LONG'&&ms(p.entry_at)!==null).sort((a,b)=>ms(a.entry_at)-ms(b.entry_at));
const rows=positions.map(p=>{
  const entryAt=ms(p.entry_at),exitAt=ms(p.closed_at),entry=num(p.entry_price),exit=num(p.exit_price),qty=num(p.original_quantity),f=p.metadata?.entryFeatures??signals.get(p.signal_id)?.features??{};
  const os=ordersByPosition.get(p.id)??[],fsx=fillsByPosition.get(p.id)??[],ds=decisionsByPosition.get(p.id)??[];
  const openOrder=os.find(x=>x.intent==='OPEN_LONG'),autoFills=fsx.filter(x=>x.source==='AUTOMATED'),entryFills=autoFills.filter(x=>x.side==='BUY'),exitFills=autoFills.filter(x=>x.side==='SELL');
  const closeOrders=os.filter(x=>x.intent!=='OPEN_LONG'),lastCloseOrder=closeOrders.at(-1),protectionOrders=p.metadata?.exitProtection?.orders??[];
  const firstFill=entryFills.length?Math.min(...entryFills.map(x=>ms(x.executed_at))):null,lastFill=exitFills.length?Math.max(...exitFills.map(x=>ms(x.executed_at))):null;
  const observedMfe=Math.max(0,entry&&num(p.peak_price)?num(p.peak_price)/entry-1:0,...ds.map(x=>num(x.details?.observedMfe)??0));
  const observedMae=Math.min(0,entry&&exit?exit/entry-1:0,...ds.map(x=>num(x.details?.priceReturn)??0));
  const net=num(p.realized_pnl_usdt)??0,fees=sum(autoFills,x=>num(x.fee_quote_amount)),gross=sum(autoFills,x=>num(x.realized_pnl_quote));
  const limit=num(openOrder?.request_payload?.order?.price),reference=num(f.referenceClose),notional=entry*qty;
  const hardStop=num(p.hard_stop_price),native=/NATIVE_STOP/.test(String(p.exit_reason));
  return {id:p.id,signalId:p.signal_id,symbol:p.symbol,cohort:cohort(entryAt),patch:p.metadata?.executorPatch??'UNKNOWN',entryAt,exitAt,entry,exit,qty,net,fees,gross,reason:p.exit_reason,
    durationMs:exitAt-entryAt,observedMfe,observedMae,observedGiveback:Math.max(0,observedMfe*notional-net),feature:f,
    limit,reference,chaseBps:reference?round((entry/reference-1)*10000):null,limitVsReferenceBps:reference&&limit?round((limit/reference-1)*10000):null,
    signalToFillMs:firstFill&&num(f.signal5Close)?firstFill-num(f.signal5Close):null,orderToFillMs:firstFill&&openOrder?firstFill-ms(openOrder.created_at):null,
    orderRttMs:num(openOrder?.response_timing?.round_trip_ms),spreadBps:num(openOrder?.request_payload?.spread_bps),entryGapAtr:num(openOrder?.request_payload?.entry_gap_atr),
    entryFillCount:entryFills.length,exitFillCount:exitFills.length,firstFill,lastFill,ledgerComplete:entryFills.length>0&&exitFills.length>0,
    native,hardStop,nativeStopSlippageBps:native&&hardStop?round((exit/hardStop-1)*10000):null,
    closeOrderRttMs:num(lastCloseOrder?.response_timing?.round_trip_ms),exitDetectionToFillMs:lastFill&&num(p.metadata?.exitTelemetry?.detectedAtMs)?lastFill-num(p.metadata.exitTelemetry.detectedAtMs):null,
    protectionOrderCount:protectionOrders.length,protectionCancelErrors:protectionOrders.filter(x=>x.cancelError).length};
});

function stats(rs){
  const wins=rs.filter(x=>x.net>0),losses=rs.filter(x=>x.net<0),gp=sum(wins,x=>x.net),gl=-sum(losses,x=>x.net);
  let eq=100,peak=100,dd=0,run=0,maxRun=0;for(const x of [...rs].sort((a,b)=>a.exitAt-b.exitAt)){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);run=x.net<0?run+1:0;maxRun=Math.max(maxRun,run);}
  const top=[...rs].sort((a,b)=>b.net-a.net).slice(0,3),topIds=new Set(top.map(x=>x.id));
  return {trades:rs.length,net:round(sum(rs,x=>x.net)),fees:round(sum(rs,x=>x.fees)),grossLedger:round(sum(rs,x=>x.gross)),wins:wins.length,losses:losses.length,
    winRate:round(rs.length?wins.length/rs.length:null),averageWin:round(wins.length?gp/wins.length:null),averageLoss:round(losses.length?-gl/losses.length:null),
    profitFactor:round(gl?gp/gl:null),expectancy:round(rs.length?sum(rs,x=>x.net)/rs.length:null),maxDrawdown:round(dd),worstTrade:round(rs.length?Math.min(...rs.map(x=>x.net)):null),
    maxConsecutiveLosses:maxRun,top3Net:round(sum(top,x=>x.net)),excludingTop3Net:round(sum(rs.filter(x=>!topIds.has(x.id)),x=>x.net)),
    observedGiveback:round(sum(rs,x=>x.observedGiveback)),profitThenNonpositive:rs.filter(x=>x.observedMfe>0&&x.net<=0).length,
    reachedObservedHalfPct:rs.filter(x=>x.observedMfe>=.005).length,lossesBelowObservedHalfPct:losses.filter(x=>x.observedMfe<.005).length,
    medianHoldMinutes:round(quantile(rs.map(x=>x.durationMs/60000),.5)),p90HoldMinutes:round(quantile(rs.map(x=>x.durationMs/60000),.9))};
}
function groups(keyFn,minN=1){const m=new Map();for(const r of rows){const k=keyFn(r);let a=m.get(k);if(!a)m.set(k,a=[]);a.push(r);}return Object.fromEntries([...m].filter(([,a])=>a.length>=minN).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))).map(([k,a])=>[k,stats(a)]));}

const repeats=[];for(let i=0;i<rows.length;i++){
  const r=rows[i],prior=[...rows.slice(0,i)].reverse().find(x=>x.symbol===r.symbol&&x.exitAt<=r.entryAt);
  if(!prior)continue;const gapMs=r.entryAt-prior.exitAt;if(gapMs<=3600000)repeats.push({symbol:r.symbol,gapMinutes:round(gapMs/60000),priorNet:prior.net,net:r.net,priorLoss:prior.net<0,entryAt:r.entryAt});
}
const latencyFields=['signalToFillMs','orderToFillMs','orderRttMs','spreadBps','chaseBps','limitVsReferenceBps'];
const latency=Object.fromEntries(latencyFields.map(k=>[k,{n:rows.filter(x=>Number.isFinite(x[k])).length,median:quantile(rows.map(x=>x[k]),.5),p90:quantile(rows.map(x=>x[k]),.9),max:quantile(rows.map(x=>x[k]),1)}]));

const shadow=await gzRows(shadowFile),shadowAudit={rows:shadow.length,v18Frames:0,evaluated:0,incomplete:0,scanReasons:{},blocked:{},dataProblems:{},uniqueConfirmedSignals:new Set(),confirmationRows:0,quoteFrames:0};
for(const raw of shadow){const p=raw.payload??raw;if(p.source?.market?.version!=='V18_PAPER_MARKET_1')continue;shadowAudit.v18Frames++;if(p.evaluationState==='EVALUATED')shadowAudit.evaluated++;else shadowAudit.incomplete++;
  if((p.source?.market?.quotes??[]).length)shadowAudit.quoteFrames++;for(const [k,v] of Object.entries(p.source?.scan?.details?.reasons??{}))bump(shadowAudit.scanReasons,k,Number(v));
  const blocked=p.source?.scan?.details?.blocked;if(blocked)bump(shadowAudit.blocked,String(blocked));for(const x of p.dataProblems??[])bump(shadowAudit.dataProblems,String(x.code??x.reason??x));
  for(const x of p.source?.confirmations??[]){shadowAudit.confirmationRows++;if(x.feature)shadowAudit.uniqueConfirmedSignals.add(`${x.feature.symbol}:${x.feature.signal5Close}`);}
}
shadowAudit.uniqueConfirmedSignals=shadowAudit.uniqueConfirmedSignals.size;

const baseline=replay.scenarios.normal_adverse.accounts.A,replayStart=Date.parse(replay.input.firstFrame),replayEnd=Date.parse(replay.input.lastFrame);
const actualWindow=rows.filter(x=>x.entryAt>=replayStart&&x.entryAt<=replayEnd),replayed=[...baseline.closed,...baseline.positions];
const key=x=>x.feature?.signal5Close!==undefined?`${x.symbol}:${x.feature.signal5Close}`:x.signalId;
const actualMap=new Map();for(const x of actualWindow){const k=key(x);let a=actualMap.get(k);if(!a)actualMap.set(k,a=[]);a.push(x);}
const replayMap=new Map();for(const x of replayed){const k=key(x);let a=replayMap.get(k);if(!a)replayMap.set(k,a=[]);a.push(x);}
let matched=0;const priceErrors=[];for(const [k,a] of actualMap){const b=replayMap.get(k)??[],n=Math.min(a.length,b.length);matched+=n;for(let i=0;i<n;i++)priceErrors.push((b[i].entryPrice/a[i].entry-1)*10000);}
const replayFidelity={actualEntries:actualWindow.length,replayEntries:replayed.length,matchedEntries:matched,actualRecall:round(actualWindow.length?matched/actualWindow.length:null),
  replayPrecision:round(replayed.length?matched/replayed.length:null),decisionAgreement:round(Math.max(actualWindow.length,replayed.length)?matched/Math.max(actualWindow.length,replayed.length):null),
  medianMatchedEntryPriceErrorBps:quantile(priceErrors,.5),p90AbsMatchedEntryPriceErrorBps:quantile(priceErrors.map(Math.abs),.9),
  actualWindowNet:round(sum(actualWindow,x=>x.net)),replayWindowNet:baseline.summary.netPnl,passes99Pct:false};
replayFidelity.passes99Pct=replayFidelity.decisionAgreement>=.99&&replayFidelity.p90AbsMatchedEntryPriceErrorBps<=1;

const endpoints=rows.flatMap(x=>[{at:x.entryAt,d:1},{at:x.exitAt,d:-1}]).sort((a,b)=>a.at-b.at||a.d-b.d);let concurrent=0,maxConcurrent=0;
for(const x of endpoints){concurrent+=x.d;maxConcurrent=Math.max(maxConcurrent,concurrent);}
const overlaps=[];for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j];if(b.entryAt>=a.exitAt)break;if(a.entryAt<b.exitAt&&b.entryAt<a.exitAt)overlaps.push([a,b]);
}
const symbolGroups=[...new Set(rows.map(x=>x.symbol))].map(symbol=>({symbol,...stats(rows.filter(x=>x.symbol===symbol))}))
  .sort((a,b)=>b.trades-a.trades||a.net-b.net||a.symbol.localeCompare(b.symbol));
const queriedAt=ms(input.queried_at),last48=rows.filter(x=>x.entryAt>=queriedAt-48*3600000),sinceQv3=rows.filter(x=>x.entryAt>=qv3At);

const result={generatedAt:new Date().toISOString(),inputQueriedAt:input.queried_at,scope:{firstEntry:new Date(rows[0].entryAt).toISOString(),lastClose:new Date(Math.max(...rows.map(x=>x.exitAt))).toISOString(),positions:rows.length},
  reconciliation:{positionNet:round(sum(rows,x=>x.net)),attributedFillFees:round(sum(rows,x=>x.fees)),attributedFillGross:round(sum(rows,x=>x.gross)),
    positionMinusGrossLessFees:round(sum(rows,x=>x.net)-sum(rows,x=>x.gross-x.fees)),completeEntryAndExitLedger:rows.filter(x=>x.ledgerComplete).length,
    incompletePositionIds:rows.filter(x=>!x.ledgerComplete).map(x=>x.id),unattributedFills:input.unattributed_fills?.length??0},
  overall:stats(rows),windows:{last48Hours:stats(last48),sinceQv3:stats(sinceQv3)},cohorts:groups(x=>x.cohort),patches:groups(x=>x.patch),daysKst:groups(x=>new Date(x.entryAt+9*3600000).toISOString().slice(0,10)),
  exitReasons:groups(x=>x.reason),entryDiagnostics:{
    return15m:groups(x=>band(num(x.feature.return15m),[.015,.025,.05],['<1.5%','1.5-2.5%','2.5-5%','>=5%'])),
    return5m:groups(x=>band(num(x.feature.return5m),[.005,.01,.015],['<0.5%','0.5-1%','1-1.5%','>=1.5%'])),
    dayReturn:groups(x=>band(num(x.feature.dayReturn),[.10,.20,.35],['<10%','10-20%','20-35%','>=35%'])),
    volumeRatio:groups(x=>band(num(x.feature.volumeRatio),[1.5,2.5,4],['<1.5','1.5-2.5','2.5-4','>=4'])),
    rank:groups(x=>band(num(x.feature.rank),[2,4,7],['rank1','rank2-3','rank4-6','rank7-10'])),
    chaseBps:groups(x=>band(x.chaseBps,[0,10,25],['<0','0-10','10-25','>=25'])),
    kstHour:groups(x=>band(new Date(x.entryAt+9*3600000).getUTCHours(),[6,12,18],['00-05','06-11','12-17','18-23']))},
  sampledPath:{warning:'Observed peaks and decision bids are sparse lower/upper bounds, not complete intratrade MFE/MAE.',
    mfeMedian:quantile(rows.map(x=>x.observedMfe),.5),maeMedian:quantile(rows.map(x=>x.observedMae),.5),givebackTotal:round(sum(rows,x=>x.observedGiveback)),
    lossCount:rows.filter(x=>x.net<0).length,lossesBelowObservedHalfPct:rows.filter(x=>x.net<0&&x.observedMfe<.005).length,
    profitThenNonpositive:rows.filter(x=>x.observedMfe>0&&x.net<=0).length,halfPctThenNonpositive:rows.filter(x=>x.observedMfe>=.005&&x.net<=0).length},
  execution:{latency,exitDetectionToFillMs:{scope:'software close paths only; native-stop detection timestamps are not comparable',n:rows.filter(x=>!x.native&&Number.isFinite(x.exitDetectionToFillMs)).length,median:quantile(rows.filter(x=>!x.native).map(x=>x.exitDetectionToFillMs),.5),p90:quantile(rows.filter(x=>!x.native).map(x=>x.exitDetectionToFillMs),.9),max:quantile(rows.filter(x=>!x.native).map(x=>x.exitDetectionToFillMs),1)},
    closeOrderRttMs:{n:rows.filter(x=>Number.isFinite(x.closeOrderRttMs)).length,median:quantile(rows.map(x=>x.closeOrderRttMs),.5),p90:quantile(rows.map(x=>x.closeOrderRttMs),.9),max:quantile(rows.map(x=>x.closeOrderRttMs),1)},
    nativeStopSlippageBps:{n:rows.filter(x=>Number.isFinite(x.nativeStopSlippageBps)).length,median:quantile(rows.map(x=>x.nativeStopSlippageBps),.5),p10:quantile(rows.map(x=>x.nativeStopSlippageBps),.1),worst:quantile(rows.map(x=>x.nativeStopSlippageBps),0)},
    partialEntryPositions:rows.filter(x=>x.entryFillCount>1).length,partialExitPositions:rows.filter(x=>x.exitFillCount>1).length,
    protectedPositions:rows.filter(x=>x.protectionOrderCount>0).length,multipleProtectionGenerations:rows.filter(x=>x.protectionOrderCount>1).length,
    protectionCancelErrors:sum(rows,x=>x.protectionCancelErrors)},
  portfolio:{maxConcurrent,overlappingPairs:overlaps.length,bothReturn15mAtLeast2p5Pct:overlaps.filter(([a,b])=>num(a.feature.return15m)>=.025&&num(b.feature.return15m)>=.025).length,
    medianAbsoluteReturn15mDifference:quantile(overlaps.map(([a,b])=>Math.abs(num(a.feature.return15m)-num(b.feature.return15m))),.5),topSymbols:symbolGroups.slice(0,12)},
  repeats:{within30m:stats(repeats.filter(x=>x.gapMinutes<=30).map((x,i)=>({id:`r30:${i}`,net:x.net,exitAt:x.entryAt,durationMs:0,fees:0,observedGiveback:0,observedMfe:0}))),
    within60m:stats(repeats.map((x,i)=>({id:`r60:${i}`,net:x.net,exitAt:x.entryAt,durationMs:0,fees:0,observedGiveback:0,observedMfe:0}))),
    afterLossWithin60m:stats(repeats.filter(x=>x.priorLoss).map((x,i)=>({id:`rl:${i}`,net:x.net,exitAt:x.entryAt,durationMs:0,fees:0,observedGiveback:0,observedMfe:0}))),examples:repeats},
  shadowAudit,replayFidelity};
fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({scope:result.scope,reconciliation:result.reconciliation,overall:result.overall,cohorts:result.cohorts,sampledPath:result.sampledPath,execution:result.execution,repeats:result.repeats,replayFidelity,shadowAudit},null,2));
