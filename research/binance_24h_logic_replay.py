#!/usr/bin/env python3
import json, os, time, math
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import requests

SPOT='binance'; FUT='binance_futures'
LEV={SPOT:1.0,FUT:3.0}
COSTS={
    'fee_only': {SPOT:0.20,FUT:0.10},
    # Recent production fills: fees + average buy/sell slippage, expressed in underlying price %.
    'empirical_exec': {SPOT:0.331663,FUT:0.175643},
}
CHECKPOINTS=[180,300,460,600,900,1200,1800]
ARMS=[10,15,20,25,30,40,50,60,75,100]
RATIOS=[0.20,0.25,0.33,0.40,0.50,0.67]
TAILS=[600,900,1200,1800]


def now_utc(): return datetime.now(timezone.utc).replace(second=0,microsecond=0)
def ms(x): return int(x.timestamp()*1000)
def f(x,default=np.nan):
    try:
        y=float(x); return y if math.isfinite(y) else default
    except Exception: return default


def getj(s,url,params=None,tries=6):
    delay=.5
    for _ in range(tries):
        r=s.get(url,params=params or {},timeout=20)
        if r.status_code==200: return r.json()
        if r.status_code in (418,429) or r.status_code>=500:
            time.sleep(max(delay,float(r.headers.get('Retry-After',0) or 0))); delay*=2; continue
        raise RuntimeError(f'{r.status_code} {url}: {r.text[:180]}')
    raise RuntimeError(f'failed {url}')


def active(s,ex):
    if ex==SPOT:
        j=getj(s,'https://api.binance.com/api/v3/exchangeInfo')
        return {x['symbol'] for x in j['symbols'] if x.get('status')=='TRADING' and x.get('quoteAsset')=='USDT' and x.get('isSpotTradingAllowed',True)}
    j=getj(s,'https://fapi.binance.com/fapi/v1/exchangeInfo')
    return {x['symbol'] for x in j['symbols'] if x.get('status')=='TRADING' and x.get('quoteAsset')=='USDT' and x.get('contractType')=='PERPETUAL'}


def market_regime(s,ex,symbols):
    url='https://api.binance.com/api/v3/ticker/24hr' if ex==SPOT else 'https://fapi.binance.com/fapi/v1/ticker/24hr'
    rows=getj(s,url)
    vals=[]; weighted=[]
    for r in rows:
        sym=str(r.get('symbol',''))
        if sym not in symbols: continue
        pct=f(r.get('priceChangePercent')); qv=max(0,f(r.get('quoteVolume'),0))
        if math.isfinite(pct): vals.append(pct); weighted.append((pct,qv))
    a=np.array(vals,float)
    q=sum(w for _,w in weighted)
    return {
        'exchange':ex,'symbols':len(a),'mean_24h_pct':float(np.mean(a)),'median_24h_pct':float(np.median(a)),
        'positive_share':float(np.mean(a>0)),'p10_pct':float(np.quantile(a,.10)),'p90_pct':float(np.quantile(a,.90)),
        'quote_volume_weighted_pct':float(sum(v*w for v,w in weighted)/q) if q>0 else None,
    }


def bars_1m(s,ex,sym,start,end):
    url='https://api.binance.com/api/v3/klines' if ex==SPOT else 'https://fapi.binance.com/fapi/v1/klines'
    lim=1000 if ex==SPOT else 1500
    cur=ms(start); stop=ms(end); out=[]
    while cur<stop:
        j=getj(s,url,{'symbol':sym,'interval':'1m','startTime':cur,'endTime':stop,'limit':lim})
        if not j: break
        out.extend(j); nxt=int(j[-1][0])+60000
        if nxt<=cur: break
        cur=nxt; time.sleep(.025 if ex==SPOT else .055)
    if not out: return None
    # t,o,h,l,c,quoteVol,trades,takerBuyQuote
    return np.array([[int(r[0]),float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[7]),int(r[8]),float(r[10])] for r in out],float)


