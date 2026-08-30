#!/usr/bin/env python3
"""V10 R4: robustness surface around the BEAR rebound-fade mechanism and a
cycle-aware RANGE residual-reversion mechanism. No final TEST access.
"""
from __future__ import annotations
import json, statistics
from pathlib import Path

import run as base
import run_xs as xs
import run_r3 as r3

HERE=Path(__file__).resolve().parent
OUT=HERE/'r4-result.json'
base.CACHE=Path('v10-cache-r3'); r3.base.CACHE=base.CACHE

CANDS=[]
def add(**c):
    c['key']='R4_'+c['lane']+'_'+c['family']+'_'+str(len(CANDS)).zfill(4); CANDS.append(c)

# RANGE: structural RANGE + tactical cycle chooses which side to fade.
# Up-cycle -> fade strongest residual; down-cycle -> buy weakest residual.
for look in (48,72,96):
  for cycle in (12,24,48):
    for th in (.04,.05,.06):
      for sign_req in (False,True):
        add(lane='RANGE',family='CYCLE_RESID_MR',lookback_h=look,cycle_h=cycle,
            threshold=th,sign_req=sign_req,hold_h=24)

# BEAR: local robustness surface around the R3 winner, plus multi-horizon confirmation.
for look in (48,72,96):
  for th in (.02,.025,.03,.035,.04):
    for recent in ('NONE','POS24'):
      add(lane='BEAR',family='ABSSTRONG_SURFACE',lookback_h=look,threshold=th,
          recent=recent,scope='BEAR',hold_h=24)
for look in (72,96):
  for recent_h in (12,24,48):
    for th in (.02,.04):
      add(lane='BEAR',family='MULTI_REBOUND_FADE',lookback_h=look,recent_h=recent_h,
          threshold=th,scope='BEAR',hold_h=24)


def leg(c,a,i,side,bars,end_ms,score):
    p=xs.leg_pnl(bars[a],i,c['hold_h'],side,end_ms)
    if p is None:return None
    return xs.XTrade(c['key'],c['lane'],p[3],p[4],p[2],p[1],p[0],((a,side,p[2]),),score)


def signal(c,ts,bars,feats,indices,end_ms,exclude=None):
    bf=feats['BTC'].get(ts)
    if bf is None or not xs.scheduled(ts,c['hold_h']): return None
    if c['lane']=='RANGE':
        if bf.regime!='RANGE': return None
    else:
        if bf.regime!='BEAR': return None
    bi=indices['BTC'].get(ts)
    if bi is None:return None
    look=c['lookback_h']*4
    br=xs.ret_at(bars['BTC'],bi,look)
    if br is None:return None
    vals=[]
    for a in xs.NON_BTC:
        if a==exclude:continue
        i=indices[a].get(ts)
        if i is None or feats[a].get(ts) is None:continue
        rr=xs.ret_at(bars[a],i,look)
        if rr is None:continue
        vals.append((rr-br,rr,a,i))
    if len(vals)<12:return None

    if c['family']=='CYCLE_RESID_MR':
        cr=xs.ret_at(bars['BTC'],bi,c['cycle_h']*4)
        if cr is None:return None
        vals.sort(key=lambda x:x[0]); lo,hi=vals[0],vals[-1]
        if cr>=0:
            if hi[0]<c['threshold'] or (c['sign_req'] and hi[1]<=0):return None
            return leg(c,hi[2],hi[3],'SHORT',bars,end_ms,hi[0])
        if lo[0]>-c['threshold'] or (c['sign_req'] and lo[1]>=0):return None
        return leg(c,lo[2],lo[3],'LONG',bars,end_ms,-lo[0])

    vals.sort(key=lambda x:x[1]); top=vals[-1]
    if top[1]<c['threshold']:return None
    if c['family']=='ABSSTRONG_SURFACE':
        if c['recent']=='POS24':
            r24=xs.ret_at(bars[top[2]],top[3],96)
            if r24 is None or r24<=0:return None
        return leg(c,top[2],top[3],'SHORT',bars,end_ms,top[1])
    if c['family']=='MULTI_REBOUND_FADE':
        recent=xs.ret_at(bars[top[2]],top[3],c['recent_h']*4)
        if recent is None or recent<=0:return None
        return leg(c,top[2],top[3],'SHORT',bars,end_ms,top[1]+recent)
    return None


def eval_c(c,s,e,bars,feats,indices,exclude=None):
    out=[]
    for ts in sorted(feats['BTC']):
        if s<=ts<e:
            t=signal(c,ts,bars,feats,indices,e,exclude)
            if t is not None:out.append(t)
    return out,xs.metrics(out)


def period_eval(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end); _,m=eval_c(c,s,e,bars,feats,indices)
    span=e-s; qs=[]
    for j in range(4):
        a=s+(span*j)//4; b=s+(span*(j+1))//4
        _,q=eval_c(c,a,b,bars,feats,indices); qs.append(q)
    return {'metrics':m,'quarters':qs,'positive_quarters':sum(q['stress_bps']>0 for q in qs)}


