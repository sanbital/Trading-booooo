from lib import *
A=[r for r in R if r['path']=='LEGACY'];B=[r for r in R if r['path']!='LEGACY']
def buck(k,edges):
    print('==',k)
    for lo,hi in zip(edges[:-1],edges[1:]):
        f=lambda xs:[x for x in xs if x['v'].get(k) is not None and lo<=x['v'][k]<hi]
        a,b=f(A),f(B)
        s=lambda xs:(f"n={len(xs):4d} avg={st.mean(x['net'] for x in xs):6.2f} lowMFE={sum(x['lowmfe'] for x in xs)/len(xs):5.1%} win={sum(x['win'] for x in xs)/len(xs):5.1%}" if xs else 'n=0')
        print(f"  [{lo:>8},{hi:>8})  LEGACY {s(a)} | CURRENT {s(b)}")
I=float('inf')
buck('taker_buy_ratio_5m',[-I,.45,.5,.55,.6,.65,I])
buck('buyer_share_change',[-I,-.08,-.03,0,.05,.1,I])
buck('accel_5m_vs_15m',[-I,-.005,-.002,0,.002,.005,I])
buck('accel_15m_vs_60m',[-I,-.005,0,.005,.01,I])
buck('minutes_since_high_60m',[-I,1,3,6,10,20,I])
buck('distance_high_60m',[-I,-.02,-.01,-.005,-.002,I])
buck('volume_ratio_5m_vs_60m',[-I,.6,.8,1,1.5,2.5,I])
buck('oi_change_5m',[-I,-.005,0,.005,.01,I])
buck('return_5m',[-I,0,.003,.006,.01,.02,I])
buck('return_60m',[-I,.02,.04,.06,.1,I])
buck('return_4h',[-I,.05,.1,.15,.25,I])
buck('day_return',[-I,.05,.1,.15,.25,I])
buck('return_1m',[-I,0,.002,.005,I])
buck('distance_sma20',[-I,0,.005,.01,.02,I])
