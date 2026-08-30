#!/usr/bin/env python3
"""V10 R3: new regime-specific mechanisms, no final TEST access.

Discovery/validation: 2024-01-01..2025-10-08, evaluated separately by year and quarter.
Independent pre-test confirmation: 2023-09-01..2024-01-01, applied ONLY to the single
preselected winner per lane. Final TEST 2025-11-02..2026-01-01 is never read here.
"""
from __future__ import annotations

import json, statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_xs as xs

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
OUT=HERE/'r3-result.json'
base.CACHE=Path('v10-cache-r3')

D23S=datetime(2023,9,1,tzinfo=UTC); D23E=datetime(2024,1,1,tzinfo=UTC)
D24S=datetime(2024,1,1,tzinfo=UTC); D24E=datetime(2025,1,1,tzinfo=UTC)
D25S=base.DISC_START; D25E=base.DISC_END

CANDS=[]
def add(**c):
    c['key']='R3_'+c['lane']+'_'+c['family']+'_'+str(len(CANDS)).zfill(4)
    CANDS.append(c)

# RANGE: single-leg cross-sectional residual reversal. This avoids the 46bp two-leg drag.
for mode in ('LONG_WEAK','SHORT_STRONG','SELECTIVE'):
  for look in (12,24,48,72):
    for hold in (12,24):
      for th in (.02,.04,.06):
        add(lane='RANGE',family='XS_RESID_MR',mode=mode,lookback_h=look,hold_h=hold,threshold=th)
# RANGE: BTC itself fades large moves while structural state remains RANGE.
for look in (12,24,48):
  for hold in (12,24):
    for th in (.015,.025,.04):
      add(lane='RANGE',family='BTC_FADE',mode='BTC_FADE',lookback_h=look,hold_h=hold,threshold=th)

# BEAR: index continuation, cross-sectional rebound fade, and absolute downside continuation.
for asset in ('BTC','ETH'):
  for scope in ('BOTH','BEAR','STRONG_BEAR'):
    for hold in (12,24,48):
      for mom in ('NONE','NEG24'):
        add(lane='BEAR',family='INDEX_SHORT',asset=asset,scope=scope,hold_h=hold,momentum=mom)
for scope in ('BOTH','BEAR','STRONG_BEAR'):
  for look in (12,24,48,72):
    for hold in (12,24):
      for th in (.01,.03,.05):
        add(lane='BEAR',family='XS_RELSTRONG_FADE',scope=scope,lookback_h=look,hold_h=hold,threshold=th)
for fam,mode in (('XS_ABSWEAK_MOM','ABSWEAK'),('XS_ABSSTRONG_FADE','ABSSTRONG')):
  for scope in ('BOTH','BEAR','STRONG_BEAR'):
    for look in (24,48,72):
      for hold in (12,24):
        for th in (.03,.05,.08):
          add(lane='BEAR',family=fam,mode=mode,scope=scope,lookback_h=look,hold_h=hold,threshold=th)


def load_period(start,end):
    jobs=[(a,y,m) for a in base.ASSETS for y,m in base.months(start,end)]
    paths={}
    with ThreadPoolExecutor(max_workers=10) as ex:
        fut={ex.submit(base.get_archive,*j):j for j in jobs}
        for f in as_completed(fut): paths[fut[f]]=f.result()
    s,e=base.ms(start),base.ms(end); out={}
    for a in base.ASSETS:
        rows=[]
        for y,m in base.months(start,end): rows.extend(base.parse_archive(paths[(a,y,m)],s,e))
        rows.sort(key=lambda b:b.ts)
        if len(rows)<1000: raise RuntimeError(f'insufficient bars {a} {len(rows)}')
        out[a]=rows
    return out


def legtrade(c,a,idx,side,bars,end_ms,score):
    p=xs.leg_pnl(bars[a],idx,c['hold_h'],side,end_ms)
    if p is None: return None
    return xs.XTrade(c['key'],c['lane'],p[3],p[4],p[2],p[1],p[0],((a,side,p[2]),),score)