def gates(c,a,b):
    ma,mb=a['metrics'],b['metrics']; mintr=18 if c['lane']=='RANGE' else 20
    return {
      'positive':ma['stress_bps']>0 and mb['stress_bps']>0,
      'pf':ma['stress_pf']>=1.08 and mb['stress_pf']>=1.08,
      'sample':ma['trades']>=mintr and mb['trades']>=mintr and ma['trades']+mb['trades']>=55,
      'quarters':a['positive_quarters']>=3 and b['positive_quarters']>=3,
      'halves':ma['first_half_stress_bps']>0 and ma['second_half_stress_bps']>0 and mb['first_half_stress_bps']>0 and mb['second_half_stress_bps']>0,
      'asset_share':ma['max_asset_exposure_share']<=.35 and mb['max_asset_exposure_share']<=.35,
    }


def loo(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end); rows=[]
    for a in xs.NON_BTC:
        _,m=eval_c(c,s,e,bars,feats,indices,a)
        if m['trades']>0:rows.append(m)
    return {'positive_share':round(sum(m['stress_bps']>0 for m in rows)/len(rows),4) if rows else 0,
            'median_mean_stress_bps':round(statistics.median([m['mean_stress_bps'] for m in rows]),3) if rows else 0}


def holdout(c,bars,feats,indices):
    y=period_eval(c,r3.D23S,r3.D23E,bars,feats,indices); m=y['metrics']; l=loo(c,r3.D23S,r3.D23E,bars,feats,indices)
    g={'positive':m['stress_bps']>0,'pf':m['stress_pf']>=1.05,'sample':m['trades']>=8,
       'halves':m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0,
       'subwindows':y['positive_quarters']>=2,'asset_share':m['max_asset_exposure_share']<=.40,
       'loo':l['positive_share']>=.60 and l['median_mean_stress_bps']>0}
    return {'period':y,'loo':l,'gates':g,'passed':all(g.values())}


def main():
    b24=r3.load_period(r3.D24S,r3.D24E); f24,i24=base.build_features(b24)
    b25=r3.load_period(r3.D25S,r3.D25E); f25,i25=base.build_features(b25)
    res={}
    for c in CANDS:
        a=period_eval(c,r3.D24S,r3.D24E,b24,f24,i24); b=period_eval(c,r3.D25S,r3.D25E,b25,f25,i25)
        g=gates(c,a,b); res[c['key']]={'candidate':c,'y2024':a,'y2025':b,'gates':g,'basic_pass':all(g.values())}
    for r in res.values():
        if not r['basic_pass']:continue
        c=r['candidate']; l24=loo(c,r3.D24S,r3.D24E,b24,f24,i24); l25=loo(c,r3.D25S,r3.D25E,b25,f25,i25)
        r['loo2024']=l24;r['loo2025']=l25
        r['loo_pass']=l24['positive_share']>=.65 and l25['positive_share']>=.65 and l24['median_mean_stress_bps']>0 and l25['median_mean_stress_bps']>0

    qual=[r for r in res.values() if r['basic_pass'] and r.get('loo_pass')]
    plateau={}
    for r in qual:
        c=r['candidate']
        if c['lane']=='RANGE': key=('RANGE',c['family'],c['lookback_h'],c['sign_req'])
        elif c['family']=='ABSSTRONG_SURFACE': key=('BEAR',c['family'],c['lookback_h'],c['recent'])
        else:key=('BEAR',c['family'],c['lookback_h'])
        plateau.setdefault(key,[]).append(c)
    pre={'RANGE':None,'BEAR':None}
    for lane in ('RANGE','BEAR'):
        arr=[]
        for r in qual:
            c=r['candidate']
            if c['lane']!=lane:continue
            if lane=='RANGE':
                key=('RANGE',c['family'],c['lookback_h'],c['sign_req']); peers=plateau.get(key,[])
                ok=len(peers)>=3 and len({x['cycle_h'] for x in peers})>=2 and len({x['threshold'] for x in peers})>=2
            elif c['family']=='ABSSTRONG_SURFACE':
                key=('BEAR',c['family'],c['lookback_h'],c['recent']); peers=plateau.get(key,[])
                ok=len({x['threshold'] for x in peers})>=3
            else:
                key=('BEAR',c['family'],c['lookback_h']); peers=plateau.get(key,[]); ok=len(peers)>=2
            r['plateau_pass']=ok
            if not ok:continue
            m24=r['y2024']['metrics'];m25=r['y2025']['metrics'];score=min(m24['mean_stress_bps'],m25['mean_stress_bps'])
            arr.append((score,min(m24['stress_pf'],m25['stress_pf']),c['key']))
        if arr:arr.sort(reverse=True);pre[lane]=arr[0][2]

    confirm={}; confirmed={'RANGE':None,'BEAR':None}
    if any(pre.values()):
        # This 2023 window was previously downloaded by R3 but no R3 candidate was evaluated on it.
        b23=r3.load_period(r3.D23S,r3.D23E); f23,i23=base.build_features(b23)
        for lane,k in pre.items():
            if k is None:continue
            x=holdout(res[k]['candidate'],b23,f23,i23);confirm[lane]=x
            if x['passed']:confirmed[lane]=k
    out={'revision':'V10_R4_ROBUSTNESS_20260830','test_accessed':False,
         'final_test_window_untouched':['2025-11-02T00:00:00+00:00','2026-01-01T00:00:00+00:00'],
         'candidate_count':len(CANDS),'preselected':pre,'confirmation':confirm,'confirmed':confirmed,'results':res}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R4_RESULT_BEGIN');print(json.dumps(out,ensure_ascii=False,sort_keys=True));print('V10_R4_RESULT_END')

if __name__=='__main__':main()
