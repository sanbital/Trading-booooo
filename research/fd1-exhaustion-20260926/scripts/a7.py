from axes import *
from collections import defaultdict
C=[r for r in R if r['cec']]
print('CEC coverage',len(C),'from',min(r['dec'] for r in C))
for h,lab in [(12,'12h'),(24,'24h'),(48,'48h'),(168,'7d'),(9999,'all')]:
    xs=[r for r in C if r['dec']>=NOW-h*3600e3]
    for a in ['ADMIT','PROBE','REJECT']:
        print(summ([r for r in xs if r['cec']==a],f'{lab} CEC {a}'))
# prediction value vs realized next outcome (rank correlation across time)
import statistics
xs=sorted([r for r in C if r['cecp'] is not None],key=lambda r:r['dec'])
print('corr(cec prediction, sim net) =',round(statistics.correlation([r['cecp'] for r in xs],[r['net'] for r in xs]),3))
# by prediction bins
for lo,hi in [(-99,-4),(-4,-3),(-3,-2),(-2,-1),(-1,0),(0,99)]:
    print(summ([r for r in xs if lo<=r['cecp']<hi],f'cec pred [{lo},{hi})'))
# daily: cec mean prediction vs day mean outcome
d=defaultdict(list)
for r in xs: d[(r['dec']//(6*3600e3))].append(r)
print('6h buckets: mean pred vs mean net')
for k in sorted(d): print(f"  {int(k)} n={len(d[k]):3d} pred={st.mean(r['cecp'] for r in d[k]):6.2f} net={st.mean(r['net'] for r in d[k]):6.2f} reject%={sum(r['cec']=='REJECT' for r in d[k])/len(d[k]):.0%}")
