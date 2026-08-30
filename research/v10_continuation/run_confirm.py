#!/usr/bin/env python3
"""Independent V10 confirmation for shortlisted RANGE/BEAR mechanisms.

Selection input came from the 2025 discovery grid. This script NEVER reads the final
2025-11-02..2026-01-01 TEST window. It adds a previously-unused 2024 confirmation year,
replays 2025 exactly once as a non-overlapping whole interval, and replaces the old
pair concentration heuristic with true leave-one-asset-out re-simulation.
"""
from __future__ import annotations

import json, math, statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_xs as xs

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
OUT=HERE/'confirm-result.json'
BASE_CACHE=Path('v10-cache-confirm')
base.CACHE=BASE_CACHE

Y2024_START=datetime(2024,1,1,tzinfo=UTC)
Y2024_END=datetime(2025,1,1,tzinfo=UTC)
Y2025_START=base.DISC_START
Y2025_END=base.DISC_END

RANGE_KEYS=[
    'V10XS_RANGE_MR_L12_H24_D02',
    'V10XS_RANGE_MR_L24_H24_D04',
    'V10XS_RANGE_MR_L48_H24_D02',
    'V10XS_RANGE_MR_L48_H24_D06',
]
BEAR_BASE_KEYS=[
    'V10XS_BEAR_RELWEAK_L24_H12_R03',
    'V10XS_BEAR_RELWEAK_L48_H12_R01',
    'V10XS_BEAR_RELWEAK_L24_H12_R05',
]
BEAR_SCOPES=('BOTH','BEAR','STRONG_BEAR')
BY_KEY={c['key']:c for c in xs.CANDIDATES}


