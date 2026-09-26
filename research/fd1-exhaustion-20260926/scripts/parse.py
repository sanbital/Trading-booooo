import json,re,glob,os
R='/root/.claude/projects/-home-user-Trading-booooo/8d0a3e6d-1869-5e6b-a7dc-db67b546d1a7/tool-results/'
def inner(path):
    s=json.load(open(path))['result']
    m=re.search(r'<untrusted-data-[0-9a-f-]+>\n(.*)\n</untrusted-data',s,re.S)
    rows=json.loads(m.group(1)); return list(rows[0].values())[0]
files=sorted(glob.glob(R+'mcp-Supabase-execute_sql-*.txt'))
kl={}; oi={}; out={}
for f in files:
    v=inner(f)
    if isinstance(v,str) and '|' in v[:80] and ';' in v:
        if v.count(',')>0 and re.match(r'^[^|]+\|\d+,[\d.]+,[\d.]+;',v) and v.split(';')[0].count(',')==2:
            for part in v.split(';'):
                sym,rest=part.split('|'); t,a,b=rest.split(','); oi.setdefault(sym,[]).append((int(t)*60000,float(a),float(b)))
            print('oi',f[-18:]); continue
        for line in v.split('\n'):
            sym,rest=line.split('|',1)
            if sym=='BTCUSDT' and rest.count(';')<7000 and sym in kl: pass
            rows=[]
            for r in rest.split(';'):
                x=r.split(','); rows.append([int(x[0])*60000]+[float(y) for y in x[1:]])
            if sym in kl and len(kl[sym])>=len(rows): continue
            kl[sym]=rows
        print('kl',f[-18:],len(kl))
    elif isinstance(v,list):
        k=v[0].keys()
        name='journal' if 'rn60' in k else 'positions' if 'pid' in k else 'gpt' if 'facts' in k else None
        print(name,len(v)); out[name]=v
json.dump(kl,open('data/k1.json','w')); json.dump(oi,open('data/oi.json','w'))
for k,v in out.items(): json.dump(v,open(f'data/{k}.json','w'))
print(len(kl),sum(len(x) for x in kl.values()),len(oi))
