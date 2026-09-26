import json,sys,statistics as st
from models import R,NOW
ab=json.load(open('data/ab.json'))
D={}
for x in ab:
    arm,sid=x['id'].split(':',1); D.setdefault(sid,{})[arm]=x
byid={r['sid']:r for r in R}
rows=[]
for sid,d in D.items():
    if sid in byid and 'base' in d and 'new' in d: r=byid[sid]; r['ab']=d; rows.append(r)
print('paired',len(rows))
def taken(r,arm): return r['ab'][arm]['decision']=='BUY'
def stats(xs):
    if not xs: return dict(n=0)
    n=[x['net'] for x in xs];w=[v for v in n if v>0];l=[v for v in n if v<=0]
    eq=0;pk=0;dd=0
    for x in sorted(xs,key=lambda r:r['dec']): eq+=x['net'];pk=max(pk,eq);dd=min(dd,eq-pk)
    return dict(n=len(xs),win=len(w)/len(xs),net=sum(n),gross=sum(n)+450*0.001*len(xs),pf=(sum(w)/-sum(l) if sum(l)<0 else 99),avg=st.mean(n),
      avgW=st.mean(w) if w else 0,avgL=st.mean(l) if l else 0,maxL=min(n),dd=dd,mfe=st.mean(x['mfe60'] for x in xs),mae=st.mean(x['mae60'] for x in xs),low=sum(x['lowmfe'] for x in xs))
def fmt(s): return 'n=0' if not s['n'] else f"n={s['n']:3d} win={s['win']:.0%} gross={s['gross']:7.1f} net={s['net']:7.1f} PF={s['pf']:.2f} avg={s['avg']:5.2f} avgW={s['avgW']:5.2f} avgL={s['avgL']:5.2f} maxL={s['maxL']:6.2f} DD={s['dd']:6.1f} MFE={s['mfe']:.4f} MAE={s['mae']:.4f} lowMFE={s['low']}"
W=[(12,'12h'),(24,'24h'),(48,'48h'),(168,'7d'),(9999,'all(CUR 09-17..)')]
for grp in ['CUR','LEG']:
    print('\n########',grp)
    pop=[r for r in rows if (r['path']!='LEGACY')==(grp=='CUR')]
    for h,nm in (W if grp=='CUR' else [(9999,'legacy sample 09-02..09-16')]):
        xs=[r for r in pop if r['dec']>=NOW-h*3600e3]
        b=[r for r in xs if taken(r,'base')];n=[r for r in xs if taken(r,'new')]
        print(f'-- {nm}: candidates={len(xs)}');print('   ALL cand ',fmt(stats(xs)));print('   BASE BUY ',fmt(stats(b)));print('   NEW  BUY ',fmt(stats(n)))
        prevented=[r for r in b if not taken(r,'new')];added=[r for r in n if not taken(r,'base')]
        print(f"   NEW vs BASE: prevented losers={sum(r['net']<=0 for r in prevented)} (sum {sum(r['net'] for r in prevented if r['net']<=0):.1f}), missed winners={sum(r['net']>0 for r in prevented)} (sum {sum(r['net'] for r in prevented if r['net']>0):.1f}); added={len(added)} (net {sum(r['net'] for r in added):.1f})")
        for lab,f in [('first-entry',lambda r:not r['prev2']),('re-entry',lambda r:bool(r['prev2'])),('lowMFE-fail',lambda r:r['lowmfe'])]:
            print(f"   {lab:12s} BASE {fmt(stats([r for r in b if f(r)]))}\n   {'':12s} NEW  {fmt(stats([r for r in n if f(r)]))}")