def signal(c,ts,bars,feats,indices,end_ms,exclude=None):
    bf=feats['BTC'].get(ts)
    if bf is None or not xs.scheduled(ts,c['hold_h']): return None
    lane=c['lane']; fam=c['family']
    if lane=='RANGE' and bf.regime!='RANGE': return None
    if lane=='BEAR':
        if bf.regime not in ('BEAR','STRONG_BEAR'): return None
        scope=c.get('scope','BOTH')
        if scope!='BOTH' and bf.regime!=scope: return None

    if fam=='BTC_FADE':
        i=indices['BTC'].get(ts); look=c['lookback_h']*4
        if i is None: return None
        r=xs.ret_at(bars['BTC'],i,look)
        if r is None or abs(r)<c['threshold']: return None
        return legtrade(c,'BTC',i,'SHORT' if r>0 else 'LONG',bars,end_ms,abs(r))

    if fam=='INDEX_SHORT':
        a=c['asset']; i=indices[a].get(ts)
        if i is None: return None
        if c['momentum']=='NEG24':
            r=xs.ret_at(bars[a],i,96)
            if r is None or r>=0: return None
        return legtrade(c,a,i,'SHORT',bars,end_ms,1.0)

    bi=indices['BTC'].get(ts)
    if bi is None: return None
    look=c['lookback_h']*4
    br=xs.ret_at(bars['BTC'],bi,look)
    if br is None: return None
    vals=[]
    for a in xs.NON_BTC:
        if a==exclude: continue
        i=indices[a].get(ts)
        if i is None or feats[a].get(ts) is None: continue
        r=xs.ret_at(bars[a],i,look)
        if r is None: continue
        vals.append((r-br,r,a,i))
    if len(vals)<12: return None
    vals.sort(key=lambda x:x[0])

    if fam=='XS_RESID_MR':
        lo,hi=vals[0],vals[-1]; mode=c['mode']; th=c['threshold']
        if mode=='LONG_WEAK':
            if lo[0]>-th: return None
            return legtrade(c,lo[2],lo[3],'LONG',bars,end_ms,-lo[0])
        if mode=='SHORT_STRONG':
            if hi[0]<th: return None
            return legtrade(c,hi[2],hi[3],'SHORT',bars,end_ms,hi[0])
        chosen=lo if -lo[0]>=hi[0] else hi
        if abs(chosen[0])<th: return None
        return legtrade(c,chosen[2],chosen[3],'LONG' if chosen is lo else 'SHORT',bars,end_ms,abs(chosen[0]))

    if fam=='XS_RELSTRONG_FADE':
        hi=vals[-1]
        if hi[0]<c['threshold'] or hi[1]<=0: return None
        return legtrade(c,hi[2],hi[3],'SHORT',bars,end_ms,hi[0])

    # Absolute-return candidates use the same precomputed universe, ranked on absolute return.
    absvals=sorted(vals,key=lambda x:x[1])
    if fam=='XS_ABSWEAK_MOM':
        x=absvals[0]
        if x[1]>-c['threshold']: return None
        return legtrade(c,x[2],x[3],'SHORT',bars,end_ms,-x[1])
    if fam=='XS_ABSSTRONG_FADE':
        x=absvals[-1]
        if x[1]<c['threshold']: return None
        return legtrade(c,x[2],x[3],'SHORT',bars,end_ms,x[1])
    return None


def eval_c(c,s,e,bars,feats,indices,exclude=None):
    out=[]
    for ts in sorted(feats['BTC']):
        if ts<s or ts>=e: continue
        t=signal(c,ts,bars,feats,indices,e,exclude)
        if t is not None: out.append(t)
    return out,xs.metrics(out)


def quarters(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end); span=e-s; rows=[]
    for i in range(4):
        a=s+(span*i)//4; b=s+(span*(i+1))//4
        _,m=eval_c(c,a,b,bars,feats,indices); rows.append(m)
    return rows


def year_eval(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end)
    _,m=eval_c(c,s,e,bars,feats,indices)
    qs=quarters(c,start,end,bars,feats,indices)
    return {'metrics':m,'quarters':qs,'positive_quarters':sum(q['stress_bps']>0 for q in qs)}


def basic_gates(c,a,b):
    ma,mb=a['metrics'],b['metrics']; min_tr=18 if c['lane']=='RANGE' else 20
    fixed=c['family'] in ('BTC_FADE','INDEX_SHORT')
    return {
      'both_years_positive':ma['stress_bps']>0 and mb['stress_bps']>0,
      'pf':ma['stress_pf']>=1.08 and mb['stress_pf']>=1.08,
      'sample':ma['trades']>=min_tr and mb['trades']>=min_tr and ma['trades']+mb['trades']>=55,
      'quarters':a['positive_quarters']>=3 and b['positive_quarters']>=3,
      'halves':ma['first_half_stress_bps']>0 and ma['second_half_stress_bps']>0 and mb['first_half_stress_bps']>0 and mb['second_half_stress_bps']>0,
      'asset_share': fixed or (ma['max_asset_exposure_share']<=.35 and mb['max_asset_exposure_share']<=.35),
    }


def loo(c,start,end,bars,feats,indices):
    if c['family'] in ('BTC_FADE','INDEX_SHORT'):
        return {'applicable':False,'positive_share':1.0,'median_mean_stress_bps':999.0}
    s,e=base.ms(start),base.ms(end); rows=[]
    for a in xs.NON_BTC:
        _,m=eval_c(c,s,e,bars,feats,indices,a)
        if m['trades']>0: rows.append((a,m))
    pos=sum(m['stress_bps']>0 for _,m in rows)
    med=statistics.median([m['mean_stress_bps'] for _,m in rows]) if rows else 0.0
    return {'applicable':True,'positive_share':round(pos/len(rows),4) if rows else 0.0,'median_mean_stress_bps':round(med,3)}


