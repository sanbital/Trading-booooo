from axes import *
A=[r for r in R if r['path']=='LEGACY'];B=[r for r in R if r['path']!='LEGACY']
def cat(r):
    p=r['prev']
    if not p or p['min_since_exit']>240: return 'no recent same-symbol trade (4h)'
    w='prevWIN' if p['pnl']>0 else 'prevLOSS'
    nh='newHigh' if p['new_high_since_exit'] else 'noNewHigh'
    return f"{w} {nh}"
from collections import defaultdict
for pop,nm in [(A,'LEGACY'),(B,'CURRENT'),(R,'ALL')]:
    d=defaultdict(list)
    for r in pop: d[cat(r)].append(r)
    print('--',nm)
    for k in sorted(d): print(summ(d[k],k))
print()
# within 60 min of previous exit
for lim in [30,60,120]:
    xs=[r for r in R if r['prev'] and r['prev']['min_since_exit']<=lim]
    print(summ(xs,f'prev exit <= {lim}m'))
    print(summ([r for r in xs if not r['prev']['new_high_since_exit']],f'  .. no new high since exit'))
    print(summ([r for r in xs if r['prev']['new_high_since_exit']],f'  .. new high since exit'))
    print(summ([r for r in xs if r['prev']['mfe']<.005],f'  .. prev low-MFE(<0.5%)'))
