#!/usr/bin/env python3
"""V10 R5: three-period tactical validation, final TEST remains sealed.

2023-09..2023-12, full 2024, and 2025-01..2025-10-08 are all treated as
research/validation periods. Candidates must survive every period, true leave-one-asset-out,
and a local parameter plateau before they can be locked for the untouched final TEST.
"""
from __future__ import annotations
import json, statistics
from pathlib import Path

import run as base
import run_xs as xs
import run_r3 as r3

HERE=Path(__file__).resolve().parent; OUT=HERE/'r5-result.json'
base.CACHE=Path('v10-cache-r3'); r3.base.CACHE=base.CACHE
CANDS=[]
def add(**c): c['key']='R5_'+c['lane']+'_'+c['family']+'_'+str(len(CANDS)).zfill(4); CANDS.append(c)

# RANGE local robustness surface around the R4 winner: 72h residual, 24h hold.
for cycle in (8,12,16,24,36,48):
  for th in (.04,.045,.05,.055,.06):
    for sign_req in (False,True):
      add(lane='RANGE',family='CYCLE_RESID_MR',lookback_h=72,cycle_h=cycle,threshold=th,sign_req=sign_req,hold_h=24)

# BEAR_REBREAK: separate bearish continuation from bearish rebound.
for look in (48,72,96):
  for th in (.02,.025,.03,.035,.04):
    for btc_h in (12,24,48):
      for fail_h in (0,6,12,24):
        add(lane='BEAR',family='REBREAK_REBOUND_FADE',lookback_h=look,threshold=th,btc_h=btc_h,asset_fail_h=fail_h,hold_h=24)
# Direct index rebreak lane.
for asset in ('BTC','ETH'):
  for fast_h in (12,24,48):
    for hold in (24,48):
      add(lane='BEAR',family='INDEX_REBREAK',asset=asset,fast_h=fast_h,slow_h=72,hold_h=hold)
# Relative-strength rebound failure under a BTC rebreak.
for th in (.01,.02,.03):
  for btc_h in (12,24,48):
    for fail_h in (0,12):
      add(lane='BEAR',family='RELSTRONG_REBREAK',lookback_h=72,threshold=th,btc_h=btc_h,asset_fail_h=fail_h,hold_h=24)


def leg(c,a,i,side,bars,end_ms,score):
    p=xs.leg_pnl(bars[a],i,c['hold_h'],side,end_ms)
    if p is None:return None
    return xs.XTrade(c['key'],c['lane'],p[3],p[4],p[2],p[1],p[0],((a,side,p[2]),),score)


def signal(c,ts,bars,feats,indices,end_ms,exclude=None):
    bf=feats['BTC'].get(ts)
    if bf is None or not xs.scheduled(ts,c['hold_h']):return None
    if c['lane']=='RANGE':
        if bf.regime!='RANGE':return None
    else:
        if bf.regime!='BEAR':return None
    bi=indices['BTC'].get(ts)
    if bi is None:return None

    if c['family']=='INDEX_REBREAK':
        fast=xs.ret_at(bars['BTC'],bi,c['fast_h']*4); slow=xs.ret_at(bars['BTC'],bi,c['slow_h']*4)
        if fast is None or slow is None or fast>=0 or slow>=0:return None
        a=c['asset']; i=indices[a].get(ts)
        if i is None:return None
        return leg(c,a,i,'SHORT',bars,end_ms,-fast-slow)

    look=c['lookback_h']*4; br=xs.ret_at(bars['BTC'],bi,look)
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
        vals.sort(key=lambda x:x[0]);lo,hi=vals[0],vals[-1]
        if cr>=0:
            if hi[0]<c['threshold'] or (c['sign_req'] and hi[1]<=0):return None
            return leg(c,hi[2],hi[3],'SHORT',bars,end_ms,hi[0])
        if lo[0]>-c['threshold'] or (c['sign_req'] and lo[1]>=0):return None
        return leg(c,lo[2],lo[3],'LONG',bars,end_ms,-lo[0])

    btc_fast=xs.ret_at(bars['BTC'],bi,c['btc_h']*4)
    if btc_fast is None or btc_fast>=0:return None
    if c['family']=='REBREAK_REBOUND_FADE':
        vals.sort(key=lambda x:x[1]); top=vals[-1]
        if top[1]<c['threshold']:return None
    else:
        vals.sort(key=lambda x:x[0]); top=vals[-1]
        if top[0]<c['threshold'] or top[1]<=0:return None
    fh=c['asset_fail_h']
    if fh:
        ar=xs.ret_at(bars[top[2]],top[3],fh*4)
        if ar is None or ar>=0:return None
    return leg(c,top[2],top[3],'SHORT',bars,end_ms,abs(top[1])+abs(btc_fast))


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
    fixed=c['family']=='INDEX_REBREAK'
    return {
      'all_positive':all(m['stress_bps']>0 for m in (m23,m24,m25)),
      'pf':m23['stress_pf']>=1.03 and m24['stress_pf']>=1.08 and m25['stress_pf']>=1.08,
      'sample':m23['trades']>=6 and m24['trades']>=16 and m25['trades']>=14 and m23['trades']+m24['trades']+m25['trades']>=42,
      'halves':all(m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0 for m in (m23,m24,m25)),
      'subwindows':p23['positive_quarters']>=2 and p24['positive_quarters']>=3 and p25['positive_quarters']>=3,
      'asset_share':fixed or (m23['max_asset_exposure_share']<=.40 and m24['max_asset_exposure_share']<=.35 and m25['max_asset_exposure_share']<=.35),
    }


