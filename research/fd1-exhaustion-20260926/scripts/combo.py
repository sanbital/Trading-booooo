from models import *
import itertools
A=[r for r in R if r['path']=='LEGACY'];B=[r for r in R if r['path']!='LEGACY']
ax=['PRICE','FLOW','PARTICIPATION','DERIVATIVES']
def s(xs): return f"n={len(xs):4d} avg={st.mean([x['net'] for x in xs]) if xs else 0:6.2f} lowMFE={sum(x['lowmfe'] for x in xs)/max(1,len(xs)):.0%}"
base=lambda xs:st.mean(x['net'] for x in xs)
print('baseline LEG',round(base(A),2),'CUR',round(base(B),2))
for a,b in itertools.combinations(ax,2):
    f=lambda xs:[x for x in xs if x['ax'][a] and x['ax'][b]]
    print(f"{a}+{b:14s} LEG {s(f(A))} | CUR {s(f(B))}")
# PRICE weak variants
for nm,fn in [('both accel<0',lambda r:(r['v']['accel_5m_vs_15m'] or 0)<0 and (r['v']['accel_15m_vs_60m'] or 0)<0),
              ('noHigh>=10 & dh<=-.5%',lambda r:(r['v']['minutes_since_high_60m'] or 0)>=10 and (r['v']['distance_high_60m'] or 0)<=-.005),
              ('PRICE & vol<.8',lambda r:r['ax']['PRICE'] and r['ax']['PARTICIPATION'])]:
    print(f"{nm:24s} LEG {s([x for x in A if fn(x)])} | CUR {s([x for x in B if fn(x)])}")
