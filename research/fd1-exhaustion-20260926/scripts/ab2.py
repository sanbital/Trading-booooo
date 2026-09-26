import json,random,statistics as st
exec(open('ab.py').read().split("W=[(12")[0])
from collections import Counter
random.seed(7)
for grp in ['CUR','LEG']:
    pop=[r for r in rows if (r['path']!='LEGACY')==(grp=='CUR')]
    B=[r for r in pop if taken(r,'base')];kept=[r for r in B if taken(r,'new')];k=len(kept)
    obs=st.mean(r['net'] for r in kept)
    sims=[st.mean(x['net'] for x in random.sample(B,k)) for _ in range(20000)]
    p=sum(s>=obs for s in sims)/len(sims)
    print(f"{grp}: BASE BUY n={len(B)} avg={st.mean(r['net'] for r in B):.2f}; NEW kept {k} avg={obs:.2f}; random-skip null mean={st.mean(sims):.2f} sd={st.pstdev(sims):.2f}; one-sided p={p:.3f}")
    lm=lambda xs:sum(r['lowmfe'] for r in xs)/len(xs)
    print(f"   lowMFE share BASE {lm(B):.1%} -> NEW {lm([r for r in pop if taken(r,'new')]):.1%}; BUY rate BASE {len(B)/len(pop):.0%} NEW {sum(taken(r,'new') for r in pop)/len(pop):.0%}")
    sk=Counter(tuple(sorted(r['ab']['new']['reasons'] or [])) for r in pop if r['ab']['new']['decision']=='SKIP');print('   NEW SKIP reasons',sk.most_common(8))
    skb=Counter(tuple(sorted(r['ab']['base']['reasons'] or [])) for r in pop if r['ab']['base']['decision']=='SKIP');print('   BASE SKIP reasons',skb.most_common(5))
    print('   invalid/ABSTAIN BASE',sum(r['ab']['base']['decision']=='ABSTAIN' for r in pop),'NEW',sum(r['ab']['new']['decision']=='ABSTAIN' for r in pop))
    # by skip reason: outcomes of BASE-BUY candidates that NEW skipped
    for key in ['EXHAUSTION','REENTRY_NO_NEW_IMPULSE','EV_UNFAVORABLE']:
        xs=[r for r in B if not taken(r,'new') and key in (r['ab']['new']['reasons'] or [])]
        if xs: print(f"   skipped via {key}: n={len(xs)} avg={st.mean(r['net'] for r in xs):.2f} winners={sum(r['net']>0 for r in xs)}")
# controls & live 12h trades
P={p['pid']:p for p in json.load(open('data/positions.json'))}
print('\nlive 12h trades: symbol pnl  BASE  NEW (reasons)')
for r in sorted([r for r in rows if r['pos'] and r['dec']>=1790340060000],key=lambda r:r['dec']):
    print(f"  {r['sym']:10s} {P[r['pos']]['pnl'] if r['pos'] in P else None!s:>8.8} {r['ab']['base']['decision']:7s} {r['ab']['new']['decision']:7s} {r['ab']['new']['reasons']}")
