from axes import *
import json
K=json.load(open('data/k1.json'));MIN=60000
idx={s:{r[0]:i for i,r in enumerate(v)} for s,v in K.items()}
def fw(r,n=130):
    s=r['sym'];t0=(r['dec']+2000)//MIN*MIN;i=idx[s].get(t0);return K[s][i:i+n]
# H1: after a STOP exit, how often did price later exceed entry by +2% within 60 min of entry?
stops=[r for r in R if r['sim']['why']=='STOP']
rec=0;rec1=0
for r in stops:
    b=fw(r);e=r['entryPx'];m=r['sim']['exitMin']
    later=max(x[2] for x in b[m:60]) if m<60 else 0
    if later>=e*1.02: rec+=1
    if later>=e*1.01: rec1+=1
print(f"STOP exits {len(stops)}; later >= +2% within 60m: {rec/len(stops):.1%}; >= +1%: {rec1/len(stops):.1%}")
# exit variants on identical entries (diagnostic only, sizing unchanged)
def sim(e,bars,stop0=.025,rc=.012,rcArm=.01,rcMin=10,lock=True,trail=True,H=120):
    peak=e;lh=0;stop=e*(1-stop0);mfe=0
    for i,(t,o,h,l,c,q,tb) in enumerate(bars[:H]):
        if l<=stop: return min(o,stop)/e-1
        if h>peak: peak=h;lh=i
        mfe=max(mfe,peak/e-1);lv=[e*(1-stop0)]
        if rc and (mfe>=rcArm or i+1>=rcMin): lv.append(e*(1-rc))
        if lock and mfe>=.02: lv.append(e+(peak-e)*.5)
        if trail and mfe>=.03: lv.append(peak*.985)
        stop=max(stop,*lv)
        if i-lh>=45: return c/e-1
    return bars[min(len(bars),H)-1][4]/e-1
V={'LIVE R5':{}, 'no risk cut (-2.5% only)':{'rc':0}, 'risk cut -1.8%':{'rc':.018},'risk cut after 20m':{'rcMin':20}}
for pop,nm in [([r for r in R if r['path']=='LEGACY'],'LEGACY'),([r for r in R if r['path']!='LEGACY'],'CURRENT')]:
    for k,kw in V.items():
        n=[450*(sim(r['entryPx'],fw(r),**kw)-.001) for r in pop]
        w=[x for x in n if x>0];l=[x for x in n if x<=0]
        print(f"{nm:8s}{k:28s} avg={st.mean(n):6.2f} PF={sum(w)/-sum(l):.2f} maxLoss={min(n):.2f}")
