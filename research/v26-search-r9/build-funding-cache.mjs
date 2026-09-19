import { readFileSync, writeFileSync } from "node:fs";
const START=Number(process.env.REPLAY_START_MS||1787152200000),END=Number(process.env.REPLAY_END_MS||1789744200000);
const symbols=JSON.parse(readFileSync(new URL("./results-development-30d/funding-symbols.json",import.meta.url),"utf8"));
const reusable=new Map();
for(const path of String(process.env.SEED_FUNDING_CACHES||"").split(",").filter(Boolean)){
  const seed=JSON.parse(readFileSync(path,"utf8"));
  for(const x of seed.coverage||[])if(Number(x.startTime)<=START&&Number(x.endTime)>=END)
    reusable.set(x.symbol,{symbol:x.symbol,startTime:START,endTime:END,events:(x.events||[]).filter(row=>Number(row.fundingTime)>=START&&Number(row.fundingTime)<=END)});
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchSymbol(symbol){
  const url=new URL("https://fapi.binance.com/fapi/v1/fundingRate");url.searchParams.set("symbol",symbol);url.searchParams.set("startTime",String(START));url.searchParams.set("endTime",String(END));url.searchParams.set("limit","1000");
  let last;for(let attempt=1;attempt<=6;attempt++)try{
    const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});if(!response.ok)throw Error(`HTTP_${response.status}`);
    const rows=await response.json();if(!Array.isArray(rows)||rows.some(row=>row.symbol!==symbol||!Number.isSafeInteger(Number(row.fundingTime))||!Number.isFinite(Number(row.fundingRate))||!(Number(row.markPrice)>0)))throw Error("INVALID_ROWS");
    return {symbol,startTime:START,endTime:END,events:rows};
  }catch(error){last=error;if(attempt<6)await sleep(attempt*1500);}
  throw Error(`FUNDING_FETCH_FAILED:${symbol}:${last?.message||last}`);
}
const coverage=[];for(const symbol of symbols)coverage.push(reusable.get(symbol)||await fetchSymbol(symbol));coverage.sort((a,b)=>a.symbol.localeCompare(b.symbol));
writeFileSync(new URL("./funding-cache-development-30d.json",import.meta.url),JSON.stringify({schemaVersion:1,source:"BINANCE_USDM_FUNDING_RATE_HISTORY",verifiedCoverage:true,coverage},null,2)+"\n");
console.log("FUNDING_CACHE_COMPLETE",coverage.length,"REUSED",symbols.filter(x=>reusable.has(x)).length,"FETCHED",symbols.filter(x=>!reusable.has(x)).length);
