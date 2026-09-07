#!/usr/bin/env python3
import os, time, math, json, itertools, statistics
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import numpy as np
import pandas as pd

BASE='https://fapi.binance.com'
KST=timezone(timedelta(hours=9))
LOOKBACK=int(os.getenv('LOOKBACK_DAYS','28'))
COST_BPS=float(os.getenv('ROUND_TRIP_COST_BPS','21'))
COST=COST_BPS/10000.0
OUT='research_artifacts'
os.makedirs(OUT,exist_ok=True)
S=requests.Session(); S.headers.update({'User-Agent':'Trading-booooo-leader-momentum-research/17'})

def get(path, params=None, tries=8):
    delay=.8
    for i in range(tries):
        r=S.get(BASE+path,params=params,timeout=30)
        if r.status_code==200: return r.json()
        if r.status_code in (418,429) or r.status_code>=500:
            time.sleep(delay); delay=min(delay*1.8,15); continue
        raise RuntimeError(f'{path}:{r.status_code}:{r.text[:300]}')
    raise RuntimeError(f'{path}:retry_exhausted')

def klines(symbol, interval, start_ms, end_ms, limit=1500):
    rows=[]; cur=start_ms
    step={'1h':3600000,'15m':900000,'5m':300000}[interval]
    while cur < end_ms:
        part=get('/fapi/v1/klines',{'symbol':symbol,'interval':interval,'startTime':cur,'endTime':end_ms-1,'limit':limit})
        if not part: break
        rows.extend(part)
        nxt=int(part[-1][0])+step
        if nxt<=cur: break
        cur=nxt
        if len(part)<limit: break
        time.sleep(.04)
    return rows

def frame(rows,symbol):
    if not rows:return pd.DataFrame()
    d=pd.DataFrame(rows,columns=['t','o','h','l','c','vol','ct','qv','trades','tb_base','tbq','ignore'])
    for x in ['o','h','l','c','qv','tbq']: d[x]=pd.to_numeric(d[x],errors='coerce')
    d['t']=pd.to_datetime(d['t'],unit='ms',utc=True); d['symbol']=symbol
    return d[['symbol','t','o','h','l','c','qv','tbq']]

def pf(vals):
    pos=sum(x for x in vals if x>0); neg=-sum(x for x in vals if x<0)
    return pos/neg if neg>0 else (999.0 if pos>0 else 0.0)

def metrics(trades, all_top10=None):
    if trades is None or len(trades)==0:return {'n':0,'avg':np.nan,'win':np.nan,'pf':0,'capture':0,'precision':0}
    rets=np.array([x['net_ret'] for x in trades],float)
    tops=sum(bool(x.get('is_top10',False)) for x in trades)
    captured=len({(x['day'],x['symbol']) for x in trades if x.get('is_top10',False)})
    denom=all_top10 if all_top10 else 0
    return {'n':len(rets),'avg':float(rets.mean()),'win':float((rets>0).mean()),'pf':pf(rets),'capture':captured/denom if denom else 0,'precision':tops/len(rets)}

def period(day, train_end, valid_end):
    if day<=train_end:return 'TRAIN'
    if day<=valid_end:return 'VALID'
    return 'TEST'

def fetch_hourly(symbol,start_ms,end_ms):
    try:
        d=frame(klines(symbol,'1h',start_ms,end_ms,1000),symbol)
        return symbol,d,None
    except Exception as e:return symbol,pd.DataFrame(),str(e)

now=datetime.now(timezone.utc)
end_kst=(now.astimezone(KST).date()-timedelta(days=1))
start_kst=end_kst-timedelta(days=LOOKBACK-1)
start_dt=datetime.combine(start_kst,datetime.min.time(),KST).astimezone(timezone.utc)-timedelta(hours=26)
end_dt=datetime.combine(end_kst+timedelta(days=1),datetime.min.time(),KST).astimezone(timezone.utc)+timedelta(hours=2)
start_ms=int(start_dt.timestamp()*1000); end_ms=int(end_dt.timestamp()*1000)

info=get('/fapi/v1/exchangeInfo')
symbols=sorted(s['symbol'] for s in info['symbols'] if s.get('quoteAsset')=='USDT' and s.get('contractType')=='PERPETUAL' and s.get('status')=='TRADING')
print(f'BINANCE_DIRECT exchangeInfo active_USDT_perpetual={len(symbols)} period={start_kst}..{end_kst}',flush=True)

