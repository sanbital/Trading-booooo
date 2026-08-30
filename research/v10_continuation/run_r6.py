#!/usr/bin/env python3
"""V10 R6: final pre-TEST robustness research.

- RANGE: local parameter surface around the three-period CYCLE_RESID_MR edge.
- BEAR: only trade isolated rebound/weakness when cross-sectional breadth confirms a
  genuinely weak market. This addresses the 2023 failure mode without using final TEST.

All selection uses 2023-09..12, 2024, and 2025-01..10-08. Final TEST is untouched.
"""
from __future__ import annotations
import json, statistics
from pathlib import Path

import run as base
import run_xs as xs
import run_r3 as r3

HERE=Path(__file__).resolve().parent
OUT=HERE/'r6-result.json'
base.CACHE=Path('v10-cache-r3'); r3.base.CACHE=base.CACHE

CANDS=[]
def add(**c):
    c['key']='R6_'+c['lane']+'_'+c['family']+'_'+str(len(CANDS)).zfill(4)
    CANDS.append(c)

# RANGE: local neighborhood around 12h / 5.0-5.5% surface. Keep simpler sign_req=False.
for cycle_h in (9,10,11,12,13,14,15):
    for th in (.0475,.05,.0525,.055,.0575):
        add(lane='RANGE',family='CYCLE_RESID_MR',lookback_h=72,cycle_h=cycle_h,
            threshold=th,hold_h=24)

# BEAR: breadth-conditioned mechanisms. Structural state must be exact BEAR.
# Broad thresholds are economic, not final-test tuned.
for fam in ('REBOUND_FADE_BREADTH','RELSTRONG_FADE_BREADTH','WEAK_MOM_BREADTH','LEADER_FAIL_BREADTH'):
    for th in ((.02,.03,.04) if fam!='WEAK_MOM_BREADTH' else (.03,.05,.07)):
        for neg_share in (.55,.65,.75):
            for median_max in (.01,0.0,-.01):
                for btc24_req in (False,True):
                    add(lane='BEAR',family=fam,lookback_h=72,threshold=th,
                        neg_share_min=neg_share,median24_max=median_max,
                        btc24_negative=btc24_req,hold_h=24)


def leg(c,a,i,side,bars,end_ms,score):
    p=xs.leg_pnl(bars[a],i,c['hold_h'],side,end_ms)
    if p is None:return None
    return xs.XTrade(c['key'],c['lane'],p[3],p[4],p[2],p[1],p[0],((a,side,p[2]),),score)


def universe(ts,bars,feats,indices,exclude=None):
    bi=indices['BTC'].get(ts)
    if bi is None:return None
    btc24=xs.ret_at(bars['BTC'],bi,96); btc72=xs.ret_at(bars['BTC'],bi,288)
    if btc24 is None or btc72 is None:return None
    vals=[]
    for a in xs.NON_BTC:
        if a==exclude:continue
        i=indices[a].get(ts)
        if i is None or feats[a].get(ts) is None:continue
        r24=xs.ret_at(bars[a],i,96); r72=xs.ret_at(bars[a],i,288); r12=xs.ret_at(bars[a],i,48)
        if r24 is None or r72 is None or r12 is None:continue
        vals.append((a,i,r12,r24,r72,r72-btc72))
    if len(vals)<12:return None
    r24s=[x[3] for x in vals]
    return {'bi':bi,'btc24':btc24,'btc72':btc72,'vals':vals,
            'neg_share':sum(x<0 for x in r24s)/len(r24s),'median24':statistics.median(r24s)}


def signal(c,ts,bars,feats,indices,end_ms,exclude=None):
    bf=feats['BTC'].get(ts)
    if bf is None or not xs.scheduled(ts,c['hold_h']):return None
    u=universe(ts,bars,feats,indices,exclude)
    if u is None:return None

    if c['lane']=='RANGE':
        if bf.regime!='RANGE':return None
        cr=xs.ret_at(bars['BTC'],u['bi'],c['cycle_h']*4)
        if cr is None:return None
        vals=sorted(u['vals'],key=lambda x:x[5]);lo,hi=vals[0],vals[-1]
        if cr>=0:
            if hi[5]<c['threshold']:return None
            return leg(c,hi[0],hi[1],'SHORT',bars,end_ms,hi[5])
        if lo[5]>-c['threshold']:return None
        return leg(c,lo[0],lo[1],'LONG',bars,end_ms,-lo[5])

    if bf.regime!='BEAR':return None
    if u['neg_share']<c['neg_share_min'] or u['median24']>c['median24_max']:return None
    if c['btc24_negative'] and u['btc24']>=0:return None
    vals=u['vals']; fam=c['family']; th=c['threshold']

    if fam=='REBOUND_FADE_BREADTH':
        x=max(vals,key=lambda z:z[4])
        if x[4]<th:return None
        return leg(c,x[0],x[1],'SHORT',bars,end_ms,x[4]+u['neg_share'])
    if fam=='RELSTRONG_FADE_BREADTH':
        x=max(vals,key=lambda z:z[5])
        if x[5]<th or x[4]<=0:return None
        return leg(c,x[0],x[1],'SHORT',bars,end_ms,x[5]+u['neg_share'])
    if fam=='WEAK_MOM_BREADTH':
        x=min(vals,key=lambda z:z[4])
        if x[4]>-th:return None
        return leg(c,x[0],x[1],'SHORT',bars,end_ms,-x[4]+u['neg_share'])
    if fam=='LEADER_FAIL_BREADTH':
        x=max(vals,key=lambda z:z[4])
        if x[4]<th or x[2]>=0:return None
        return leg(c,x[0],x[1],'SHORT',bars,end_ms,x[4]-x[2]+u['neg_share'])
    return None


