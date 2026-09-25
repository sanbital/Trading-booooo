export function summarizeCapture(ring,now){
 const rows=ring.filter(r=>Date.parse(r.payload.available_at)<=now).slice(-12),last=rows.at(-1)?.payload;
 const unavailable=reason=>({version:'CAPTURE-CONTEXT-1',status:'UNAVAILABLE',reason});
 if(rows.length!==12 || !last)return unavailable('WARMUP');
 const p=rows.map(r=>r.payload),end=Date.parse(last.interval_end),start=Date.parse(p[0].interval_start);
 if(now-end>25000 || end>now)return unavailable('STALE');
 if(p.some(x=>!x.bucket_complete||!x.coverage_25||!x.coverage_50)||end-start<57000||end-start>63000)return unavailable('GAP_OR_DEPTH_COVERAGE');
 for(let i=1;i<p.length;i++)if(Math.abs(Date.parse(p[i].interval_start)-Date.parse(p[i-1].interval_end))>250)return unavailable('GAP');
 const sum=k=>p.reduce((s,x)=>s+x[k],0),ratio=(a,b)=>b>0?a/b:null,round=x=>x===null?null:Number(x.toPrecision(6));
 const spreads=p.map(x=>x.spread_bps).sort((a,b)=>a-b),median=(spreads[5]+spreads[6])/2;
 const change=(a,b)=>b>0?a/b-1:null;
 const values={spread_bps:last.spread_bps,spread_vs_60s_median:ratio(last.spread_bps,median),mid_return_60s:change(last.mid,p[0].mid),
   bid_depth_25_change:change(last.bid_25_usdt,p[0].bid_25_usdt),ask_depth_25_change:change(last.ask_25_usdt,p[0].ask_25_usdt),
   buy_share_5s:ratio(last.buy_quote_5s,last.buy_quote_5s+last.sell_quote_5s),buy_share_60s:ratio(sum('buy_quote_5s'),sum('buy_quote_5s')+sum('sell_quote_5s')),
   buy_quote_60s:sum('buy_quote_5s'),sell_quote_60s:sum('sell_quote_5s'),max_sell_quote_1s:last.sell_quote_max_1s,
   displayed_ask_added_per_s:sum('displayed_ask_added_5s')/((end-start)/1000),displayed_ask_removed_per_s:sum('displayed_ask_removed_5s')/((end-start)/1000),
   buy_impact_450_bps:last.buy_vwap_450>0?(last.buy_vwap_450/last.mid-1)*10000:null,sell_impact_450_bps:last.sell_vwap_450>0?(1-last.sell_vwap_450/last.mid)*10000:null};
 if(Object.values(values).some(x=>x!==null&&!Number.isFinite(x)))return unavailable('INVALID_NUMERIC');
 return {version:'CAPTURE-CONTEXT-1',status:'AVAILABLE',start_ms:start,end_ms:end,buckets:12,values:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,round(v)]))};
}
