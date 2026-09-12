#!/usr/bin/env python3
import argparse, bisect, csv, json, math, statistics, time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE='https://api.upbit.com/v1'
UTC=timezone.utc

def iso_z(dt):
    return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace('+00:00','Z')

def parse_utc(s):
    if not s: return None
    s=s.strip().replace('Z','+00:00')
    d=datetime.fromisoformat(s)
    if d.tzinfo is None: d=d.replace(tzinfo=UTC)
    return d.astimezone(UTC)

def fetch_json(path, params=None, retries=8):
    url=BASE+path
    if params: url += '?' + urlencode(params)
    last=None
    for i in range(retries):
        try:
            req=Request(url, headers={'Accept':'application/json','User-Agent':'Trading-booooo-research/1.0'})
            with urlopen(req, timeout=30) as r:
                out=json.loads(r.read().decode('utf-8'))
            time.sleep(0.115)
            return out
        except HTTPError as e:
            last=e
            if e.code in (418,429,500,502,503,504):
                time.sleep(min(5,0.5*(2**i))); continue
            raise
        except URLError as e:
            last=e; time.sleep(min(5,0.5*(2**i)))
    raise RuntimeError(f'API failed {url}: {last}')

def candle_ts(row):
    return parse_utc(row['candle_date_time_utc']+'Z')

def fetch_candles(market, start, end, seconds=False):
    path='/candles/seconds' if seconds else '/candles/minutes/1'
    cursor=end
    seen={}
    loops=0
    while cursor>start and loops<20:
        rows=fetch_json(path, {'market':market,'to':iso_z(cursor),'count':200})
        loops+=1
        if not rows: break
        oldest=None
        for r in rows:
            ts=candle_ts(r)
            oldest=ts if oldest is None or ts<oldest else oldest
            if start<=ts<end: seen[ts]=r
        if oldest is None or oldest<=start: break
        cursor=oldest
    return [seen[k] for k in sorted(seen)]

def tick_size_krw(p):
    if p>=1_000_000: return 1000.0
    if p>=500_000: return 500.0
    if p>=100_000: return 100.0
    if p>=50_000: return 50.0
    if p>=10_000: return 10.0
    if p>=5_000: return 5.0
    if p>=1_000: return 1.0
    if p>=100: return 1.0
    if p>=10: return 0.1
    if p>=1: return 0.01
    if p>=0.1: return 0.001
    if p>=0.01: return 0.0001
    if p>=0.001: return 0.00001
    if p>=0.0001: return 0.000001
    if p>=0.00001: return 0.0000001
    return 0.00000001

def floor_tick(p):
    t=tick_size_krw(p); return math.floor((p+1e-15)/t)*t

def ceil_tick(p):
    # Iterate because rounding can cross a KRW tick band.
    x=p
    for _ in range(4):
        t=tick_size_krw(x); y=math.ceil((x-1e-15)/t)*t
        if abs(y-x)<1e-15: return y
        x=y
    return x

def next_tick(p):
    return ceil_tick(p + tick_size_krw(p)*0.5000001)

def pct(a,b): return (a/b-1)*100 if b else 0.0

def net_ret(entry, exitp, buy_fee, sell_fee):
    return (exitp*(1-sell_fee)/(entry*(1+buy_fee))-1)*100

def quantile(vals,q):
    vals=sorted(v for v in vals if math.isfinite(v))
    if not vals: return None
    if len(vals)==1: return vals[0]
    x=(len(vals)-1)*q; lo=math.floor(x); hi=math.ceil(x)
    if lo==hi: return vals[lo]
    return vals[lo]*(hi-x)+vals[hi]*(x-lo)

def aggregate(vals):
    vals=[v for v in vals if v is not None and math.isfinite(v)]
    if not vals: return {'n':0}
    return {'n':len(vals),'mean':statistics.fmean(vals),'median':statistics.median(vals),
            'p05':quantile(vals,.05),'p10':quantile(vals,.10),'p90':quantile(vals,.90),'p95':quantile(vals,.95),
            'min':min(vals),'max':max(vals),'positive_rate':sum(v>0 for v in vals)/len(vals)}

def first_at_or_after(rows, ts):
    t=[candle_ts(r) for r in rows]
    i=bisect.bisect_left(t,ts)
    return rows[i] if i<len(rows) else None

