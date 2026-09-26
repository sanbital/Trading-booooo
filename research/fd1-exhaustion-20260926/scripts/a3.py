from lib import *
import itertools
A=[r for r in R if r['path']=='LEGACY'];B=[r for r in R if r['path']!='LEGACY']
# correlation among candidate weakness signals (redundancy check)
def g(r,k): return r['v'].get(k)
sig={
 'accel5<0':lambda r:g(r,'accel_5m_vs_15m') is not None and g(r,'accel_5m_vs_15m')<0,
 'accel15_60<0':lambda r:g(r,'accel_15m_vs_60m') is not None and g(r,'accel_15m_vs_60m')<0,
 'noHigh>=10m':lambda r:(g(r,'minutes_since_high_60m') or 0)>=10,
 'dHigh<=-1%':lambda r:(g(r,'distance_high_60m') or 0)<=-.01,
 'ret5<=.2%':lambda r:(g(r,'return_5m') or 0)<=.002,
 'taker5<.5':lambda r:g(r,'taker_buy_ratio_5m') is not None and g(r,'taker_buy_ratio_5m')<.5,
 'bsc<0':lambda r:g(r,'buyer_share_change') is not None and g(r,'buyer_share_change')<0,
 'vol<.8':lambda r:g(r,'volume_ratio_5m_vs_60m') is not None and g(r,'volume_ratio_5m_vs_60m')<.8,
 'oi5<0':lambda r:g(r,'oi_change_5m') is not None and g(r,'oi_change_5m')<0,
}
names=list(sig);M={n:[sig[n](r) for r in R] for n in names}
def phi(a,b):
    n11=sum(x and y for x,y in zip(a,b));n1=sum(a);n2=sum(b);N=len(a)
    import math
    d=math.sqrt(n1*(N-n1)*n2*(N-n2));return (N*n11-n1*n2)/d if d else 0
print('phi correlation (|phi|>=.3 marked *)')
print(' '*14+''.join(f'{n[:9]:>10}' for n in names))
for a in names: print(f'{a:14s}'+''.join(f"{phi(M[a],M[b]):9.2f}{'*' if abs(phi(M[a],M[b]))>=.3 and a!=b else ' '}" for b in names))
for n in names:
    s=lambda xs:f"n={sum(sig[n](x) for x in xs):4d} avg={st.mean([x['net'] for x in xs if sig[n](x)] or [0]):6.2f} vs {st.mean([x['net'] for x in xs if not sig[n](x)] or [0]):6.2f}"
    print(f'{n:14s} LEGACY {s(A)} | CURRENT {s(B)}')
