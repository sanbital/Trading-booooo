#!/usr/bin/env python3
import os,re,io,zipfile,time,math,json,itertools
from urllib.parse import quote
from datetime import datetime,timezone,timedelta,date
from concurrent.futures import ThreadPoolExecutor,as_completed
import xml.etree.ElementTree as ET
import requests,numpy as np,pandas as pd

BUCKET='https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
VISION='https://data.binance.vision/data/futures/um'
KST=timezone(timedelta(hours=9)); OUT='research_artifacts'; os.makedirs(OUT,exist_ok=True)
COST_BPS=float(os.getenv('ROUND_TRIP_COST_BPS','21')); COST=COST_BPS/10000
START=date(2026,8,1); END=date(2026,9,6)
S=requests.Session(); S.headers.update({'User-Agent':'Trading-booooo-v17-vision-research'})

def req(url,tries=5):
    d=.5
    for i in range(tries):
        try:
            r=S.get(url,timeout=30)
            if r.status_code==200:return r.content
            if r.status_code==404:return None
            if r.status_code>=500:time.sleep(d);d*=1.7;continue
            return None
        except Exception:
            if i==tries-1:return None
            time.sleep(d);d*=1.7
    return None

def list_symbols():
    prefix='data/futures/um/daily/klines/'
    marker=''; out=[]
    while True:
        url=f'{BUCKET}?delimiter=%2F&prefix={quote(prefix,safe="")}'
        if marker:url+=f'&marker={quote(marker,safe="")}'
        raw=req(url)
        if not raw:break
        root=ET.fromstring(raw); ns={'s':'http://s3.amazonaws.com/doc/2006-03-01/'}
        for p in root.findall('s:CommonPrefixes/s:Prefix',ns):
            txt=p.text or ''; sym=txt.rstrip('/').split('/')[-1]
            if sym.endswith('USDT') and 'SETTLED' not in sym and '_' not in sym and not sym.endswith('USDCUSDT'):
                out.append(sym)
        trunc=(root.findtext('s:IsTruncated',default='false',namespaces=ns) or '').lower()=='true'
        marker=root.findtext('s:NextMarker',default='',namespaces=ns) or ''
        if not trunc or not marker:break
    return sorted(set(out))

def parse_zip(raw,sym):
    if not raw:return pd.DataFrame()
    try:
        z=zipfile.ZipFile(io.BytesIO(raw)); name=z.namelist()[0]
        d=pd.read_csv(z.open(name),header=None)
        if len(d.columns)<11:return pd.DataFrame()
        d=d.iloc[:,:11]; d.columns=['ms','o','h','l','c','vol','close_ms','qv','trades','tb_base','tbq']
        if not np.issubdtype(d['ms'].dtype,np.number):
            d=d[pd.to_numeric(d.ms,errors='coerce').notna()]
        for c in ['ms','o','h','l','c','qv','tbq']:d[c]=pd.to_numeric(d[c],errors='coerce')
        d=d.dropna(subset=['ms','o','h','l','c','qv']); d['t']=pd.to_datetime(d.ms.astype('int64'),unit='ms',utc=True); d['symbol']=sym
        return d[['symbol','t','o','h','l','c','qv','tbq']]
    except Exception:return pd.DataFrame()

def monthly_url(sym,interval,ym):
    q=quote(sym,safe='');return f'{VISION}/monthly/klines/{q}/{interval}/{q}-{interval}-{ym}.zip'
def daily_url(sym,interval,day):
    q=quote(sym,safe='');ds=day.isoformat();return f'{VISION}/daily/klines/{q}/{interval}/{q}-{interval}-{ds}.zip'

def fetch_15m(sym):
    parts=[]
    a=parse_zip(req(monthly_url(sym,'15m','2026-08')),sym)
    if len(a):parts.append(a)
    for dd in pd.date_range('2026-09-01','2026-09-06',freq='D').date:
        x=parse_zip(req(daily_url(sym,'15m',dd)),sym)
        if len(x):parts.append(x)
    if not parts:return sym,pd.DataFrame()
    d=pd.concat(parts,ignore_index=True).drop_duplicates('t').sort_values('t')
    return sym,d

def pf(a):
    p=sum(x for x in a if x>0);n=-sum(x for x in a if x<0);return p/n if n>0 else (999 if p>0 else 0)
def met(ts,den=0):
    if not ts:return dict(n=0,avg=np.nan,win=np.nan,pf=0,capture=0,precision=0)
    a=np.array([x['net'] for x in ts]); top=[x for x in ts if x['top10']]
    cap=len(set((x['day'],x['symbol']) for x in top))/den if den else 0
    return dict(n=len(a),avg=float(a.mean()),win=float((a>0).mean()),pf=pf(a),capture=cap,precision=len(top)/len(ts))

