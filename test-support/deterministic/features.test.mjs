import test from 'node:test';import assert from 'node:assert/strict';
import {completedFeatures,createFeatureCache,candles} from '../../supabase/functions/_shared/deterministic/features.mjs';
import {selectTop20} from '../../supabase/functions/_shared/deterministic/universe.mjs';
import {decisionGraph} from './dependency-graph.mjs';
import {AT} from './fixtures.mjs';
const series=(n,interval,end=AT)=>Array.from({length:n},(_,i)=>{const t=Math.floor(end/interval)*interval-(n-i)*interval,p=100+i*.05+Math.sin(i)*.02;
 return [t,p,p+.1,p-.1,p+.04,10,t+interval-1,1000+i*5,30,6,(1000+i*5)*.6,0];});
test('complete candle features use only closed candles; a missing candle invalidates data',()=>{
 const one=series(121,60000),five=series(49,300000),btc=series(121,60000),f=completedFeatures({one,five,btc,at:AT});
 assert.equal(f.quality.candles_complete,true);for(const name of ['ema9','ema20','ema50','ema20_slope','rsi_1m_14','rsi_5m_14','stoch_k_1m','bb_width','atr_1m_14_normalized','quote_volume_5m_usdt','volume_ratio_5m_vs_60m','last_body','last_upper_wick','last_lower_wick','btc_atr_normalized'])assert.ok(Number.isFinite(f.values[name]),name);
 const incomplete=one.filter((_,i)=>i!==60);assert.throws(()=>completedFeatures({one:incomplete,five,btc,at:AT}),/INCOMPLETE_CANDLES/);
 const future=series(1,60000,AT+60000);assert.equal(candles([...one,...future],60000,AT).length,121);
});
test('concurrent reads share completed candles and the BTC sensor within each minute',async()=>{
 const calls=[],cache=createFeatureCache({now:()=>AT,fetchFn:async url=>{const u=new URL(url);calls.push(url);return {ok:true,json:async()=>series(Number(u.searchParams.get('limit')),u.searchParams.get('interval')==='1m'?60000:300000)};}});
 await Promise.all([cache.read('AUSDT'),cache.read('AUSDT'),cache.read('BUSDT')]);assert.equal(calls.length,5);
 await cache.read('AUSDT');assert.equal(calls.length,5);
});
test('Top20 observation sorts 24h change and excludes invalid filters, stale books and spreads',()=>{
 const symbols=Array.from({length:26},(_,i)=>({symbol:'S'+i+'USDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',underlyingType:'COIN',filters:[{filterType:'LOT_SIZE',stepSize:'.1'},{filterType:'PRICE_FILTER',tickSize:'.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]})),
 tickers=symbols.map((s,i)=>({symbol:s.symbol,quoteVolume:'100000000',priceChangePercent:String(i),closeTime:AT-50})),
 books=symbols.map(s=>({symbol:s.symbol,bidPrice:'99.999',askPrice:'100.001',bidQty:'1000',askQty:'1000',time:AT-20}));
 symbols[25].status='SETTLING';symbols[24].filters[0].stepSize='0';books[23].time=AT-10001;books[22].askPrice='101';
 const result=selectTop20({symbols},tickers,books,AT);assert.equal(result.length,20);assert.equal(result[0].symbol,'S21USDT');assert.equal(result.at(-1).rank,20);
});
test('new executor and generator dependency closure contains no provider or historical AI authority',()=>{
 const graph=decisionGraph();assert.deepEqual(graph.provider_dependency_files,[]);assert.ok(graph.rpcs.includes('deterministic_entry_authority'));assert.ok(!graph.rpcs.some(x=>/gpt|deepseek|ai_/.test(x)));
 assert.deepEqual(graph.external_imports,['https://esm.sh/@supabase/supabase-js@2.57.4','node:async_hooks']);
});