def loo(c,start,end,bars,feats,indices):
    if c['family']=='INDEX_REBREAK':return {'applicable':False,'positive_share':1.0,'median_mean_stress_bps':999.0}
    s,e=base.ms(start),base.ms(end);ms=[]
    for a in xs.NON_BTC:
        _,m=eval_c(c,s,e,bars,feats,indices,a)
        if m['trades']>0:ms.append(m)
    return {'applicable':True,'positive_share':round(sum(m['stress_bps']>0 for m in ms)/len(ms),4) if ms else 0,
            'median_mean_stress_bps':round(statistics.median([m['mean_stress_bps'] for m in ms]),3) if ms else 0}


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
        r['loo_pass']=(not l23['applicable']) or (l23['positive_share']>=.60 and l24['positive_share']>=.65 and l25['positive_share']>=.65 and min(l23['median_mean_stress_bps'],l24['median_mean_stress_bps'],l25['median_mean_stress_bps'])>0)
    qual=[r for r in res.values() if r['basic_pass'] and r.get('loo_pass',False)]
    groups={}
    for r in qual:
        c=r['candidate']
        if c['family']=='CYCLE_RESID_MR':key=('RANGE',c['sign_req'])
        elif c['family']=='REBREAK_REBOUND_FADE':key=('BEAR',c['family'],c['lookback_h'],c['asset_fail_h'])
        elif c['family']=='RELSTRONG_REBREAK':key=('BEAR',c['family'],c['asset_fail_h'])
        else:key=('BEAR',c['family'],c['asset'])
        groups.setdefault(key,[]).append(c)
    selected={'RANGE':None,'BEAR':None}
    for lane in ('RANGE','BEAR'):
        arr=[]
        for r in qual:
            c=r['candidate']
            if c['lane']!=lane:continue
            if c['family']=='CYCLE_RESID_MR':
                peers=groups.get(('RANGE',c['sign_req']),[]);ok=len(peers)>=5 and len({x['threshold'] for x in peers})>=2 and len({x['cycle_h'] for x in peers})>=2
            elif c['family']=='REBREAK_REBOUND_FADE':
                peers=groups.get(('BEAR',c['family'],c['lookback_h'],c['asset_fail_h']),[]);ok=len(peers)>=3 and len({x['threshold'] for x in peers})>=2 and len({x['btc_h'] for x in peers})>=2
            elif c['family']=='RELSTRONG_REBREAK':
                peers=groups.get(('BEAR',c['family'],c['asset_fail_h']),[]);ok=len(peers)>=3 and len({x['threshold'] for x in peers})>=2 and len({x['btc_h'] for x in peers})>=2
            else:
                peers=groups.get(('BEAR',c['family'],c['asset']),[]);ok=len(peers)>=2
            r['plateau_pass']=ok
            if not ok:continue
            means=[r[x]['metrics']['mean_stress_bps'] for x in ('p2023','p2024','p2025')];pfs=[r[x]['metrics']['stress_pf'] for x in ('p2023','p2024','p2025')]
            arr.append((min(means),min(pfs),c['key']))
        if arr:arr.sort(reverse=True);selected[lane]=arr[0][2]
    out={'revision':'V10_R5_THREE_PERIOD_20260830','test_accessed':False,'final_test_window_untouched':['2025-11-02T00:00:00+00:00','2026-01-01T00:00:00+00:00'],
         'periods':[r3.D23S.isoformat(),r3.D23E.isoformat(),r3.D24S.isoformat(),r3.D24E.isoformat(),r3.D25S.isoformat(),r3.D25E.isoformat()],
         'candidate_count':len(CANDS),'selected':selected,'results':res}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R5_RESULT_BEGIN');print(json.dumps(out,ensure_ascii=False,sort_keys=True));print('V10_R5_RESULT_END')

if __name__=='__main__':main()