def rows_between(rows, start, end):
    t=[candle_ts(r) for r in rows]
    i=bisect.bisect_left(t,start); j=bisect.bisect_right(t,end)
    return rows[i:j]

def terminal_path_stats(rows, entry_ts, entry, horizon_s, fee=0.0005):
    seg=rows_between(rows, entry_ts, entry_ts+timedelta(seconds=horizon_s))
    if not seg: return None
    last=seg[-1]['trade_price']; hi=max(r['high_price'] for r in seg); lo=min(r['low_price'] for r in seg)
    return {'gross_terminal_pct':pct(last,entry),'net_terminal_pct':net_ret(entry,last,fee,fee),
            'mfe_pct':pct(hi,entry),'mae_pct':pct(lo,entry),'terminal_price':last}

def current_fixed_sim(rows, entry_ts, entry, pattern, horizon_s=600, fee=0.0005, cost_buffer_bps=12.0):
    seg=rows_between(rows, entry_ts, entry_ts+timedelta(seconds=horizon_s))
    if not seg: return None
    momentum=(pattern or '').upper()=='MOMENTUM_CONTINUATION'
    protect=None; peak=entry; t1=False; realized=0.0; remaining=1.0; exit_reason='TIMEOUT'; exit_price=seg[-1]['trade_price']
    buy_cost=entry*(1+fee)
    for idx,r in enumerate(seg):
        hi=float(r['high_price']); lo=float(r['low_price']); close=float(r['trade_price'])
        peak=max(peak,hi)
        if not t1 and lo <= entry*0.96:
            exit_price=entry*0.96; exit_reason='SL4'; remaining=0; break
        if not t1 and hi >= entry*1.05:
            sell=0.5; realized += sell*entry*1.05*(1-fee); remaining-=sell; t1=True
        if t1:
            peak_ret=pct(peak,entry); floor_ret=max(3.0, peak_ret-1.5); floorp=entry*(1+floor_ret/100)
            if lo<=floorp:
                exit_price=floorp; realized += remaining*exit_price*(1-fee); remaining=0; exit_reason='RESIDUAL_TRAIL'; break
            continue
        mfe_bps=pct(peak,entry)*100
        candidate=protect or 0.0
        cost_trigger=max(20.0,cost_buffer_bps+(2.0 if not momentum else 2.0))
        lock_net=6.0 if momentum else 20.0
        profit_trigger=max(20.0,cost_buffer_bps+lock_net+2.0)
        trail_trigger=max(23.0,cost_buffer_bps+20.0)
        if mfe_bps>=cost_trigger: candidate=max(candidate,entry*(1+cost_buffer_bps/10000))
        if mfe_bps>=profit_trigger: candidate=max(candidate,entry*(1+(cost_buffer_bps+lock_net)/10000))
        if mfe_bps>=trail_trigger: candidate=max(candidate,peak*(1-(12.0 if momentum else 6.0)/10000))
        if candidate>0:
            candidate=floor_tick(candidate)
            candidate=min(candidate, peak-tick_size_krw(peak))
            locked_net_bps=(candidate/entry-1)*10000-cost_buffer_bps
            # Sanitizer: historical MFE cannot arm below/at current executable close.
            if close>candidate and locked_net_bps>0 and candidate>(protect or 0): protect=candidate
        if idx>0 and protect and lo<=protect:
            exit_price=protect; realized += remaining*exit_price*(1-fee); remaining=0; exit_reason='PRE_T1_PROTECT'; break
    if remaining>0: realized += remaining*exit_price*(1-fee)
    ret=(realized/buy_cost-1)*100
    return {'net_return_pct':ret,'exit_reason':exit_reason,'exit_price':exit_price,'protected_stop':protect}