symbols=list_symbols(); print('VISION_SYMBOL_DIRS',len(symbols),flush=True)
frames=[]
with ThreadPoolExecutor(max_workers=20) as ex:
    fs=[ex.submit(fetch_15m,s) for s in symbols]
    for i,f in enumerate(as_completed(fs),1):
        s,d=f.result()
        if len(d):frames.append(d)
        if i%100==0:print('15m',i,'/',len(symbols),'available',len(frames),flush=True)
if not frames:raise SystemExit('NO_VISION_15M')
x=pd.concat(frames,ignore_index=True).sort_values(['symbol','t'])
x['day']=x.t.dt.tz_convert(KST).dt.date;x=x[(x.day>=START)&(x.day<=END)].copy()
# only symbol-days with substantial coverage; new listings can join once sufficient bars exist that day
x['bar_no']=x.groupby(['symbol','day']).cumcount();x['day_open']=x.groupby(['symbol','day']).o.transform('first');x['ret_day']=x.c/x.day_open-1
x['r15']=x.groupby('symbol').c.pct_change();x['r30']=x.groupby('symbol').c.pct_change(2);x['r60']=x.groupby('symbol').c.pct_change(4)
x['qmed16']=x.groupby('symbol').qv.transform(lambda s:s.shift(1).rolling(16,min_periods=8).median());x['qvr']=x.qv/x.qmed16
x['qv24']=x.groupby('symbol').qv.transform(lambda s:s.rolling(96,min_periods=32).sum())
x['high4']=x.groupby('symbol').h.transform(lambda s:s.shift(1).rolling(4,min_periods=3).max())
x['high12']=x.groupby('symbol').h.transform(lambda s:s.shift(1).rolling(12,min_periods=6).max())
x['bo4']=x.c>=x.high4*.999;x['bo12']=x.c>=x.high12*.999
x['rank']=x.groupby('t').ret_day.rank(method='first',ascending=False)
# Daily Top10 labels from KST close; labels evaluate capture only.
dy=x.groupby(['symbol','day']).agg(o=('o','first'),c=('c','last'),h=('h','max'),bars=('t','count'),qv=('qv','sum')).reset_index();dy=dy[dy.bars>=60].copy();dy['ret']=dy.c/dy.o-1;dy['rank']=dy.groupby('day').ret.rank(method='first',ascending=False);dy['top10']=dy['rank']<=10
lab={(r.symbol,r.day):bool(r.top10) for r in dy.itertuples()};days=sorted(dy.day.unique());a=days[int(len(days)*.6)-1];b=days[int(len(days)*.8)-1]
def split(d):return 'TRAIN' if d<=a else ('VALID' if d<=b else 'TEST')
den={p:sum(1 for r in dy.itertuples() if r.top10 and split(r.day)==p) for p in ['TRAIN','VALID','TEST']}
print('SPLIT',days[0],a,b,days[-1],'symbols_with_data',x.symbol.nunique(),flush=True)

# 15m live entry grid. No regime/BTC filter.
grid=[]
for intr,rankk,r30,r60,qvr,qvmin,bo in itertools.product([.01,.02,.03,.04,.05],[5,10,15,20],[0,.005,.01],[0,.01,.02],[1.0,1.5,2.0,3.0],[1e6,5e6,20e6],[0,4,12]):
    m=(x.bar_no>=3)&(x.ret_day>=intr)&(x['rank']<=rankk)&(x.r30>=r30)&(x.r60>=r60)&(x.qvr>=qvr)&(x.qv24>=qvmin)
    if bo==4:m&=x.bo4
    if bo==12:m&=x.bo12
    sig=x[m].sort_values('t').groupby(['symbol','day'],as_index=False).first();ts=[]
    for r in sig.itertuples():
        # coarse 2h forward exit solely for entry-selection. final exit is 5m optimized later.
        g=x[(x.symbol==r.symbol)&(x.t>r.t)].head(8)
        if not len(g):continue
        ep=float(g.iloc[0].o);xp=float(g.iloc[-1].c);net=xp/ep-1-COST
        ts.append(dict(symbol=r.symbol,day=r.day,signal_t=r.t,entry15=ep,net=net,top10=lab.get((r.symbol,r.day),False),split=split(r.day)))
    row=dict(intr=intr,rank=rankk,r30=r30,r60=r60,qvr=qvr,qvmin=qvmin,bo=bo,events=ts)
    for p in ['TRAIN','VALID','TEST']:
        mm=met([z for z in ts if z['split']==p],den[p]);row.update({f'{p}_{k}':v for k,v in mm.items()})
    if row['TRAIN_n']<25 or row['VALID_n']<8:score=-999
    else:
        score=min(row['TRAIN_avg'],row['VALID_avg'])*100+.2*min(row['TRAIN_capture'],row['VALID_capture'])+.03*min(row['TRAIN_precision'],row['VALID_precision'])
        if min(row['TRAIN_pf'],row['VALID_pf'])<1:score-=1
    row['score']=score;grid.append(row)
