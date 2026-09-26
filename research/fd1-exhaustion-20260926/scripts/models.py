from axes import *
import json
PV=json.load(open('data/prev2.json'))
for r in R: r['prev2']=PV[r['sid']]
WIN=[(12,'12h'),(24,'24h'),(48,'48h'),(168,'7d'),(9999,'30d(all)')]
def evaluate(keep,label):
    rows=[]
    for h,nm in WIN:
        base=[r for r in R if r['dec']>=NOW-h*3600e3]; k=[r for r in base if keep(r)]; drop=[r for r in base if not keep(r)]
        bn=sum(r['net'] for r in base); kn=sum(r['net'] for r in k)
        pl=sum(1 for r in drop if r['net']<=0); mw=sum(1 for r in drop if r['net']>0); mwbig=sum(1 for r in drop if r['net']>4.5)
        rows.append(f"{nm}: n {len(base)}->{len(k)} net {bn:.0f}->{kn:.0f} (Δ{kn-bn:+.0f}) avg {bn/len(base):.2f}->{(kn/len(k) if k else 0):.2f} prevLos={pl} missWin={mw}(>{'+1%'}:{mwbig})")
    print('==',label);[print('   ',x) for x in rows]
p2=lambda r:r['prev2']
evaluate(lambda r:True,'CURRENT (all candidates)')
evaluate(lambda r:not(p2(r) and p2(r)['min']<30),'A hard cooldown 30m after exit')
evaluate(lambda r:not(p2(r) and p2(r)['min']<30 and not p2(r)['new_high']),'B cooldown 30m unless new high since exit')
evaluate(lambda r:not(p2(r) and p2(r)['min']<60 and not p2(r)['new_high']),'B2 60m unless new high')
evaluate(lambda r:r['nax']<2,'EXH bound: skip if >=2 weak axes')
evaluate(lambda r:r['nax']<3,'EXH bound: skip if >=3 weak axes')
evaluate(lambda r:not(r['ax']['PRICE'] and r['ax']['FLOW']),'EXH bound: skip if PRICE&FLOW weak')
evaluate(lambda r:not(r['nax']>=2 and r['cecp'] is not None and r['cecp']<0),'E bound: >=2 axes AND CEC negative')
