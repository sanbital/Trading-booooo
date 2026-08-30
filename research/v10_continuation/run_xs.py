#!/usr/bin/env python3
"""V10 continuation round 2: low-turnover cross-sectional RANGE/BEAR lanes.

This file is committed before execution.  Discovery uses only 2025-01-01..2025-10-08.
The final 2025-11-02..2026-01-01 holdout is reachable only after xs-candidate-lock.json
is committed.  Signals are evaluated on completed 15m bars, entries use the next bar
open, exits are fixed-time, and every futures leg pays the same 23bp stress cost.
"""
from __future__ import annotations

import json, math, hashlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import run as base

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
LOCK_PATH=HERE/'xs-candidate-lock.json'
OUT_PATH=HERE/'xs-result.json'
STRESS_COST=23.0
BASE_COST=14.0
DAY_MS=24*60*60*1000
BAR_MS=15*60*1000
NON_BTC=[a for a in base.ASSETS if a!='BTC']


def canonical(x:Any)->bytes:
    return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def sha(x:Any)->str: return hashlib.sha256(canonical(x)).hexdigest()

def ret_at(bs,idx,bars_back):
    j=idx-bars_back
    if j<0 or bs[idx].ts-bs[j].ts!=bars_back*BAR_MS or bs[j].c<=0: return None
    return bs[idx].c/bs[j].c-1.0

def candidates():
    out=[]
    # RANGE: fixed-time market-neutral cross-sectional spread. One long + one short,
    # so cost hurdle is deliberately doubled to 46bp per pair.
    for direction in ('MR','MOM'):
        for lookback_h in (12,24,48,72):
            for hold_h in (12,24):
                for dispersion in (0.02,0.04,0.06):
                    out.append({'key':f'V10XS_RANGE_{direction}_L{lookback_h}_H{hold_h}_D{int(dispersion*100):02d}',
                                'lane':'RANGE','family':f'RANGE_XS_{direction}','kind':'RANGE_PAIR',
                                'direction':direction,'lookback_h':lookback_h,'hold_h':hold_h,'dispersion_min':dispersion})
    # BEAR: weakest-coin continuation relative to BTC.
    for lookback_h in (12,24,48,72):
        for hold_h in (12,24):
            for rel_max in (-0.01,-0.03,-0.05):
                out.append({'key':f'V10XS_BEAR_RELWEAK_L{lookback_h}_H{hold_h}_R{int(abs(rel_max)*100):02d}',
                            'lane':'BEAR','family':'BEAR_XS_RELWEAK','kind':'BEAR_RELWEAK',
                            'lookback_h':lookback_h,'hold_h':hold_h,'rel_max':rel_max})
    # BEAR: relief-rally fade in structurally weak coins. Long lookback must remain down,
    # short lookback must have rebounded; we short the strongest qualifying rebound.
    for hold_h in (12,24):
        for long_ret_max in (-0.04,-0.08,-0.12):
            for rebound_min in (0.01,0.025,0.04):
                out.append({'key':f'V10XS_BEAR_REBOUND_H{hold_h}_L{int(abs(long_ret_max)*100):02d}_R{int(rebound_min*1000):03d}',
                            'lane':'BEAR','family':'BEAR_XS_REBOUND_FADE','kind':'BEAR_REBOUND',
                            'hold_h':hold_h,'long_ret_max':long_ret_max,'rebound_min':rebound_min})
    return out

CANDIDATES=candidates()

@dataclass(slots=True)
class XTrade:
    key:str; lane:str; entry_ts:int; exit_ts:int; stress:float; base_pnl:float; gross:float
    legs:tuple[tuple[str,str,float], ...]; score:float


def folds():
    start=base.ms(base.DISC_START); out=[]
    for i in range(4):
        fs=start+i*40*DAY_MS; te=fs+120*DAY_MS; vs=te+16*BAR_MS; ve=fs+160*DAY_MS
        out.append((i+1,fs,te,vs,ve))
    if out[-1][-1]!=base.ms(base.DISC_END): raise RuntimeError('fold mismatch')
    return out