grid.sort(key=lambda z:z['score'],reverse=True);best=grid[0]
print('ENTRY_BEST',json.dumps({k:v for k,v in best.items() if k!='events'},default=str),flush=True)

# Fetch 5m only for selected signal symbol-days. Use monthly Aug per unique symbol + daily Sep files.
unique_syms=sorted(set(e['symbol'] for e in best['events']));cache5={}
def fetch5(sym):
    parts=[];a5=parse_zip(req(monthly_url(sym,'5m','2026-08')),sym)
    if len(a5):parts.append(a5)
    for dd in pd.date_range('2026-09-01','2026-09-06').date:
        z=parse_zip(req(daily_url(sym,'5m',dd)),sym)
        if len(z):parts.append(z)
    return sym,(pd.concat(parts,ignore_index=True).drop_duplicates('t').sort_values('t') if parts else pd.DataFrame())
with ThreadPoolExecutor(max_workers=16) as ex:
    fs=[ex.submit(fetch5,s) for s in unique_syms]
    for i,f in enumerate(as_completed(fs),1):s,d=f.result();cache5[s]=d
print('5m symbols',len(cache5),flush=True)

def entry5(ev,mode):
    d=cache5.get(ev['symbol'],pd.DataFrame())
    if not len(d):return None
    start=pd.Timestamp(ev['signal_t'])+pd.Timedelta(minutes=15); end=start+pd.Timedelta(minutes=45)
    z=d[(d.t>=start)&(d.t<=end)].copy()
    if len(z)<2:return None
    if mode=='NEXT5':return z.iloc[0].t,float(z.iloc[0].o)
    hist=d[d.t<start].tail(24); comb=pd.concat([hist,z]).sort_values('t').copy();comb['ph6']=comb.h.shift(1).rolling(6,min_periods=4).max();comb['qmed12']=comb.qv.shift(1).rolling(12,min_periods=6).median();comb['r15']=comb.c/comb.c.shift(3)-1
    zz=comb[(comb.t>=start)&(comb.t<=end)]
    if mode=='BREAKOUT':zz=zz[(zz.c>=zz.ph6)&(zz.qv>=zz.qmed12*1.2)]
    else:zz=zz[(zz.r15>=.008)&(zz.c>zz.o)&(zz.qv>=zz.qmed12*1.2)]
    if not len(zz):return None
    t=zz.iloc[0].t+pd.Timedelta(minutes=5);n=d[d.t>=t]
    return (n.iloc[0].t,float(n.iloc[0].o)) if len(n) else None