def neighbor_signature(c):
    # Threshold is intentionally excluded: adjacent thresholds are robustness neighbors.
    x={k:v for k,v in c.items() if k not in ('key','threshold')}
    return json.dumps(x,sort_keys=True)


def confirm23(c,bars,feats,indices):
    y=year_eval(c,D23S,D23E,bars,feats,indices); m=y['metrics']
    l=loo(c,D23S,D23E,bars,feats,indices)
    fixed=c['family'] in ('BTC_FADE','INDEX_SHORT')
    gates={
      'positive':m['stress_bps']>0,
      'pf':m['stress_pf']>=1.05,
      'sample':m['trades']>=8,
      'halves':m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0,
      'subwindows':y['positive_quarters']>=2,
      'asset_share':fixed or m['max_asset_exposure_share']<=.40,
      'loo':(not l['applicable']) or (l['positive_share']>=.60 and l['median_mean_stress_bps']>0),
    }
    return {'period':y,'loo':l,'gates':gates,'passed':all(gates.values())}


def main():
    b24=load_period(D24S,D24E); f24,i24=base.build_features(b24)
    b25=load_period(D25S,D25E); f25,i25=base.build_features(b25)
    res={}
    for c in CANDS:
        a=year_eval(c,D24S,D24E,b24,f24,i24); b=year_eval(c,D25S,D25E,b25,f25,i25)
        g=basic_gates(c,a,b)
        res[c['key']]={'candidate':c,'y2024':a,'y2025':b,'basic_gates':g,'basic_pass':all(g.values())}
    # Compute expensive true LOO only after basic qualification.
    for k,r in res.items():
        if not r['basic_pass']: continue
        c=r['candidate']; l24=loo(c,D24S,D24E,b24,f24,i24); l25=loo(c,D25S,D25E,b25,f25,i25)
        lp=(not l24['applicable']) or (l24['positive_share']>=.65 and l25['positive_share']>=.65 and l24['median_mean_stress_bps']>0 and l25['median_mean_stress_bps']>0)
        r['loo2024']=l24; r['loo2025']=l25; r['loo_pass']=lp
    qualified=[r for r in res.values() if r.get('basic_pass') and r.get('loo_pass',False)]
    # Neighbor requirement for thresholded grids; fixed-index families require another family member to qualify.
    sig_counts={}
    fam_counts={}
    for r in qualified:
        c=r['candidate']; sig_counts[neighbor_signature(c)]=sig_counts.get(neighbor_signature(c),0)+1
        famkey=(c['lane'],c['family'],c.get('scope'),c.get('asset'),c.get('mode'))
        fam_counts[famkey]=fam_counts.get(famkey,0)+1
    preselected={'RANGE':None,'BEAR':None}
    for lane in ('RANGE','BEAR'):
        arr=[]
        for r in qualified:
            c=r['candidate']
            if c['lane']!=lane: continue
            if 'threshold' in c:
                neighbor_ok=sig_counts.get(neighbor_signature(c),0)>=2
            else:
                fk=(c['lane'],c['family'],c.get('scope'),c.get('asset'),c.get('mode'))
                neighbor_ok=fam_counts.get(fk,0)>=2
            r['neighbor_pass']=neighbor_ok
            if not neighbor_ok: continue
            m24=r['y2024']['metrics']; m25=r['y2025']['metrics']
            score=min(m24['mean_stress_bps'],m25['mean_stress_bps'])
            arr.append((score,min(m24['stress_pf'],m25['stress_pf']),c['key']))
        if arr:
            arr.sort(reverse=True); preselected[lane]=arr[0][2]
    # Only the one preselected candidate per lane sees the independent 2023 confirmation.
    b23=load_period(D23S,D23E); f23,i23=base.build_features(b23)
    confirmed={'RANGE':None,'BEAR':None}; confirm={}
    for lane,k in preselected.items():
        if k is None: continue
        x=confirm23(res[k]['candidate'],b23,f23,i23); confirm[lane]=x
        if x['passed']: confirmed[lane]=k
    out={
      'revision':'V10_R3_MECHANISMS_20260830',
      'test_accessed':False,
      'final_test_window_untouched':['2025-11-02T00:00:00+00:00','2026-01-01T00:00:00+00:00'],
      'discovery_windows':[D24S.isoformat(),D24E.isoformat(),D25S.isoformat(),D25E.isoformat()],
      'independent_confirmation_window':[D23S.isoformat(),D23E.isoformat()],
      'candidate_count':len(CANDS),
      'preselected':preselected,'confirmation':confirm,'confirmed':confirmed,'results':res,
    }
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R3_RESULT_BEGIN'); print(json.dumps(out,ensure_ascii=False,sort_keys=True)); print('V10_R3_RESULT_END')

if __name__=='__main__': main()