frames=[]; errs=[]
# Keep concurrency modest; public Binance is the source, no repository price cache is used.
with ThreadPoolExecutor(max_workers=5) as ex:
    futs=[ex.submit(fetch_hourly,s,start_ms,end_ms) for s in symbols]
    for j,f in enumerate(as_completed(futs),1):
        s,d,e=f.result()
        if e: errs.append((s,e))
        elif len(d): frames.append(d)
        if j%50==0: print(f'hourly {j}/{len(symbols)} ok={len(frames)} err={len(errs)}',flush=True)
if not frames: raise SystemExit('NO_BINANCE_DATA')
h=pd.concat(frames,ignore_index=True).sort_values(['symbol','t'])
h['kst_day']=h['t'].dt.tz_convert(KST).dt.date
h=h[(h.kst_day>=start_kst)&(h.kst_day<=end_kst)].copy()

# Require a tradable day's first bar near KST midnight and enough history to avoid new-listing hindsight distortion.
h['hour_kst']=h['t'].dt.tz_convert(KST).dt.hour
h['day_open']=h.groupby(['symbol','kst_day'])['o'].transform('first')
h['bars_day']=h.groupby(['symbol','kst_day'])['t'].transform('count')
h['day_ret_live']=h['c']/h['day_open']-1
h['r1h']=h.groupby('symbol')['c'].pct_change(1)
h['r3h']=h.groupby('symbol')['c'].pct_change(3)
h['qv_avg24']=h.groupby('symbol')['qv'].transform(lambda x:x.shift(1).rolling(24,min_periods=12).mean())
h['qv_ratio']=h['qv']/h['qv_avg24']
h['qv24']=h.groupby('symbol')['qv'].transform(lambda x:x.rolling(24,min_periods=12).sum())
h['prior12_high']=h.groupby('symbol')['h'].transform(lambda x:x.shift(1).rolling(12,min_periods=6).max())
h['breakout']=h['c']>=h['prior12_high']*.998
h['rank']=h.groupby('t')['day_ret_live'].rank(method='first',ascending=False)

# End-of-day Top10 is LABEL ONLY and is never used by entry rules.
daily=(h.groupby(['symbol','kst_day']).agg(day_open=('o','first'),day_close=('c','last'),day_high=('h','max'),day_low=('l','min'),bars=('t','count'),day_qv=('qv','sum')).reset_index())
daily=daily[daily.bars>=20].copy(); daily['day_ret']=daily.day_close/daily.day_open-1; daily['high_ret']=daily.day_high/daily.day_open-1
daily['rank_close']=daily.groupby('kst_day')['day_ret'].rank(method='first',ascending=False)
daily['is_top10']=daily.rank_close<=10
label={(r.symbol,r.kst_day):bool(r.is_top10) for r in daily.itertuples()}
top10_by_period={}
days=sorted(daily.kst_day.unique())
n=len(days); train_end=days[max(0,int(n*.60)-1)]; valid_end=days[max(0,int(n*.80)-1)]
for p in ['TRAIN','VALID','TEST']:
    top10_by_period[p]=sum(1 for r in daily.itertuples() if r.is_top10 and period(r.kst_day,train_end,valid_end)==p)
print(f'days={n} split TRAIN<= {train_end} VALID<= {valid_end} TEST afterward',flush=True)

# Entry screening at full-market 1h frequency. Signal uses only information known at that hour close.
entry_grid=list(itertools.product([.015,.025,.035,.05],[5,10,15,20],[0,.005,.01],[1.0,1.5,2.0],[5e6,20e6,50e6],[False,True]))
rough=[]
groups={(s,d):g.sort_values('t').reset_index(drop=True) for (s,d),g in h.groupby(['symbol','kst_day'])}
for intr,rankk,r1,qvr,qvmin,need_bo in entry_grid:
    trades=[]
    mask=(h.day_ret_live>=intr)&(h['rank']<=rankk)&(h.r1h>=r1)&(h.qv_ratio>=qvr)&(h.qv24>=qvmin)
    if need_bo:mask&=h.breakout
    sig=h[mask].sort_values('t').groupby(['symbol','kst_day'],as_index=False).first()
    for r in sig.itertuples():
        g=groups.get((r.symbol,r.kst_day));
        if g is None: continue
        idx=g.index[g.t==r.t]
        if len(idx)==0 or idx[0]+1>=len(g):continue
        i=int(idx[0])+1; entry=float(g.loc[i,'o']); j=min(i+6,len(g)-1); exitp=float(g.loc[j,'c'])
        net=exitp/entry-1-COST
        trades.append({'symbol':r.symbol,'day':r.kst_day,'signal_t':r.t,'entry':entry,'net_ret':net,'is_top10':label.get((r.symbol,r.kst_day),False),'p':period(r.kst_day,train_end,valid_end)})
    row={'intr':intr,'rank':rankk,'r1':r1,'qvr':qvr,'qvmin':qvmin,'bo':need_bo,'trades':trades}
    good=True; score=0
    for p in ['TRAIN','VALID','TEST']:
        tt=[x for x in trades if x['p']==p]; m=metrics(tt,top10_by_period[p]);
        for k,v in m.items():row[f'{p}_{k}']=v
    # robust selection is TRAIN+VALID only; TEST is untouched until final reporting.
    if row['TRAIN_n']<20 or row['VALID_n']<7 or not np.isfinite(row['TRAIN_avg']) or not np.isfinite(row['VALID_avg']): score=-999
    else:
        score=min(row['TRAIN_avg'],row['VALID_avg'])*100 + .15*min(row['TRAIN_capture'],row['VALID_capture']) + .03*min(row['TRAIN_precision'],row['VALID_precision'])
        if row['TRAIN_pf']<1 or row['VALID_pf']<1:score-=1
    row['score']=score; rough.append(row)