def sim(ev,mode,stop,arm,trail,stale,maxmin):
    en=entry5(ev,mode)
    if not en:return None
    et,ep=en;d=cache5[ev['symbol']];bars=d[d.t>=et].head(maxmin//5+1)
    if len(bars)<2:return None
    peak=ep;peak_t=et;armed=False;mfe=0.;mae=0.;xp=float(bars.iloc[-1].c);xt=bars.iloc[-1].t;why='MAX'
    for r in bars.itertuples():
        if r.t==et:continue
        hard=ep*(1-stop);tr=peak*(1-trail)
        if r.l<=hard:xp=hard;xt=r.t;why='STOP';break
        if armed and r.l<=tr:xp=tr;xt=r.t;why='TRAIL';break
        if r.h>peak:peak=float(r.h);peak_t=r.t;armed=peak/ep-1>=arm or armed
        mfe=max(mfe,float(r.h)/ep-1);mae=min(mae,float(r.l)/ep-1)
        if (r.t-peak_t).total_seconds()/60>=stale:xp=float(r.c);xt=r.t;why='STALE';break
    gross=xp/ep-1;return dict(symbol=ev['symbol'],day=ev['day'],entry_t=et,entry=ep,exit_t=xt,exit=xp,gross=gross,net=gross-COST,mfe=mfe,mae=mae,giveback=max(0,mfe-gross),capture=(gross/mfe if mfe>0 else np.nan),why=why,top10=ev['top10'],split=ev['split'])

outs=[]
for mode,stop,arm,trail,stale,maxmin in itertools.product(['NEXT5','BREAKOUT','ACCEL'],[.015,.02,.03,.04],[.02,.03,.04,.05],[.015,.02,.03,.04,.05],[20,30,45,60,90],[180,360,720]):
    ts=[z for ev in best['events'] if (z:=sim(ev,mode,stop,arm,trail,stale,maxmin))]
    row=dict(mode=mode,stop=stop,arm=arm,trail=trail,stale=stale,maxmin=maxmin,trades=ts)
    for p in ['TRAIN','VALID','TEST']:
        mm=met([z for z in ts if z['split']==p],den[p]);row.update({f'{p}_{k}':v for k,v in mm.items()})
    if row['TRAIN_n']<20 or row['VALID_n']<6:score=-999
    else:
        score=min(row['TRAIN_avg'],row['VALID_avg'])*100+.12*min(row['TRAIN_capture'],row['VALID_capture'])
        if min(row['TRAIN_pf'],row['VALID_pf'])<1:score-=1
    row['score']=score;outs.append(row)
outs.sort(key=lambda z:z['score'],reverse=True);win=outs[0]
print('EXIT_BEST',json.dumps({k:v for k,v in win.items() if k!='trades'},default=str),flush=True)

# Reports
rep=['# V17 Leader Momentum — Binance Vision full-market research','',f'- Primary price source: official Binance Vision USDⓈ-M archive','- Regime/BTC filters: **none**',f'- Period: {START} ~ {END} KST',f'- Historical symbol directories enumerated: {len(symbols)}; 15m data available: {x.symbol.nunique()}',f'- Cost baseline: {COST_BPS:.0f} bp round trip','- End-of-day Top10 is label only; live signals use contemporaneous 15m cross-sectional rank.','', '## Entry selected on TRAIN+VALID only',f"`ret_day>={best['intr']*100:.1f}%`, live rank Top-{best['rank']}, r30>={best['r30']*100:.1f}%, r60>={best['r60']*100:.1f}%, qv_ratio>={best['qvr']:.1f}x, qv24>=${best['qvmin']/1e6:.0f}M, breakout={best['bo']}",'','## 5m entry / exit selected on TRAIN+VALID only',f"entry={win['mode']}; hard stop={win['stop']*100:.1f}%; trail arm=+{win['arm']*100:.1f}%; peak giveback={win['trail']*100:.1f}%; no-new-high={win['stale']}m; max hold={win['maxmin']//60}h",'', '|Split|N|Avg net|Win|PF|Top10 capture|Precision|','|---|---:|---:|---:|---:|---:|---:|']
for p in ['TRAIN','VALID','TEST']:rep.append(f"|{p}|{win[p+'_n']}|{win[p+'_avg']*100:.3f}%|{win[p+'_win']*100:.1f}%|{win[p+'_pf']:.2f}|{win[p+'_capture']*100:.1f}%|{win[p+'_precision']*100:.1f}%|")
rep+=['','## Cost stress (same rule)','','|Split|Cost|Avg|PF|','|---|---:|---:|---:|']
for p in ['TRAIN','VALID','TEST']:
    zz=[z for z in win['trades'] if z['split']==p]
    for cb in [21,35,50]:
        vals=[z['gross']-cb/10000 for z in zz];rep.append(f"|{p}|{cb}bp|{(np.mean(vals)*100 if vals else np.nan):.3f}%|{pf(vals):.2f}|")
# Sep 6 top10 examples in archive
rep+=['','## Latest archived KST day Top10 labels','']
last=dy[dy.day==END].sort_values('rank').head(10)
for r in last.itertuples():rep.append(f"- {int(r.rank)}. **{r.symbol}** {r.ret*100:+.2f}%")
open(f'{OUT}/vision_report.md','w').write('\n'.join(rep)+'\n')
pd.DataFrame([{k:v for k,v in r.items() if k!='events'} for r in grid[:100]]).to_csv(f'{OUT}/vision_entry_grid.csv',index=False)
pd.DataFrame([{k:v for k,v in r.items() if k!='trades'} for r in outs[:150]]).to_csv(f'{OUT}/vision_exit_grid.csv',index=False)
pd.DataFrame(win['trades']).to_csv(f'{OUT}/vision_chosen_trades.csv',index=False)
pd.DataFrame(dy[dy.top10]).to_csv(f'{OUT}/vision_daily_top10.csv',index=False)
print('\n'.join(rep),flush=True)
