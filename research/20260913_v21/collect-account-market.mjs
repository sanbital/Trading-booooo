#!/usr/bin/env node
/**
 * Read-only, post-hoc market collector for the frozen prospective paper-account
 * observations. Static Binance Vision archives are checksum verified. Funding
 * history is retained with its retrieval status and is never used as a signal.
 */
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync,gzipSync} from 'node:zlib';

const [evidenceDir,outputDir]=process.argv.slice(2);
if(!evidenceDir||!outputDir)throw Error('Usage: node collect-account-market.mjs EVIDENCE_DIR OUTPUT_DIR');
const lines=gunzipSync(readFileSync(`${evidenceDir}/strategy-shadow.jsonl.gz`)).toString('utf8').trim().split('\n');
const observations=lines.map(JSON.parse).filter(row=>(row.payload??row).source?.market?.version==='V18_PAPER_MARKET_1');
if(!observations.length)throw Error('NO_PAPER_MARKET_OBSERVATIONS');
const frames=observations.map(row=>row.payload??row).sort((a,b)=>Date.parse(a.source.market.observedAt)-Date.parse(b.source.market.observedAt));
const firstAt=Date.parse(frames[0].source.market.observedAt),lastAt=Date.parse(frames.at(-1).source.market.observedAt);
const symbols=new Set();
for(const frame of frames)for(const confirmation of frame.source?.confirmations??[]){
  const symbol=String(confirmation.symbol??confirmation.feature?.symbol??'').toUpperCase();
  if(symbol)symbols.add(symbol);
}
if(!symbols.size)throw Error('NO_CONFIRMED_SYMBOLS');
const utcDay=ms=>new Date(ms).toISOString().slice(0,10);
const normalizeTimestamp=value=>{let n=Number(value);if(!Number.isFinite(n))return null;while(n>10_000_000_000_000)n/=1000;return Math.trunc(n);};
function parseCsv(text,symbol){
  const rows=[];
  for(const line of text.trim().split(/\r?\n/)){
    if(!line||/^open_time,/i.test(line))continue;
    const c=line.split(','),openTime=normalizeTimestamp(c[0]),closeTime=normalizeTimestamp(c[6]);
    const [open,high,low,close,volume]=c.slice(1,6).map(Number);
    if(c.length<7||!Number.isSafeInteger(openTime)||openTime%60000||closeTime!==openTime+59999||
      ![open,high,low,close,volume].every(Number.isFinite)||Math.min(open,high,low,close)<=0||
      high<Math.max(open,close)||low>Math.min(open,close)||volume<0)throw Error(`INVALID_CSV:${symbol}`);
    if(openTime>=firstAt-60000&&openTime<=lastAt+6*3600000)rows.push({symbol,openTime,open,high,low,close,volume,closeTime});
  }
  return rows;
}
const needs=[];for(const symbol of [...symbols].sort())for(let day=Date.parse(`${utcDay(firstAt)}T00:00:00Z`);day<=lastAt;day+=86400000)needs.push({symbol,date:utcDay(day)});
const temporary=mkdtempSync(join(tmpdir(),'v21-account-market-')),candles=new Map(),archives=[];
let cursor=0;
async function collectArchive({symbol,date}){
  const filename=`${symbol}-1m-${date}.zip`;
  const url=`https://data.binance.vision/data/futures/um/daily/klines/${encodeURIComponent(symbol)}/1m/${encodeURIComponent(filename)}`;
  try{
    const [checksumResponse,zipResponse]=await Promise.all([
      fetch(url+'.CHECKSUM',{signal:AbortSignal.timeout(30000)}),
      fetch(url,{signal:AbortSignal.timeout(45000)}),
    ]);
    if(!checksumResponse.ok||!zipResponse.ok)return {symbol,date,ok:false,reason:`HTTP_${checksumResponse.status}_${zipResponse.status}`};
    const expected=(await checksumResponse.text()).trim().match(/^[0-9a-f]{64}/i)?.[0]?.toLowerCase();
    const bytes=Buffer.from(await zipResponse.arrayBuffer()),actual=createHash('sha256').update(bytes).digest('hex');
    if(!expected||actual!==expected)return {symbol,date,ok:false,reason:expected?'CHECKSUM_MISMATCH':'CHECKSUM_INVALID'};
    const file=join(temporary,createHash('sha256').update(symbol+date).digest('hex').slice(0,20)+'.zip');
    writeFileSync(file,bytes);const unzip=spawnSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:32*1024*1024});
    if(unzip.status!==0)return {symbol,date,ok:false,reason:'UNZIP_FAILED'};
    const parsed=parseCsv(unzip.stdout,symbol);for(const candle of parsed)candles.set(`${symbol}:${candle.openTime}`,candle);
    return {symbol,date,ok:true,sha256:actual,bytes:bytes.length,archiveRows:unzip.stdout.trim().split(/\r?\n/).length,retainedRows:parsed.length};
  }catch(error){return {symbol,date,ok:false,reason:String(error instanceof Error?error.message:error).slice(0,160)};}
}
async function worker(){while(cursor<needs.length){const i=cursor++;archives[i]=await collectArchive(needs[i]);}}
await Promise.all(Array.from({length:Math.min(8,needs.length)},worker));
rmSync(temporary,{recursive:true,force:true});