rough.sort(key=lambda x:x['score'],reverse=True)
best=rough[0]
print('ENTRY_WINNER',json.dumps({k:(round(v,6) if isinstance(v,float) else v) for k,v in best.items() if k!='trades'},default=str),flush=True)

# Fine-data fetch only for signal symbol-days selected WITHOUT looking at TEST outcome.
events=best['trades']
cache={}
def fetch_window(ev):
    key=(ev['symbol'],ev['day'])
    if key in cache:return key,cache[key]
    ds=datetime.combine(ev['day'],datetime.min.time(),KST).astimezone(timezone.utc)-timedelta(hours=2)
    de=ds+timedelta(hours=38)
    try:
        d15=frame(klines(ev['symbol'],'15m',int(ds.timestamp()*1000),int(de.timestamp()*1000)),ev['symbol'])
        d5=frame(klines(ev['symbol'],'5m',int(ds.timestamp()*1000),int(de.timestamp()*1000)),ev['symbol'])
        return key,(d15,d5,None)
    except Exception as e:return key,(pd.DataFrame(),pd.DataFrame(),str(e))
unique=[]; seen=set()
for e in events:
    k=(e['symbol'],e['day'])
    if k not in seen:seen.add(k);unique.append(e)
with ThreadPoolExecutor(max_workers=4) as ex:
    futs=[ex.submit(fetch_window,e) for e in unique]
    for j,f in enumerate(as_completed(futs),1):
        k,v=f.result();cache[k]=v
        if j%50==0:print(f'fine {j}/{len(unique)}',flush=True)

def confirm_entry(ev,mode):
    d15,d5,err=cache.get((ev['symbol'],ev['day']),(None,None,'missing'))
    if err or d5 is None or len(d5)<20:return None
    sig=pd.Timestamp(ev['signal_t']); start=sig+pd.Timedelta(hours=1) # hourly bar close
    if mode=='IMMEDIATE':
        z=d5[d5.t>=start]
        return (z.iloc[0].t,float(z.iloc[0].o)) if len(z) else None
    if mode=='15M_BREAKOUT':
        x=d15.copy().sort_values('t'); x['ph']=x.h.shift(1).rolling(4,min_periods=3).max(); x['qmed']=x.qv.shift(1).rolling(8,min_periods=4).median()
        z=x[(x.t>=start)&(x.t<=start+pd.Timedelta(minutes=60))&(x.c>=x.ph)&(x.qv>=x.qmed*1.10)]
        if not len(z):return None
        ct=z.iloc[0].t+pd.Timedelta(minutes=15); q=d5[d5.t>=ct]
        return (q.iloc[0].t,float(q.iloc[0].o)) if len(q) else None
    x=d5.copy().sort_values('t'); x['ph']=x.h.shift(1).rolling(6,min_periods=4).max(); x['qmed']=x.qv.shift(1).rolling(12,min_periods=6).median()
    if mode=='5M_BREAKOUT':cond=(x.c>=x.ph)&(x.qv>=x.qmed*1.20)
    else:
        x['r15']=x.c/x.c.shift(3)-1; cond=(x.r15>=.01)&(x.c>x.o)&(x.qv>=x.qmed*1.20)
    z=x[(x.t>=start)&(x.t<=start+pd.Timedelta(minutes=60))&cond]
    if not len(z):return None
    ct=z.iloc[0].t+pd.Timedelta(minutes=5); q=d5[d5.t>=ct]
    return (q.iloc[0].t,float(q.iloc[0].o)) if len(q) else None

