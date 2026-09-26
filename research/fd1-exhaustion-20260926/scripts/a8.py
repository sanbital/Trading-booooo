from axes import *
import json
P={p['pid']:p for p in json.load(open('data/positions.json'))}
# GPT selectivity in FD1 era
F=[r for r in R if r['gpt']]
print('FD1 ENTRY decisions',len(F),{d:sum(r['gpt']==d for r in F) for d in ['BUY','SKIP','ABSTAIN']})
print(summ([r for r in F if r['gpt']=='BUY'],'GPT BUY'));print(summ([r for r in F if r['gpt']!='BUY'],'GPT not BUY'))
sup=[len(r['gptAns']['support']) for r in F if r['gptAns'] and r['gpt']=='BUY']
trendOnly=sum(1 for r in F if r['gptAns'] and r['gpt']=='BUY' and all(e['key'].startswith('return_') for e in r['gptAns']['support']))
print('BUY with support made ONLY of return_* facts:',trendOnly,'/',len(sup))
print('BUY confidence mean',st.mean(r['gptAns']['confidence'] for r in F if r['gpt']=='BUY' and r['gptAns'] and 'confidence' in r['gptAns']),'ev POSITIVE share',sum(r['gptAns'].get('expected_value_bias')=='POSITIVE' for r in F if r['gpt']=='BUY' and r['gptAns'])/len(sup))
print('BUY risk_soft non-empty:',sum(1 for r in F if r['gpt']=='BUY' and r['gptAns'] and r['gptAns'].get('risk_soft')),'/',len(sup))
# how often any SOFT band fires for any candidate in FD1 era
print('any candidate with risk_soft:',sum(1 for r in F if r['gptAns'] and r['gptAns'].get('risk_soft')),'/',sum(1 for r in F if r['gptAns']))
# H2 regime: 12h window vs rest of FD1 era for ALL candidates
w12=[r for r in R if r['dec']>=NOW-12*3600e3];pre=[r for r in R if NOW-7*24*3600e3<=r['dec']<NOW-12*3600e3]
print(summ(w12,'ALL candidates 12h'));print(summ(pre,'ALL candidates prior 6.5d'))
print('12h: BUY vs all', st.mean(r['net'] for r in w12 if r['gpt']=='BUY'), st.mean(r['net'] for r in w12))
# H3 execution drift for traded 12h
for r in sorted([r for r in R if r['pos'] and P.get(r['pos']) and P[r['pos']]['in']>=1790350000000],key=lambda r:r['dec']):
    p=P[r['pos']];print(f"  {r['sym']:10s} fill vs last close {1e4*(p['ep']/r['entryPx']-1):6.1f}bps  decision->fill {(p['in']-r['dec'])/1000:5.1f}s  rechecks={r['rechecks']}")