def load_period(start,end):
    jobs=[(a,y,m) for a in base.ASSETS for y,m in base.months(start,end)]
    paths={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        fut={ex.submit(base.get_archive,*j):j for j in jobs}
        for f in as_completed(fut):
            paths[fut[f]]=f.result()
    s,e=base.ms(start),base.ms(end); result={}
    for a in base.ASSETS:
        rows=[]
        for y,m in base.months(start,end): rows.extend(base.parse_archive(paths[(a,y,m)],s,e))
        rows.sort(key=lambda b:b.ts)
        if len(rows)<1000: raise RuntimeError(f'insufficient bars {a} {len(rows)}')
        result[a]=rows
    return result


def range_pair(c,ts,bars,feats,indices,end_ms,exclude):
    bf=feats['BTC'].get(ts)
    if bf is None or bf.regime!='RANGE' or not xs.scheduled(ts,c['hold_h']): return None
    btc_i=indices['BTC'].get(ts); bb=bars['BTC']; look=c['lookback_h']*4
    br=xs.ret_at(bb,btc_i,look) if btc_i is not None else None
    if br is None: return None
    ranks=[]
    for a in xs.NON_BTC:
        if a==exclude: continue
        f=feats[a].get(ts); idx=indices[a].get(ts)
        if f is None or idx is None: continue
        rr=xs.ret_at(bars[a],idx,look)
        if rr is None: continue
        ranks.append((rr-br,a,idx))
    if len(ranks)<12: return None
    ranks.sort(); low,high=ranks[0],ranks[-1]; disp=high[0]-low[0]
    if disp<c['dispersion_min']: return None
    longx,shortx=(low,high) if c['direction']=='MR' else (high,low)
    lp=xs.leg_pnl(bars[longx[1]],longx[2],c['hold_h'],'LONG',end_ms)
    sp=xs.leg_pnl(bars[shortx[1]],shortx[2],c['hold_h'],'SHORT',end_ms)
    if lp is None or sp is None: return None
    return xs.XTrade(c['key'],'RANGE',lp[3],max(lp[4],sp[4]),lp[2]+sp[2],lp[1]+sp[1],lp[0]+sp[0],
                     ((longx[1],'LONG',lp[2]),(shortx[1],'SHORT',sp[2])),disp)


def bear_trade(c,ts,bars,feats,indices,end_ms,exclude,scope):
    bf=feats['BTC'].get(ts)
    if bf is None or bf.regime not in ('BEAR','STRONG_BEAR') or not xs.scheduled(ts,c['hold_h']): return None
    if scope!='BOTH' and bf.regime!=scope: return None
    btc_i=indices['BTC'].get(ts); bb=bars['BTC']
    if btc_i is None: return None
    look=c['lookback_h']*4; br=xs.ret_at(bb,btc_i,look)
    if br is None: return None
    vals=[]
    for a in xs.NON_BTC:
        if a==exclude: continue
        idx=indices[a].get(ts)
        if idx is None or feats[a].get(ts) is None: continue
        rr=xs.ret_at(bars[a],idx,look)
        if rr is None: continue
        vals.append((rr-br,rr,a,idx))
    if len(vals)<12: return None
    vals.sort(); rel,absret,a,idx=vals[0]
    if rel>c['rel_max'] or absret>=0: return None
    p=xs.leg_pnl(bars[a],idx,c['hold_h'],'SHORT',end_ms)
    if p is None: return None
    return xs.XTrade(c['key'],'BEAR',p[3],p[4],p[2],p[1],p[0],((a,'SHORT',p[2]),),-rel)


def eval_c(c,start_ms,end_ms,bars,feats,indices,exclude=None,scope='BOTH'):
    out=[]
    for ts in sorted(feats['BTC']):
        if ts<start_ms or ts>=end_ms: continue
        t=(range_pair(c,ts,bars,feats,indices,end_ms,exclude)
           if c['lane']=='RANGE' else bear_trade(c,ts,bars,feats,indices,end_ms,exclude,scope))
        if t is not None: out.append(t)
    return out,xs.metrics(out)


def subwindow_stats(c,start_ms,end_ms,bars,feats,indices,scope):
    span=end_ms-start_ms; out=[]
    for i in range(4):
        s=start_ms+(span*i)//4; e=start_ms+(span*(i+1))//4
        _,m=eval_c(c,s,e,bars,feats,indices,None,scope); out.append(m)
    return out


def loo_stats(c,start_ms,end_ms,bars,feats,indices,scope):
    rows=[]
    for a in xs.NON_BTC:
        _,m=eval_c(c,start_ms,end_ms,bars,feats,indices,a,scope)
        rows.append({'excluded':a,**m})
    usable=[r for r in rows if r['trades']>0]
    means=[r['mean_stress_bps'] for r in usable]
    pos=sum(r['stress_bps']>0 for r in usable)
    return {
        'positive_share': round(pos/len(usable),4) if usable else 0.0,
        'median_mean_stress_bps': round(statistics.median(means),3) if means else 0.0,
        'worst_mean_stress_bps': round(min(means),3) if means else 0.0,
        'rows': rows,
    }


def one_year(c,start,end,bars,feats,indices,scope):
    s,e=base.ms(start),base.ms(end)
    _,m=eval_c(c,s,e,bars,feats,indices,None,scope)
    qs=subwindow_stats(c,s,e,bars,feats,indices,scope)
    loo=loo_stats(c,s,e,bars,feats,indices,scope)
    return {'metrics':m,'subwindows':qs,'positive_subwindows':sum(q['stress_bps']>0 for q in qs),'loo':loo}


def gates(lane,a,b):
    ma,mb=a['metrics'],b['metrics']
    min_year_trades=15 if lane=='RANGE' else 20
    return {
        'both_years_positive': ma['stress_bps']>0 and mb['stress_bps']>0,
        'both_years_pf': ma['stress_pf']>=1.05 and mb['stress_pf']>=1.05,
        'sample_size': ma['trades']>=min_year_trades and mb['trades']>=min_year_trades and ma['trades']+mb['trades']>=50,
        'subwindow_stability': a['positive_subwindows']>=2 and b['positive_subwindows']>=2,
        'half_stability': ma['first_half_stress_bps']>0 and ma['second_half_stress_bps']>0 and mb['first_half_stress_bps']>0 and mb['second_half_stress_bps']>0,
        'asset_exposure': ma['max_asset_exposure_share']<=0.25 and mb['max_asset_exposure_share']<=0.25,
        'true_loo': a['loo']['positive_share']>=0.65 and b['loo']['positive_share']>=0.65 and a['loo']['median_mean_stress_bps']>0 and b['loo']['median_mean_stress_bps']>0,
    }


def main():
    bars24=load_period(Y2024_START,Y2024_END); feats24,idx24=base.build_features(bars24)
    bars25=load_period(Y2025_START,Y2025_END); feats25,idx25=base.build_features(bars25)
    specs=[]
    for k in RANGE_KEYS: specs.append((k,BY_KEY[k],'BOTH'))
    for k in BEAR_BASE_KEYS:
        for scope in BEAR_SCOPES: specs.append((f'{k}__{scope}',BY_KEY[k],scope))
    results={}; selected={'RANGE':None,'BEAR':None}
    for name,c,scope in specs:
        y24=one_year(c,Y2024_START,Y2024_END,bars24,feats24,idx24,scope)
        y25=one_year(c,Y2025_START,Y2025_END,bars25,feats25,idx25,scope)
        gs=gates(c['lane'],y24,y25); eligible=all(gs.values())
        score=min(y24['metrics']['mean_stress_bps'],y25['metrics']['mean_stress_bps'])
        results[name]={'candidate':c,'scope':scope,'y2024':y24,'y2025':y25,'gates':gs,'eligible':eligible,'robust_score':round(score,3)}
    for lane in ('RANGE','BEAR'):
        elig=[(n,r) for n,r in results.items() if r['candidate']['lane']==lane and r['eligible']]
        if elig:
            elig.sort(key=lambda x:(-x[1]['robust_score'],-min(x[1]['y2024']['metrics']['stress_pf'],x[1]['y2025']['metrics']['stress_pf']),x[0]))
            selected[lane]=elig[0][0]
    out={'revision':'V10_INDEPENDENT_CONFIRM_20260830','test_accessed':False,
         'confirmation_windows':[Y2024_START.isoformat(),Y2024_END.isoformat(),Y2025_START.isoformat(),Y2025_END.isoformat()],
         'selection_rule':'both years positive + PF>=1.05 + sample + subwindow/half stability + <=25% asset exposure + true leave-one-asset-out robustness',
         'selected':selected,'results':results}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_CONFIRM_RESULT_BEGIN'); print(json.dumps(out,ensure_ascii=False,sort_keys=True)); print('V10_CONFIRM_RESULT_END')

if __name__=='__main__': main()
