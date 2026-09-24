import json,sys,glob,os
sys.path.insert(0,'.'); from mcpx import load
out=json.load(open('data/klines.json')) if os.path.exists('data/klines.json') else {}
for p in sys.argv[1:]:
    rows=load(p); v=json.loads(rows[0]['j'])
    for r in v:
        if r['err']: print('ERR',r['s'],r['st'],r['err']); continue
        d=out.setdefault(r['s'],{})
        for bar in (r['b'] or '').split(';'):
            if not bar: continue
            x=bar.split(','); d[x[0]]=[float(y) for y in x[1:]]
    print(p,len(v))
json.dump(out,open('data/klines.json','w')); print('symbols',len(out),'bars',sum(len(x) for x in out.values()))
