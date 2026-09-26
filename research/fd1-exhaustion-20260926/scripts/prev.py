import json
from axes import *
K=json.load(open('data/k1.json'));MIN=60000;idx={s:{r[0]:i for i,r in enumerate(v)} for s,v in K.items()}
P=[p for p in json.load(open('data/positions.json')) if p['strat']=='LEADER_MOMENTUM_V17' and p['out']]
bys={}
for p in P: bys.setdefault(p['sym'],[]).append(p)
def hi(s,a,b):
    m=idx.get(s,{});xs=[K[s][m[t]][2] for t in range(a//MIN*MIN,b//MIN*MIN+1,MIN) if t in m];return max(xs) if xs else None
for r in R:
    dec=r['dec'];ps=sorted([p for p in bys.get(r['sym'],[]) if p['out']<dec],key=lambda p:-p['out'])
    if not ps or (dec-ps[0]['out'])>240*MIN: r['prev2']=None;continue
    p=ps[0];pk=hi(r['sym'],p['in'],p['out']) or p['pk'];since=hi(r['sym'],p['out']+MIN,dec-MIN)
    r['prev2']={'min':(dec-p['out'])/MIN,'pnl':p['pnl'],'mfe':p['pk']/p['ep']-1,'peak':pk,'px_vs_peak':r['entryPx']/pk-1,'px_vs_exit':r['entryPx']/p['xp']-1,
      'new_high':since is not None and since>pk*1.001,'n24':sum(1 for q in bys[r['sym']] if dec-24*3600e3<=q['in']<dec),'why':p['why']}
json.dump({r['sid']:r['prev2'] for r in R},open('data/prev2.json','w'))
from collections import defaultdict
d=defaultdict(list)
for r in R:
    p=r['prev2']
    k='none' if not p else f"{'WIN ' if p['pnl']>0 else 'LOSS'} {'newHigh' if p['new_high'] else 'noNewHigh'}{' lowMFE' if p['mfe']<.005 else ''}"
    d[k].append(r)
for k in sorted(d):
    xs=d[k];print(summ(xs,k),'| legacy avg',round(st.mean([x['net'] for x in xs if x['path']=='LEGACY'] or [0]),2),'cur avg',round(st.mean([x['net'] for x in xs if x['path']!='LEGACY'] or [0]),2), 'nCur',sum(x['path']!='LEGACY' for x in xs))
g=[r for r in R if r['sym']=='GRASSUSDT' and r['prev2'] and r['dec']>1790350000000]
for r in g: print(r['prev2'],r['net'])