def load_candidates(start):
    with psycopg.connect(os.environ['SUPABASE_DB_URL'],autocommit=True) as c:
        q='''select id::text,exchange,market,created_at,decision,entry_low,estimated_cost_pct,failed_gate_count,
        coalesce(snapshot->'failed_gates',snapshot->'reasons',snapshot#>'{scalp_signal,reasons}',snapshot#>'{lob_signal,reasons}','[]'::jsonb)::text failed_gates
        from public.scanner_candidates where created_at >= %s and exchange in ('binance','binance_futures') and entry_low>0 order by created_at'''
        d=pd.read_sql_query(q,c,params=(start,))
    d.created_at=pd.to_datetime(d.created_at,utc=True); d.market=d.market.str.upper()
    def gate(r):
        if int(r.failed_gate_count or 0)!=1:return None
        try:
            x=json.loads(r.failed_gates)
            if isinstance(x,list) and len(x)==1:
                v=x[0]
                return v if isinstance(v,str) else str(v.get('code') or v.get('reason') or v)
        except Exception: pass
        return None
    d['gate']=d.apply(gate,axis=1)
    d['kind']=np.where(d.decision.isin(['BUY','ENTER']),'BUY',np.where(d.gate.notna(),'SINGLE_GATE_FAIL','OTHER'))
    return d[d.kind!='OTHER'].copy()


def dedup_episodes(d,seconds=180):
    kept=[]; last={}
    for i,r in d.sort_values('created_at').iterrows():
        key=(r.exchange,r.market,r.kind,r.gate if r.kind=='SINGLE_GATE_FAIL' else '')
        t=r.created_at.timestamp(); prev=last.get(key)
        if prev is None or t-prev>=seconds:
            kept.append(i); last[key]=t
    return d.loc[kept].copy()


def path_at(bars,ts,maxsec=1800):
    t=int(ts.timestamp()*1000); i=int(np.searchsorted(bars[:,0],t,'left'))
    if i>=len(bars):return None
    j=int(np.searchsorted(bars[:,0],t+maxsec*1000+60000,'right'))
    return bars[i:j] if j-i>=4 else None


def close_ret(path,entry,ts_ms,sec):
    i=int(np.searchsorted(path[:,0],ts_ms+sec*1000,'left'))
    if i>=len(path):return np.nan
    return (path[i,4]/entry-1)*100


def split(ts,start,end):
    x=(ts.to_pydatetime()-start).total_seconds()/max(1,(end-start).total_seconds())
    return 'train' if x<.6 else ('validation' if x<.8 else 'holdout')


def be_outcome(path,entry,ts_ms,ex,cost,arm_bps):
    lev=LEV[ex]; floor_ret=cost
    requested=(arm_bps/100.0)/lev
    arm_ret=max(requested,floor_ret)
    arm_px=entry*(1+arm_ret/100); floor_px=entry*(1+floor_ret/100)
    armed=None; stopped=False
    for i,b in enumerate(path):
        age=(b[0]-ts_ms)/1000
        if age>600:break
        if armed is None:
            if b[2]>=arm_px: armed=i
            continue
        if i>armed and b[3]<=floor_px:
            stopped=True; break
    base_gross=close_ret(path,entry,ts_ms,600)
    base=(base_gross-cost)*lev if math.isfinite(base_gross) else np.nan
    outcome=0.0 if stopped else base
    return outcome,base,int(armed is not None),int(stopped),arm_ret*lev*100


def recovery_outcome(path,entry,ts_ms,cost,ratio,tail=None):
    lev=3.0; idx=int(np.searchsorted(path[:,0],ts_ms+180000,'left'))
    if idx>=len(path):return None
    p180=path[idx,4]; net180=((p180/entry-1)*100-cost)*lev
    if net180>0:return {'latched':0,'outcome':net180,'reason':'NORMAL_POSITIVE_180','exit_sec':180}
    trough=min(p180,path[idx,3]); last=p180
    for i in range(idx,len(path)):
        b=path[i]; age=(b[0]-ts_ms)/1000; last=b[4]
        if b[3]<=entry*(1-4/100): return {'latched':1,'outcome':(-4-cost)*lev,'reason':'HARD_STOP','exit_sec':age}
        trough=min(trough,b[3]); net=((b[4]/entry-1)*100-cost)*lev
        if net>0:return {'latched':1,'outcome':net,'reason':'NET_POSITIVE','exit_sec':age}
        if 460<=age<600 and trough<entry:
            rr=(b[4]-trough)/(entry-trough)
            if rr>=ratio:return {'latched':1,'outcome':net,'reason':f'R{ratio:.2f}','exit_sec':age}
        if tail and age>=tail:return {'latched':1,'outcome':net,'reason':f'TAIL{tail}','exit_sec':age}
        if age>=1800:break
    net=((last/entry-1)*100-cost)*lev
    return {'latched':1,'outcome':net,'reason':'MARK_1800','exit_sec':1800}


