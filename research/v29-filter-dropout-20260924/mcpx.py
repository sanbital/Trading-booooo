import json,sys,re
def load(path):
    d=json.load(open(path))
    r=d['result'] if isinstance(d,dict) else d
    if isinstance(r,list): return r
    m=re.search(r'<untrusted-data-[^>]+>\n(.*)\n</untrusted-data',r,re.S)
    return json.loads(m.group(1))
if __name__=='__main__':
    rows=load(sys.argv[1]); col=sys.argv[3] if len(sys.argv)>3 else None
    v=rows[0][col] if col else rows
    if isinstance(v,str): v=json.loads(v)
    json.dump(v,open(sys.argv[2],'w'))
    print(type(v).__name__, len(v))