def scheduled(ts:int,hold_h:int)->bool:
    dt=datetime.fromtimestamp(ts/1000,UTC)
    if dt.minute!=0: return False
    return (dt.hour % hold_h)==0

def leg_pnl(bs,idx,hold_h,side,end_ms):
    entry_i=idx+1; hold_bars=hold_h*4; exit_i=entry_i+hold_bars-1
    if exit_i>=len(bs): return None
    if bs[exit_i].ts+BAR_MS>end_ms: return None
    entry=bs[entry_i].o; exitp=bs[exit_i].c
    gross=((exitp/entry-1) if side=='LONG' else (1-exitp/entry))*10000
    return gross,gross-BASE_COST,gross-STRESS_COST,bs[entry_i].ts,bs[exit_i].ts+BAR_MS

def range_pair(c,ts,bars,feats,indices,end_ms):
    bf=feats['BTC'].get(ts)
    if bf is None or bf.regime!='RANGE' or not scheduled(ts,c['hold_h']): return None
    btc_i=indices['BTC'].get(ts); bb=bars['BTC']; look=c['lookback_h']*4
    br=ret_at(bb,btc_i,look) if btc_i is not None else None
    if br is None: return None
    ranks=[]
    for a in NON_BTC:
        f=feats[a].get(ts); idx=indices[a].get(ts)
        if f is None or idx is None: continue
        rr=ret_at(bars[a],idx,look)
        if rr is None: continue
        ranks.append((rr-br,a,idx))
    if len(ranks)<12: return None
    ranks.sort()
    low,high=ranks[0],ranks[-1]; disp=high[0]-low[0]
    if disp<c['dispersion_min']: return None
    if c['direction']=='MR': longx,shortx=low,high
    else: longx,shortx=high,low
    lp=leg_pnl(bars[longx[1]],longx[2],c['hold_h'],'LONG',end_ms)
    sp=leg_pnl(bars[shortx[1]],shortx[2],c['hold_h'],'SHORT',end_ms)
    if lp is None or sp is None: return None
    gross=lp[0]+sp[0]; basep=lp[1]+sp[1]; stress=lp[2]+sp[2]
    legs=((longx[1],'LONG',lp[2]),(shortx[1],'SHORT',sp[2]))
    return XTrade(c['key'],'RANGE',lp[3],max(lp[4],sp[4]),stress,basep,gross,legs,disp)

def bear_trade(c,ts,bars,feats,indices,end_ms):
    bf=feats['BTC'].get(ts)
    if bf is None or bf.regime not in ('BEAR','STRONG_BEAR') or not scheduled(ts,c['hold_h']): return None
    btc_i=indices['BTC'].get(ts); bb=bars['BTC']
    if btc_i is None: return None
    chosen=None; score=None
    if c['kind']=='BEAR_RELWEAK':
        look=c['lookback_h']*4; br=ret_at(bb,btc_i,look)
        if br is None: return None
        vals=[]
        for a in NON_BTC:
            idx=indices[a].get(ts)
            if idx is None or feats[a].get(ts) is None: continue
            rr=ret_at(bars[a],idx,look)
            if rr is None: continue
            vals.append((rr-br,rr,a,idx))
        if len(vals)<12: return None
        vals.sort(); rel,absret,a,idx=vals[0]
        if rel>c['rel_max'] or absret>=0: return None
        chosen=(a,idx); score=-rel
    else:
        vals=[]
        for a in NON_BTC:
            idx=indices[a].get(ts)
            if idx is None or feats[a].get(ts) is None: continue
            r72=ret_at(bars[a],idx,72*4); r12=ret_at(bars[a],idx,12*4)
            if r72 is None or r12 is None: continue
            if r72<=c['long_ret_max'] and r12>=c['rebound_min']:
                vals.append((r12,-r72,a,idx))
        if not vals: return None
        vals.sort(reverse=True); reb,weak,a,idx=vals[0]; chosen=(a,idx); score=reb+weak
    a,idx=chosen; p=leg_pnl(bars[a],idx,c['hold_h'],'SHORT',end_ms)
    if p is None: return None
    return XTrade(c['key'],'BEAR',p[3],p[4],p[2],p[1],p[0],((a,'SHORT',p[2]),),score)

