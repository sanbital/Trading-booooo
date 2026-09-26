from models import *
import json
J={j['sid']:j for j in json.load(open('data/journal.json'))}
ok={'NEW','CLAIMED','ORDERED','FILLED','CLOSED'}
bys={}
for r in sorted(R,key=lambda r:J[r['sid']]['at']): bys.setdefault(r['sym'],[]).append(r)
hit=[]
for s,xs in bys.items():
    for i,r in enumerate(xs):
        a=J[r['sid']]['at']
        if any(0<a-J[q['sid']]['at']<30*60000 and J[q['sid']]['st'] in ok for q in xs[:i]): hit.append(r)
print('candidates with a live same-symbol signal bar <30m earlier:',len(hit))
print(summ(hit,'those candidates'));print(summ([r for r in R if r not in hit],'others'))