def eval_c(c,s,e,bars,feats,indices,exclude=None):
    out=[]
    for ts in sorted(feats['BTC']):
        if s<=ts<e:
            t=signal(c,ts,bars,feats,indices,e,exclude)
            if t is not None:out.append(t)
    return out,xs.metrics(out)


def period(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end);_,m=eval_c(c,s,e,bars,feats,indices);span=e-s;qs=[]
    for j in range(4):
        a=s+(span*j)//4;b=s+(span*(j+1))//4;_,q=eval_c(c,a,b,bars,feats,indices);qs.append(q)
    return {'metrics':m,'quarters':qs,'positive_quarters':sum(q['stress_bps']>0 for q in qs)}


def basic(c,p23,p24,p25):
    m23,m24,m25=p23['metrics'],p24['metrics'],p25['metrics']
    min23=6; min24=16; min25=14
    return {
      'all_positive':all(m['stress_bps']>0 for m in (m23,m24,m25)),
      'pf':m23['stress_pf']>=1.03 and m24['stress_pf']>=1.08 and m25['stress_pf']>=1.08,
      'sample':m23['trades']>=min23 and m24['trades']>=min24 and m25['trades']>=min25 and m23['trades']+m24['trades']+m25['trades']>=42,
      'halves':all(m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0 for m in (m23,m24,m25)),
      'subwindows':p23['positive_quarters']>=2 and p24['positive_quarters']>=3 and p25['positive_quarters']>=3,
      'asset_share':m23['max_asset_exposure_share']<=.40 and m24['max_asset_exposure_share']<=.35 and m25['max_asset_exposure_share']<=.35,
    }


def loo(c,start,end,bars,feats,indices):
    s,e=base.ms(start),base.ms(end);ms=[]
    for a in xs.NON_BTC:
        _,m=eval_c(c,s,e,bars,feats,indices,a)
        if m['trades']>0:ms.append(m)
    return {'positive_share':round(sum(m['stress_bps']>0 for m in ms)/len(ms),4) if ms else 0,
            'median_mean_stress_bps':round(statistics.median([m['mean_stress_bps'] for m in ms]),3) if ms else 0}


def group_key(c):
    if c['lane']=='RANGE': return ('RANGE',c['family'])
    return ('BEAR',c['family'],c['btc24_negative'])


def main():
    b23=r3.load_period(r3.D23S,r3.D23E);f23,i23=base.build_features(b23)
    b24=r3.load_period(r3.D24S,r3.D24E);f24,i24=base.build_features(b24)
    b25=r3.load_period(r3.D25S,r3.D25E);f25,i25=base.build_features(b25)
    res={}
    for c in CANDS:
        p23=period(c,r3.D23S,r3.D23E,b23,f23,i23);p24=period(c,r3.D24S,r3.D24E,b24,f24,i24);p25=period(c,r3.D25S,r3.D25E,b25,f25,i25)
        g=basic(c,p23,p24,p25);res[c['key']]={'candidate':c,'p2023':p23,'p2024':p24,'p2025':p25,'gates':g,'basic_pass':all(g.values())}
    for r in res.values():
        if not r['basic_pass']:continue
        c=r['candidate'];l23=loo(c,r3.D23S,r3.D23E,b23,f23,i23);l24=loo(c,r3.D24S,r3.D24E,b24,f24,i24);l25=loo(c,r3.D25S,r3.D25E,b25,f25,i25)
        r['loo2023']=l23;r['loo2024']=l24;r['loo2025']=l25
        r['loo_pass']=l23['positive_share']>=.60 and l24['positive_share']>=.65 and l25['positive_share']>=.65 and min(l23['median_mean_stress_bps'],l24['median_mean_stress_bps'],l25['median_mean_stress_bps'])>0
    qual=[r for r in res.values() if r['basic_pass'] and r.get('loo_pass',False)]
    groups={}
    for r in qual: groups.setdefault(group_key(r['candidate']),[]).append(r['candidate'])
    selected={'RANGE':None,'BEAR':None}
    for lane in ('RANGE','BEAR'):
        arr=[]
        for r in qual:
            c=r['candidate']
            if c['lane']!=lane:continue
            peers=groups.get(group_key(c),[])
            if lane=='RANGE':
                plateau_ok=(len(peers)>=6 and len({x['cycle_h'] for x in peers})>=3 and len({x['threshold'] for x in peers})>=3)
            else:
                plateau_ok=(len(peers)>=4 and len({x['threshold'] for x in peers})>=2 and len({x['neg_share_min'] for x in peers})>=2 and len({x['median24_max'] for x in peers})>=2)
            r['plateau_pass']=plateau_ok
            if not plateau_ok:continue
            means=[r[x]['metrics']['mean_stress_bps'] for x in ('p2023','p2024','p2025')]
            pfs=[r[x]['metrics']['stress_pf'] for x in ('p2023','p2024','p2025')]
            arr.append((min(means),min(pfs),c['key']))
        if arr:
            arr.sort(reverse=True);selected[lane]=arr[0][2]
    out={'revision':'V10_R6_BREADTH_AND_RANGE_PLATEAU_20260830','test_accessed':False,
         'final_test_window_untouched':['2025-11-02T00:00:00+00:00','2026-01-01T00:00:00+00:00'],
         'candidate_count':len(CANDS),'selected':selected,'results':res}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R6_RESULT_BEGIN');print(json.dumps(out,ensure_ascii=False,sort_keys=True));print('V10_R6_RESULT_END')

if __name__=='__main__':main()