def trade_at(c,ts,bars,feats,indices,end_ms):
    return range_pair(c,ts,bars,feats,indices,end_ms) if c['kind']=='RANGE_PAIR' else bear_trade(c,ts,bars,feats,indices,end_ms)

def metrics(ts:list[XTrade]):
    ts=sorted(ts,key=lambda x:(x.entry_ts,x.key)); n=len(ts)
    total=sum(t.stress for t in ts); pos=sum(max(0,t.stress) for t in ts); neg=sum(min(0,t.stress) for t in ts)
    pf=pos/-neg if neg<0 else (999.0 if pos>0 else 0.0)
    eq=peak=0.0; dd=0.0
    exposure=defaultdict(int); contrib=defaultdict(float)
    for t in ts:
        eq+=t.stress; peak=max(peak,eq); dd=min(dd,eq-peak)
        for a,side,p in t.legs: exposure[a]+=1; contrib[a]+=p
    total_legs=sum(exposure.values())
    max_share=max(exposure.values(),default=0)/total_legs if total_legs else 0
    top=max(contrib,key=contrib.get,default=None)
    wo=[t for t in ts if top is None or all(a!=top for a,_,_ in t.legs)]
    wt=sum(t.stress for t in wo); wp=sum(max(0,t.stress) for t in wo); wn=sum(min(0,t.stress) for t in wo)
    wpf=wp/-wn if wn<0 else (999.0 if wp>0 else 0.0)
    if ts:
        mid=(ts[0].entry_ts+ts[-1].entry_ts)//2; h1=sum(t.stress for t in ts if t.entry_ts<=mid); h2=total-h1
    else: h1=h2=0.0
    return {'trades':n,'signal_days':len({t.entry_ts//DAY_MS for t in ts}),'wins':sum(t.stress>0 for t in ts),
            'stress_bps':round(total,3),'mean_stress_bps':round(total/n,3) if n else 0.0,'stress_pf':round(pf,4),
            'max_drawdown_bps':round(dd,3),'max_asset_exposure_share':round(max_share,4),'top_asset':top,
            'without_top_asset_stress_bps':round(wt,3),'without_top_asset_mean_bps':round(wt/len(wo),3) if wo else 0.0,
            'without_top_asset_pf':round(wpf,4),'first_half_stress_bps':round(h1,3),'second_half_stress_bps':round(h2,3),
            'gross_bps':round(sum(t.gross for t in ts),3),'base_bps':round(sum(t.base_pnl for t in ts),3)}

def eval_interval(c,start_ms,end_ms,bars,feats,indices):
    # Iterate BTC timestamps only because regime/schedule is global.
    out=[]
    for ts in sorted(feats['BTC']):
        if ts<start_ms or ts>=end_ms: continue
        t=trade_at(c,ts,bars,feats,indices,end_ms)
        if t is not None: out.append(t)
    return out,metrics(out)

def neighbor_ok(c,results):
    # A same-family adjacent parameterization must independently show positive validation
    # and at least 2 positive validation folds.
    for d in CANDIDATES:
        if d['key']==c['key'] or d['family']!=c['family']: continue
        # same horizon to avoid calling a fundamentally different holding rule a neighbor
        if d.get('hold_h')!=c.get('hold_h'): continue
        r=results[d['key']]
        if r['validation']['stress_bps']>0 and r['validation']['stress_pf']>1 and r['positive_validation_folds']>=2:
            return True
    return False

def discover(bars,feats,indices):
    res={}
    for c in CANDIDATES:
        train_all=[]; val_all=[]; fr=[]
        for no,ts,te,vs,ve in folds():
            tt,tm=eval_interval(c,ts,te,bars,feats,indices); vt,vm=eval_interval(c,vs,ve,bars,feats,indices)
            train_all+=tt; val_all+=vt; fr.append({'fold':no,'train':tm,'validation':vm})
        tm=metrics(train_all); vm=metrics(val_all); posf=sum(x['validation']['stress_bps']>0 for x in fr)
        res[c['key']]={'candidate':c,'train':tm,'validation':vm,'folds':fr,'positive_validation_folds':posf}
    selected={}
    for lane in ('RANGE','BEAR'):
        elig=[]
        for c in CANDIDATES:
            if c['lane']!=lane: continue
            r=res[c['key']]; tr=r['train']; va=r['validation']
            mintr=30 if c['hold_h']==24 else 55
            gates={'train_positive':tr['mean_stress_bps']>0 and tr['stress_pf']>1,
                   'validation_trades':va['trades']>=mintr,'validation_days':va['signal_days']>=20,
                   'validation_folds':r['positive_validation_folds']>=3,'validation_mean':va['mean_stress_bps']>=3.0,
                   'validation_pf':va['stress_pf']>=1.10,'asset_share':va['max_asset_exposure_share']<=0.25,
                   'top_asset_removal':va['without_top_asset_mean_bps']>0 and va['without_top_asset_pf']>1,
                   'halves':va['first_half_stress_bps']>0 and va['second_half_stress_bps']>0,
                   'neighbor':neighbor_ok(c,res)}
            r['gates']=gates; r['eligible']=all(gates.values())
            if r['eligible']: elig.append(r)
        if elig:
            elig.sort(key=lambda r:(-r['validation']['mean_stress_bps'],-r['validation']['stress_pf'],r['candidate']['key']))
            selected[lane]=elig[0]['candidate']['key']
        else: selected[lane]=None
    return {'mode':'DISCOVERY_XS','revision':'V10_XS_LOW_TURNOVER_20260830','candidate_universe_sha256':sha(CANDIDATES),
            'data_window':[base.DISC_START.isoformat(),base.DISC_END.isoformat()],'candidates':res,'selected':selected,'test_accessed':False}

def test_run(bars,feats,indices,lock):
    if lock.get('candidate_universe_sha256')!=sha(CANDIDATES): raise RuntimeError('candidate hash mismatch')
    by={c['key']:c for c in CANDIDATES}; lanes={}
    combined=[]
    for lane in ('RANGE','BEAR'):
        key=lock['selected'][lane]; c=by.get(key)
        if c is None or c['lane']!=lane: raise RuntimeError('bad lock')
        t,m=eval_interval(c,base.ms(base.TEST_START),base.ms(base.TEST_END),bars,feats,indices); combined+=t
        passed=m['trades']>=10 and m['stress_bps']>0 and m['stress_pf']>1 and m['without_top_asset_stress_bps']>0 and m['max_asset_exposure_share']<=0.35
        lanes[lane]={'candidate':key,'metrics':m,'passed':passed}
    cm=metrics(sorted(combined,key=lambda t:t.entry_ts)); pok=cm['stress_bps']>0 and abs(cm['max_drawdown_bps'])<=cm['stress_bps']
    return {'mode':'TEST_XS','revision':'V10_XS_LOW_TURNOVER_20260830','candidate_universe_sha256':sha(CANDIDATES),
            'lock_sha256':sha(lock),'test_window':[base.TEST_START.isoformat(),base.TEST_END.isoformat()],
            'lanes':lanes,'combined':cm,'portfolio_requirement_passed':pok,'passed':all(x['passed'] for x in lanes.values()) and pok,'test_accessed':True}

def main():
    mode='TEST' if LOCK_PATH.exists() else 'DISCOVERY'
    bars=base.load_bars(mode); feats,indices=base.build_features(bars)
    result=test_run(bars,feats,indices,json.loads(LOCK_PATH.read_text())) if mode=='TEST' else discover(bars,feats,indices)
    OUT_PATH.write_text(json.dumps(result,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_XS_RESULT_BEGIN'); print(json.dumps(result,ensure_ascii=False,sort_keys=True)); print('V10_XS_RESULT_END')
if __name__=='__main__': main()