const funding=[];
for(const symbol of [...symbols].sort()){
  const params=new URLSearchParams({symbol,startTime:String(firstAt-8*3600000),endTime:String(lastAt+8*3600000),limit:'1000'});
  try{
    const response=await fetch('https://fapi.binance.com/fapi/v1/fundingRate?'+params,{signal:AbortSignal.timeout(30000)});
    if(!response.ok){funding.push({symbol,ok:false,reason:`HTTP_${response.status}`});continue;}
    const rows=await response.json();if(!Array.isArray(rows))throw Error('FUNDING_SHAPE');
    for(const row of rows){
      const fundingTime=Number(row.fundingTime),fundingRate=Number(row.fundingRate),markPrice=Number(row.markPrice);
      if(!Number.isSafeInteger(fundingTime)||!Number.isFinite(fundingRate)||!Number.isFinite(markPrice)||markPrice<=0)throw Error('FUNDING_ROW');
      funding.push({symbol,ok:true,fundingTime,fundingRate,markPrice});
    }
  }catch(error){funding.push({symbol,ok:false,reason:String(error instanceof Error?error.message:error).slice(0,160)});}
}
const candleRows=[...candles.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.openTime-b.openTime);
const summary={source:'BINANCE_VISION_CHECKSUM_ARCHIVE_AND_BINANCE_FUNDING_HISTORY',executionInput:false,
  retrievedAt:new Date().toISOString(),firstObservation:new Date(firstAt).toISOString(),lastObservation:new Date(lastAt).toISOString(),
  observationRows:observations.length,requiredSymbols:symbols.size,requestedArchives:needs.length,
  successfulArchives:archives.filter(x=>x.ok).length,failedArchives:archives.filter(x=>!x.ok),
  candleRows:candleRows.length,fundingRows:funding.filter(x=>x.ok).length,fundingFailures:funding.filter(x=>!x.ok),archives};
mkdirSync(outputDir,{recursive:true});
writeFileSync(`${outputDir}/candles.jsonl.gz`,gzipSync(candleRows.map(JSON.stringify).join('\n')+'\n',{level:9}));
writeFileSync(`${outputDir}/funding.jsonl`,funding.map(JSON.stringify).join('\n')+'\n');
writeFileSync(`${outputDir}/summary.json`,JSON.stringify(summary,null,2)+'\n');
const names=['candles.jsonl.gz','funding.jsonl','summary.json'];
writeFileSync(`${outputDir}/manifest.sha256`,names.map(name=>`${createHash('sha256').update(readFileSync(`${outputDir}/${name}`)).digest('hex')}  ${name}`).join('\n')+'\n');
console.log(JSON.stringify({requiredSymbols:summary.requiredSymbols,observationRows:summary.observationRows,successfulArchives:summary.successfulArchives,
  failedArchives:summary.failedArchives.length,candleRows:summary.candleRows,fundingRows:summary.fundingRows,fundingFailures:summary.fundingFailures.length}));
