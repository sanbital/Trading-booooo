import json,statistics as st
R=json.load(open('data/replay.json'))
NOT=450;FEE=0.001
for r in R:
    r['net']=NOT*(r['sim']['ret']-FEE); r['win']=r['net']>0; r['lowmfe']=r['mfe60']<0.005
    r['t']=r['dec']
NOW=1790393400000  # 2026-09-26 03:30Z
def period(h): return [r for r in R if r['dec']>=NOW-h*3600e3]
def summ(xs,label=''):
    if not xs: return f'{label:28s} n=0'
    n=[x['net'] for x in xs];w=[v for v in n if v>0];l=[v for v in n if v<=0]
    pf=sum(w)/-sum(l) if l and sum(l)<0 else float('inf')
    return f"{label:28s} n={len(xs):4d} win={len(w)/len(xs):5.1%} net={sum(n):8.1f} avg={st.mean(n):6.2f} PF={pf:5.2f} mfe60={st.mean(x['mfe60'] for x in xs):.4f} lowMFE={sum(x['lowmfe'] for x in xs)/len(xs):.1%}"
