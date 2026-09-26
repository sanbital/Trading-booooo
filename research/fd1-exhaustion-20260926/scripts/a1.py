from lib import *
from collections import Counter
print(Counter(r['path'] for r in R))
trig=[r for r in R if r['path']!='LEGACY']
print(summ(trig,'all triggered'))
print(summ([r for r in R if r['path']=='LEGACY'],'legacy (09-02..09-16)'))
print(summ([r for r in R if r['gpt']=='BUY'],'GPT BUY (initial)'))
print(summ([r for r in R if r['gpt']=='SKIP'],'GPT SKIP'))
print(summ([r for r in R if r['gpt']=='ABSTAIN'],'GPT ABSTAIN'))
print(summ([r for r in R if r['pos']],'filled (sim)'))
for h in [12,24,48,168,24*30]:
    print(summ([r for r in period(h) if r['path']!='LEGACY' or h>168],f'triggered last {h}h'))