def dynamic_sim(rows, entry_ts, entry, pattern, horizon_s=600, fee=0.0005, safety_bps=2.0, extra_tick=False):
    seg=rows_between(rows, entry_ts, entry_ts+timedelta(seconds=horizon_s))
    if not seg: return None
    momentum=(pattern or '').upper()=='MOMENTUM_CONTINUATION'
    buy_cost=entry*(1+fee); protect=None; peak=entry; t1=False; realized=0.0; remaining=1.0
    exit_reason='TIMEOUT'; exit_price=seg[-1]['trade_price']; armed=False
    for idx,r in enumerate(seg):
        hi=float(r['high_price']); lo=float(r['low_price']); close=float(r['trade_price'])
        peak=max(peak,hi)
        if not t1 and lo<=entry*0.96:
            exit_price=entry*0.96; exit_reason='SL4'; remaining=0; break
        if not t1 and hi>=entry*1.05:
            realized += .5*entry*1.05*(1-fee); remaining=.5; t1=True
        if t1:
            peak_ret=pct(peak,entry); floor_ret=max(3.0,peak_ret-1.5); floorp=entry*(1+floor_ret/100)
            if lo<=floorp:
                exit_price=floorp; realized += remaining*exit_price*(1-fee); remaining=0; exit_reason='RESIDUAL_TRAIL'; break
            continue
        # Upbit-specific economic floor: exact fee economics + monitor safety, rounded to current KRW tick ladder.
        raw=(buy_cost/((1-fee)*(1-safety_bps/10000)))
        be=ceil_tick(raw)
        if extra_tick: be=next_tick(be)
        exact_net_at_close=close*(1-fee)-buy_cost
        if close>be and exact_net_at_close>0:
            armed=True; protect=max(protect or 0,be)
        cost_buffer_bps=12.0
        mfe_bps=pct(peak,entry)*100
        lock_net=6.0 if momentum else 20.0
        profit_trigger=max(20.0,cost_buffer_bps+lock_net+2.0)
        trail_trigger=max(23.0,cost_buffer_bps+20.0)
        candidate=protect or 0.0
        if mfe_bps>=profit_trigger: candidate=max(candidate,entry*(1+(cost_buffer_bps+lock_net)/10000))
        if mfe_bps>=trail_trigger: candidate=max(candidate,peak*(1-(12.0 if momentum else 6.0)/10000))
        if candidate>0:
            candidate=floor_tick(candidate) if candidate>(protect or 0) and candidate!=be else candidate
            candidate=min(candidate, peak-tick_size_krw(peak))
            if candidate>(protect or 0) and close>candidate:
                # Require positive fee-net at the floor; dynamic arm is already positive by construction.
                if candidate*(1-fee)>buy_cost: protect=candidate
        if idx>0 and protect and lo<=protect:
            exit_price=protect; realized += remaining*exit_price*(1-fee); remaining=0; exit_reason='UPBIT_EXECUTABLE_BE'; break
    if remaining>0: realized += remaining*exit_price*(1-fee)
    return {'net_return_pct':(realized/buy_cost-1)*100,'exit_reason':exit_reason,'exit_price':exit_price,
            'protected_stop':protect,'armed':armed}

def load_candidates(path):
    out=[]
    with open(path,newline='',encoding='utf-8') as f:
        for r in csv.DictReader(f):
            r['created_at']=parse_utc(r['created_at'])
            for k in ('entry_low','entry_high','stop_price','target_1','target_2','estimated_cost_pct'):
                try:r[k]=float(r[k]) if r.get(k) not in (None,'') else None
                except:r[k]=None
            out.append(r)
    return out

def dedup_candidates(rows, gap=180):
    out=[]; last={}
    for r in sorted(rows,key=lambda x:x['created_at']):
        prev=last.get(r['market'])
        if prev and (r['created_at']-prev).total_seconds()<gap: continue
        out.append(r); last[r['market']]=r['created_at']
    return out

