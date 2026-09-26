from lib import *
def g(r,k):
    v=r['v'].get(k)
    if v is None and r.get('gptFacts'): v=r['gptFacts'].get(k)
    return v
def axes(r):
    a={}
    a5,a15=g(r,'accel_5m_vs_15m'),g(r,'accel_15m_vs_60m');msh,dh=g(r,'minutes_since_high_60m'),g(r,'distance_high_60m')
    a['PRICE']=(a5 is not None and a15 is not None and a5<0 and a15<0) or (msh is not None and dh is not None and msh>=10 and dh<=-.005)
    t5,b=g(r,'taker_buy_ratio_5m'),g(r,'buyer_share_change');a['FLOW']=t5 is not None and b is not None and t5<.5 and b<0
    vr=g(r,'volume_ratio_5m_vs_60m');a['PARTICIPATION']=vr is not None and vr<.8
    oi=g(r,'oi_change_5m');a['DERIVATIVES']=oi is not None and oi<0
    im=(r.get('gptFacts') or {}).get('book_imbalance_25bps');a['BOOK']=im is not None and im<=-.2
    return a
for r in R: r['ax']=axes(r); r['nax']=sum(r['ax'].values())
if __name__=='__main__':
    A=[r for r in R if r['path']=='LEGACY'];B=[r for r in R if r['path']!='LEGACY']
    for k in range(0,5):
        f=lambda xs:[x for x in xs if (x['nax']>=k if k==3 else x['nax']==k)]
        print(summ(f(A),f'LEGACY  axes={k}{"+" if k==3 else ""}'));print(summ(f(B),f'CURRENT axes={k}{"+" if k==3 else ""}'))
    print()
    for ax in ['PRICE','FLOW','PARTICIPATION','DERIVATIVES']:
        for pop,nm in [(A,'LEG'),(B,'CUR')]:
            w=[x for x in pop if x['ax'][ax]];o=[x for x in pop if not x['ax'][ax]]
            print(f"{ax:14s}{nm} weak n={len(w)} avg={st.mean(x['net'] for x in w):.2f} | ok avg={st.mean(x['net'] for x in o):.2f}")