def simulate(ev,mode,arm,trail,stop,stale,maxmin,cost=COST):
    ent=confirm_entry(ev,mode)
    if ent is None:return None
    et,ep=ent; d5=cache[(ev['symbol'],ev['day'])][1].sort_values('t'); bars=d5[d5.t>=et].head(maxmin//5+1)
    if len(bars)<2:return None
    peak=ep; peak_t=et; exitp=float(bars.iloc[-1].c); exit_t=bars.iloc[-1].t; why='MAX_HOLD'; mfe=0.0; mae=0.0
    armed=False
    for r in bars.itertuples():
        if r.t==et:continue
        prev_peak=peak
        hard=ep*(1-stop)
        trailp=prev_peak*(1-trail) if armed else -1
        # conservative intrabar ordering: an already-active protective level is checked before a new high.
        if float(r.l)<=hard:
            exitp=hard;exit_t=r.t;why='STOP';break
        if armed and float(r.l)<=trailp:
            exitp=trailp;exit_t=r.t;why='TRAIL';break
        if float(r.h)>peak:
            peak=float(r.h);peak_t=r.t
            if peak/ep-1>=arm:armed=True
        mae=min(mae,float(r.l)/ep-1);mfe=max(mfe,float(r.h)/ep-1)
        if (r.t-peak_t).total_seconds()/60>=stale:
            exitp=float(r.c);exit_t=r.t;why='STALE';break
    gross=exitp/ep-1; net=gross-cost
    return {'symbol':ev['symbol'],'day':ev['day'],'entry_t':et,'entry':ep,'exit_t':exit_t,'exit':exitp,'gross_ret':gross,'net_ret':net,'mfe':mfe,'mae':mae,'giveback':max(0,mfe-gross),'mfe_capture':gross/mfe if mfe>0 else np.nan,'exit_reason':why,'is_top10':ev['is_top10'],'p':ev['p']}

modes=['IMMEDIATE','15M_BREAKOUT','5M_BREAKOUT','5M_ACCEL']
exit_grid=list(itertools.product(modes,[.02,.03,.04],[.02,.03,.04,.05],[.015,.02,.03,.04],[30,60,90,120],[360,720]))
results=[]
for mode,arm,trail,stop,stale,maxmin in exit_grid:
    ts=[]
    for ev in events:
        x=simulate(ev,mode,arm,trail,stop,stale,maxmin)
        if x:ts.append(x)
    row={'mode':mode,'arm':arm,'trail':trail,'stop':stop,'stale':stale,'maxmin':maxmin,'trades':ts}
    for p in ['TRAIN','VALID','TEST']:
        m=metrics([x for x in ts if x['p']==p],top10_by_period[p])
        for k,v in m.items():row[f'{p}_{k}']=v
    if row['TRAIN_n']<15 or row['VALID_n']<5:score=-999
    else:
        score=min(row['TRAIN_avg'],row['VALID_avg'])*100 + .10*min(row['TRAIN_capture'],row['VALID_capture'])
        if row['TRAIN_pf']<1 or row['VALID_pf']<1:score-=1
    row['score']=score;results.append(row)
results.sort(key=lambda x:x['score'],reverse=True); win=results[0]
print('EXIT_WINNER',json.dumps({k:(round(v,6) if isinstance(v,float) else v) for k,v in win.items() if k!='trades'},default=str),flush=True)

# Stress costs without re-optimizing.
def stress_stats(rows,p,costbps):
    vals=[]
    for x in rows:
        if x['p']!=p:continue
        vals.append(x['gross_ret']-costbps/10000)
    return {'n':len(vals),'avg':float(np.mean(vals)) if vals else np.nan,'pf':pf(vals),'win':float(np.mean(np.array(vals)>0)) if vals else np.nan}

chosen=win['trades']
report=[]
report.append('# V17 Leader Momentum — Direct Binance USDⓈ-M Research')
report.append('')
report.append(f'- Source: Binance public `fapi` exchangeInfo + klines fetched during this workflow; repository price tables were not used for the primary study.')
report.append(f'- KST completed days: **{start_kst} ~ {end_kst}** ({n} days)')
report.append(f'- Current active USDT perpetual universe requested: **{len(symbols)}**, hourly data available: **{h.symbol.nunique()}**')
report.append(f'- End-of-day Top-10 is evaluation label only; no future Top-10 knowledge is used by the entry rule.')
report.append(f'- Cost baseline: **{COST_BPS:.0f} bp round trip**')
report.append('')
report.append('## Selected entry rule (chosen on TRAIN+VALID only)')
report.append(f"- Intraday return >= **{best['intr']*100:.1f}%**")
report.append(f"- Live cross-sectional intraday rank <= **{best['rank']}**")
report.append(f"- Latest 1h return >= **{best['r1']*100:.1f}%**")
report.append(f"- Latest 1h quote-volume / trailing-24h hourly average >= **{best['qvr']:.1f}x**")
report.append(f"- Rolling 24h quote volume >= **${best['qvmin']/1e6:.0f}M**")
report.append(f"- 12h breakout confirmation at hourly screen: **{best['bo']}**")
report.append('')
report.append('## Selected 5m/15m execution + exit')
report.append(f"- Entry confirmation: **{win['mode']}**")
report.append(f"- Hard stop: **{win['stop']*100:.1f}%** below entry")
report.append(f"- Trailing arms after MFE **+{win['arm']*100:.1f}%**, then exits on **{win['trail']*100:.1f}%** giveback from peak")
report.append(f"- No-new-high exit: **{win['stale']} minutes**")
report.append(f"- Maximum hold: **{win['maxmin']//60}h**")
report.append('')
report.append('## Out-of-sample metrics')
report.append('|Split|N|Avg net|Win|PF|Top10 capture|Top10 precision|')
report.append('|---|---:|---:|---:|---:|---:|---:|')
for p in ['TRAIN','VALID','TEST']:
    report.append(f"|{p}|{win[p+'_n']}|{win[p+'_avg']*100:.3f}%|{win[p+'_win']*100:.1f}%|{win[p+'_pf']:.2f}|{win[p+'_capture']*100:.1f}%|{win[p+'_precision']*100:.1f}%|")
report.append('')
report.append('## Cost stress (same selected rule, no retuning)')
report.append('|Split|Cost|N|Avg net|PF|Win|')
report.append('|---|---:|---:|---:|---:|---:|')
for p in ['TRAIN','VALID','TEST']:
    for cb in [21,35,50]:
        z=stress_stats(chosen,p,cb); report.append(f"|{p}|{cb}bp|{z['n']}|{z['avg']*100:.3f}%|{z['pf']:.2f}|{z['win']*100:.1f}%|")
report.append('')
# top examples in TEST, not used for optimization
te=[x for x in chosen if x['p']=='TEST']; te.sort(key=lambda x:x['net_ret'],reverse=True)
report.append('## TEST trades — best/worst examples')
report.append('|Symbol|Day|Entry KST|Exit|Net|MFE|Giveback|Reason|Top10|')
report.append('|---|---|---|---|---:|---:|---:|---|---|')
for x in (te[:8]+te[-8:] if len(te)>8 else te):
    report.append(f"|{x['symbol']}|{x['day']}|{x['entry_t'].tz_convert(KST).strftime('%H:%M')}|{x['exit_t'].tz_convert(KST).strftime('%H:%M')}|{x['net_ret']*100:.2f}%|{x['mfe']*100:.2f}%|{x['giveback']*100:.2f}%|{x['exit_reason']}|{x['is_top10']}|")
report.append('')
report.append('## Guardrails for interpretation')
report.append('- Current exchangeInfo creates survivorship bias for contracts delisted before the study date; do not extrapolate this direct-Binance recent-window result alone to multi-year performance.')
report.append('- Top-10 is a retrospective label only. Live logic uses contemporaneous rank/return/volume and therefore also generates false positives, which are included in PnL metrics.')
report.append('- Research does not submit orders and does not alter production controls.')
open(f'{OUT}/report.md','w').write('\n'.join(report)+'\n')
pd.DataFrame([{k:v for k,v in r.items() if k!='trades'} for r in rough[:50]]).to_csv(f'{OUT}/entry_grid_top50.csv',index=False)
pd.DataFrame([{k:v for k,v in r.items() if k!='trades'} for r in results[:100]]).to_csv(f'{OUT}/exit_grid_top100.csv',index=False)
pd.DataFrame(chosen).to_csv(f'{OUT}/chosen_trades.csv',index=False)
pd.DataFrame(errs,columns=['symbol','error']).to_csv(f'{OUT}/fetch_errors.csv',index=False)
open(f'{OUT}/universe.json','w').write(json.dumps({'requested':symbols,'available_hourly':sorted(h.symbol.unique()),'start':str(start_kst),'end':str(end_kst)},indent=2))
print('\n'.join(report[:45]),flush=True)