def fmt(x,d=4):
    return 'NA' if x is None else f'{x:.{d}f}'

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--candidates',required=True); ap.add_argument('--context',required=True); ap.add_argument('--json',required=True); ap.add_argument('--md',required=True)
    a=ap.parse_args()
    ctx=json.load(open(a.context,encoding='utf-8'))
    fee=float(ctx.get('buy_fee_bps',5))/10000
    now=datetime.now(UTC).replace(microsecond=0); start=now-timedelta(hours=24)
    markets=[m['market'] for m in fetch_json('/market/all',{'is_details':'false'}) if m['market'].startswith('KRW-')]
    market_data={}; market_stats=[]; broad={180:[],300:[],600:[],900:[]}; broad_mfe={600:[]}; broad_mae={600:[]}
    for i,m in enumerate(markets,1):
        rows=fetch_candles(m,start,now,seconds=False); market_data[m]=rows
        if not rows: continue
        op=float(rows[0]['opening_price']); last=float(rows[-1]['trade_price']); hi=max(float(x['high_price']) for x in rows); lo=min(float(x['low_price']) for x in rows); vol=sum(float(x['candle_acc_trade_price']) for x in rows)
        market_stats.append({'market':m,'return_pct':pct(last,op),'range_pct':pct(hi,lo),'trade_krw':vol,'candles':len(rows)})
        anchor=start.replace(minute=(start.minute//30)*30,second=0,microsecond=0)
        t=anchor
        while t<now-timedelta(minutes=15):
            er=first_at_or_after(rows,t)
            if er and 0<=(candle_ts(er)-t).total_seconds()<=120:
                ets=candle_ts(er); ep=float(er['trade_price'])
                for h in broad:
                    s=terminal_path_stats(rows,ets,ep,h,fee)
                    if s:
                        broad[h].append(s['net_terminal_pct'])
                        if h==600: broad_mfe[600].append(s['mfe_pct']); broad_mae[600].append(s['mae_pct'])
            t+=timedelta(minutes=30)
        if i%20==0: print(f'minute markets {i}/{len(markets)}',flush=True)
    candidates=dedup_candidates(load_candidates(a.candidates),180)
    episodes=[]; two_sec_adverse=[]; delay_results={0:[],30:[],60:[],120:[]}; variants={}
    safety_grid=[0,1,2,3,5,8,10]
    for s in safety_grid:
        for ex in (False,True): variants[f'DYN_S{s}_T{int(ex)}']=[]
    current=[]
    for i,c in enumerate(candidates,1):
        cstart=c['created_at']-timedelta(seconds=5); cend=min(now,c['created_at']+timedelta(seconds=905))
        rows=fetch_candles(c['market'],cstart,cend,seconds=True)
        entryrow=first_at_or_after(rows,c['created_at'])
        if not entryrow: continue
        ets=candle_ts(entryrow); ep=float(entryrow['trade_price']); pattern=c.get('pattern') or ''
        cur=current_fixed_sim(rows,ets,ep,pattern,600,fee,float(ctx.get('cost_buffer_upbit_bps',12)))
        if cur: current.append(cur['net_return_pct'])
        var_res={}
        for s in safety_grid:
            for ex in (False,True):
                k=f'DYN_S{s}_T{int(ex)}'; r=dynamic_sim(rows,ets,ep,pattern,600,fee,float(s),ex)
                if r: variants[k].append(r['net_return_pct']); var_res[k]=r
        # 2-second adverse move on observed second closes.
        closes=[float(r['trade_price']) for r in rows_between(rows,ets,min(cend,ets+timedelta(seconds=600)))]
        for j in range(len(closes)-2):
            two_sec_adverse.append(min(0.0,(closes[j+2]/closes[j]-1)*10000))
        for delay in delay_results:
            dr=first_at_or_after(rows,c['created_at']+timedelta(seconds=delay))
            if dr:
                dts=candle_ts(dr); dep=float(dr['trade_price']); st=terminal_path_stats(rows,dts,dep,600,fee)
                if st: delay_results[delay].append(st['net_terminal_pct'])
        raw=terminal_path_stats(rows,ets,ep,600,fee)
        episodes.append({'market':c['market'],'signal_at':iso_z(c['created_at']),'pattern':pattern,'entry_price':ep,
                         'candidate_mid':((c['entry_low']+c['entry_high'])/2 if c['entry_low'] and c['entry_high'] else None),
                         'raw_600':raw,'current':cur,'variants':var_res})
        print(f'second episodes {i}/{len(candidates)} {c["market"]}',flush=True)
    # Pick a robust dynamic variant: improves mean and p10 vs current, then maximize mean; ties prefer lower safety and no extra tick.
    curagg=aggregate(current); scored=[]
    for k,v in variants.items():
        ag=aggregate(v); s=int(k.split('_')[1][1:]); ex=int(k.split('_')[2][1:])
        ok=ag.get('n',0)==curagg.get('n',0) and ag.get('mean',-999)>=curagg.get('mean',-999) and ag.get('p10',-999)>=curagg.get('p10',-999)
        scored.append((1 if ok else 0,ag.get('mean',-999),ag.get('p10',-999),-s,-ex,k,ag))
    scored.sort(reverse=True); best=scored[0]
    adv_abs=[-x for x in two_sec_adverse if x<0]
    result={
      'generated_at':iso_z(now),'window_start':iso_z(start),'window_end':iso_z(now),'krw_market_count':len(markets),
      'execution_context':ctx,
      'market_24h':{'return_pct':aggregate([x['return_pct'] for x in market_stats]),'range_pct':aggregate([x['range_pct'] for x in market_stats]),'trade_krw_total':sum(x['trade_krw'] for x in market_stats),'markets_with_data':len(market_stats)},
      'broad_30m_entries':{str(h):aggregate(v) for h,v in broad.items()},
      'broad_600_mfe':aggregate(broad_mfe[600]),'broad_600_mae':aggregate(broad_mae[600]),
      'scanner_buy_raw_count':len(load_candidates(a.candidates)),'scanner_buy_dedup_count':len(candidates),'scanner_episode_count':len(episodes),
      'candidate_current_fixed_600':curagg,
      'candidate_dynamic_variants_600':{k:aggregate(v) for k,v in variants.items()},
      'best_dynamic_variant':{'name':best[5],'metrics':best[6]},
      'candidate_entry_delay_600':{str(k):aggregate(v) for k,v in delay_results.items()},
      'candidate_2s_adverse_bps':aggregate(adv_abs),
      'episodes':episodes,
      'market_stats':sorted(market_stats,key=lambda x:x['trade_krw'],reverse=True)
    }
    with open(a.json,'w',encoding='utf-8') as f: json.dump(result,f,ensure_ascii=False,indent=2)
    lines=[]
    lines.append('# Upbit KRW 24h Full-Market Replay')
    lines.append(f'- Window: {result["window_start"]} ~ {result["window_end"]}')
    lines.append(f'- KRW markets: {len(markets)}; with candles: {len(market_stats)}')
    r=result['market_24h']['return_pct']; lines.append(f'- Market 24h return: mean {fmt(r.get("mean"))}% / median {fmt(r.get("median"))}% / positive {fmt((r.get("positive_rate") or 0)*100,2)}%')
    lines.append(f'- Scanner BUY: raw {result["scanner_buy_raw_count"]}, 180s-dedup {len(candidates)}, replayed {len(episodes)}')
    lines.append('')
    lines.append('## Broad market 30-minute entry baseline (fee-net)')
    lines.append('|Horizon|N|Mean %|Median %|P10 %|Positive %|')
    lines.append('|---:|---:|---:|---:|---:|---:|')
    for h in (180,300,600,900):
        z=result['broad_30m_entries'][str(h)]; lines.append(f'|{h}s|{z.get("n",0)}|{fmt(z.get("mean"))}|{fmt(z.get("median"))}|{fmt(z.get("p10"))}|{fmt((z.get("positive_rate") or 0)*100,2)}|')
    lines.append('')
    lines.append('## Scanner BUY 600s protection replay')
    lines.append(f'- Current fixed: n={curagg.get("n",0)}, mean={fmt(curagg.get("mean"))}%, p10={fmt(curagg.get("p10"))}%, positive={fmt((curagg.get("positive_rate") or 0)*100,2)}%')
    lines.append(f'- Best dynamic: {best[5]}, mean={fmt(best[6].get("mean"))}%, p10={fmt(best[6].get("p10"))}%, positive={fmt((best[6].get("positive_rate") or 0)*100,2)}%')
    ad=result['candidate_2s_adverse_bps']; lines.append(f'- Observed 2s adverse move magnitude: median={fmt(ad.get("median"))}bps, p90={fmt(ad.get("p90"))}bps, p95={fmt(ad.get("p95"))}bps')
    lines.append('')
    lines.append('## Entry delay 600s fee-net')
    lines.append('|Delay|N|Mean %|P10 %|Positive %|')
    lines.append('|---:|---:|---:|---:|---:|')
    for d in (0,30,60,120):
        z=result['candidate_entry_delay_600'][str(d)]; lines.append(f'|{d}s|{z.get("n",0)}|{fmt(z.get("mean"))}|{fmt(z.get("p10"))}|{fmt((z.get("positive_rate") or 0)*100,2)}|')
    open(a.md,'w',encoding='utf-8').write('\n'.join(lines)+'\n')

if __name__=='__main__': main()