def stats(x):
    a=np.array([v for v in x if math.isfinite(v)],float)
    if not len(a):return {'n':0}
    return {'n':len(a),'mean':float(a.mean()),'median':float(np.median(a)),'win_rate':float(np.mean(a>0)),'p05':float(np.quantile(a,.05)),'p95':float(np.quantile(a,.95)),'loss_mean':float(a[a<0].mean()) if np.any(a<0) else None}


def main():
    out=Path('research/results/candidate24h'); out.mkdir(parents=True,exist_ok=True)
    end=now_utc(); start=end-timedelta(hours=24)
    d=dedup_episodes(load_candidates(start),180)
    s=requests.Session(); s.headers['User-Agent']='Trading-booooo-24h-replay/1.0'
    universe={SPOT:active(s,SPOT),FUT:active(s,FUT)}
    regime=[market_regime(s,e,universe[e]) for e in (SPOT,FUT)]
    d=d[d.apply(lambda r:r.market in universe[r.exchange],axis=1)].copy()
    cache={}; needed=sorted(set((r.exchange,r.market) for _,r in d.iterrows()))
    for n,(ex,sym) in enumerate(needed,1):
        cache[(ex,sym)]=bars_1m(s,ex,sym,start-timedelta(minutes=2),end)
        if n%10==0: print('fetched',n,'of',len(needed),flush=True)
    events=[]
    for _,r in d.iterrows():
        b=cache.get((r.exchange,r.market)); p=path_at(b,r.created_at) if b is not None else None
        if p is None:continue
        ts=int(r.created_at.timestamp()*1000); entry=float(p[0,1])
        z={'exchange':r.exchange,'market':r.market,'time':r.created_at.isoformat(),'kind':r.kind,'gate':r.gate,'split':split(r.created_at,start,end),'entry':entry}
        for sec in CHECKPOINTS:z[f'gross_{sec}']=close_ret(p,entry,ts,sec)
        q=p[p[:,0]<=ts+600000]
        z['mfe600']=((q[:,2].max()/entry)-1)*100 if len(q) else np.nan
        z['mae600']=((q[:,3].min()/entry)-1)*100 if len(q) else np.nan
        events.append(z)
    ev=pd.DataFrame(events); ev.to_csv(out/'events.csv',index=False)

    checkpoints=[]
    for ex in (SPOT,FUT):
      for kind in ('BUY','SINGLE_GATE_FAIL'):
       q=ev[(ev.exchange==ex)&(ev.kind==kind)] if len(ev) else pd.DataFrame()
       for cm,cmap in COSTS.items():
        cost=cmap[ex]; lev=LEV[ex]
        for sec in CHECKPOINTS:
            vals=[(x-cost)*lev for x in q.get(f'gross_{sec}',[]) if math.isfinite(f(x))]
            checkpoints.append({'exchange':ex,'kind':kind,'cost_model':cm,'sec':sec,**stats(vals)})
    pd.DataFrame(checkpoints).to_csv(out/'checkpoints.csv',index=False)

    be=[]
    buys=d[d.kind=='BUY']
    for _,r in buys.iterrows():
        b=cache.get((r.exchange,r.market)); p=path_at(b,r.created_at) if b is not None else None
        if p is None:continue
        ts=int(r.created_at.timestamp()*1000); entry=float(p[0,1]); sp=split(r.created_at,start,end)
        for cm,cmap in COSTS.items():
          for arm in ARMS:
            outcome,base,armed,stopped,effective=be_outcome(p,entry,ts,r.exchange,cmap[r.exchange],arm)
            if math.isfinite(outcome) and math.isfinite(base):be.append({'exchange':r.exchange,'split':sp,'cost_model':cm,'arm_bps':arm,'effective_arm_bps':effective,'outcome':outcome,'baseline':base,'delta':outcome-base,'armed':armed,'stopped':stopped})
    be=pd.DataFrame(be); rows=[]
    if len(be):
      for keys,q in be.groupby(['exchange','split','cost_model','arm_bps','effective_arm_bps']):
        rows.append(dict(zip(['exchange','split','cost_model','arm_bps','effective_arm_bps'],keys),**stats(q.outcome),baseline_mean=float(q.baseline.mean()),delta_mean=float(q.delta.mean()),arm_rate=float(q.armed.mean()),stop_rate=float(q.stopped.mean())))
    pd.DataFrame(rows).to_csv(out/'breakeven.csv',index=False)

    rec=[]
    fbuys=buys[buys.exchange==FUT]
    for _,r in fbuys.iterrows():
        b=cache.get((FUT,r.market)); p=path_at(b,r.created_at) if b is not None else None
        if p is None:continue
        ts=int(r.created_at.timestamp()*1000); entry=float(p[0,1]); sp=split(r.created_at,start,end)
        for cm,cmap in COSTS.items():
          for ratio in RATIOS:
            cur=recovery_outcome(p,entry,ts,cmap[FUT],ratio,None)
            if cur:rec.append({'split':sp,'cost_model':cm,'ratio':ratio,'tail':'none',**cur})
          for tail in TAILS:
            cur=recovery_outcome(p,entry,ts,cmap[FUT],0.33,tail)
            if cur:rec.append({'split':sp,'cost_model':cm,'ratio':0.33,'tail':str(tail),**cur})
    rec=pd.DataFrame(rec); rsum=[]
    if len(rec):
      for keys,q in rec.groupby(['split','cost_model','ratio','tail']):
        lat=q[q.latched==1]
        st=stats(lat.outcome if len(lat) else [])
        rsum.append(dict(zip(['split','cost_model','ratio','tail'],keys),total_n=len(q),latched_n=len(lat),**st,recovered_positive_share=float(np.mean(lat.reason=='NET_POSITIVE')) if len(lat) else None,hard_stop_share=float(np.mean(lat.reason=='HARD_STOP')) if len(lat) else None,late_exit_share=float(np.mean(lat.reason.astype(str).str.startswith('R'))) if len(lat) else None))
    pd.DataFrame(rsum).to_csv(out/'recovery.csv',index=False)

    gates=[]
    if len(ev):
      q=ev[ev.kind=='SINGLE_GATE_FAIL']
      for (ex,g),x in q.groupby(['exchange','gate']):
        vals=[]; cost=COSTS['empirical_exec'][ex]; lev=LEV[ex]
        for v in x.gross_600:
            if math.isfinite(f(v)): vals.append((float(v)-cost)*lev)
        gates.append({'exchange':ex,'gate':g,**stats(vals)})
    pd.DataFrame(gates).sort_values(['exchange','mean'],ascending=[True,False]).to_csv(out/'gates.csv',index=False)

    meta={'start':start.isoformat(),'end':end.isoformat(),'raw_candidate_rows_24h':int(len(load_candidates(start))),'dedup_episode_rows':int(len(d)),'symbols_fetched':len(needed),'spot_active_usdt':len(universe[SPOT]),'futures_active_usdt_perp':len(universe[FUT]),'regime':regime,'cost_models':COSTS,'note':'Candidate episodes use first full 1m Binance bar open at/after signal; 180s dedup reduces repeated-scan overweight. 1m OHLC cannot resolve same-bar path ordering.'}
    (out/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    (out/'DONE').write_text(f'finished_at={now_utc().isoformat()}\n',encoding='utf-8')
    print(json.dumps(meta,indent=2))

if __name__=='__main__':main()
