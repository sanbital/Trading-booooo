#!/usr/bin/env python3
import argparse,csv,json,statistics
from datetime import timedelta
from upbit_24h_replay import parse_utc,fetch_candles,first_at_or_after,rows_between,candle_ts,aggregate,net_ret,tick_size_krw,ceil_tick,next_tick,floor_tick

def load(path):
  out=[]
  with open(path,newline='',encoding='utf-8') as f:
    for r in csv.DictReader(f):r['created_at']=parse_utc(r['created_at']);out.append(r)
  return out

def dedup(rows,gap=180):
  out=[];last={}
  for r in sorted(rows,key=lambda x:x['created_at']):
    p=last.get(r['market'])
    if p and (r['created_at']-p).total_seconds()<gap:continue
    out.append(r);last[r['market']]=r['created_at']
  return out

def pre180(rows,ets,entry,fee,mode,safety=0,extra=False,costbuf=12):
  seg=rows_between(rows,ets,ets+timedelta(seconds=180))
  if not seg:return None
  protect=None;peak=entry;armed=False;reason='MARK_180';exitp=float(seg[-1]['trade_price']);exits=180
  for idx,r in enumerate(seg):
    hi=float(r['high_price']);lo=float(r['low_price']);close=float(r['trade_price']);peak=max(peak,hi)
    if mode=='current':
      mfe=(peak/entry-1)*10000
      candidate=protect or 0
      if mfe>=max(20,costbuf+2):candidate=max(candidate,entry*(1+costbuf/10000))
      if mfe>=max(20,costbuf+20+2):candidate=max(candidate,entry*(1+(costbuf+20)/10000))
      if mfe>=max(23,costbuf+20):candidate=max(candidate,peak*(1-6/10000))
      if candidate>0:
        candidate=floor_tick(candidate);candidate=min(candidate,peak-tick_size_krw(peak))
        locked=(candidate/entry-1)*10000-costbuf
        if close>candidate and locked>0 and candidate>(protect or 0):protect=candidate;armed=True
    else:
      raw=entry*(1+fee)/((1-fee)*(1-safety/10000))
      be=ceil_tick(raw)
      if extra:be=next_tick(be)
      if close>be and be*(1-fee)>entry*(1+fee):protect=max(protect or 0,be);armed=True
      # Preserve existing higher lock/trail stages.
      mfe=(peak/entry-1)*10000;candidate=protect or 0
      if mfe>=max(20,costbuf+20+2):candidate=max(candidate,entry*(1+(costbuf+20)/10000))
      if mfe>=max(23,costbuf+20):candidate=max(candidate,peak*(1-6/10000))
      if candidate>(protect or 0):
        candidate=floor_tick(candidate);candidate=min(candidate,peak-tick_size_krw(peak))
        if close>candidate and candidate*(1-fee)>entry*(1+fee):protect=candidate
    if idx>0 and protect and lo<=protect:
      exitp=protect;exits=(candle_ts(r)-ets).total_seconds();reason='PROTECT';break
  return {'net_return_pct':net_ret(entry,exitp,fee,fee),'armed':armed,'hit':reason=='PROTECT','reason':reason,'exit_s':exits,'stop':protect}

def summ(rows):
  a=aggregate([r['net_return_pct'] for r in rows]);
  if rows:a.update({'arm_rate':sum(r['armed'] for r in rows)/len(rows),'hit_rate':sum(r['hit'] for r in rows)/len(rows),'avg_exit_s':statistics.fmean(r['exit_s'] for r in rows)})
  return a

def main():
  ap=argparse.ArgumentParser();ap.add_argument('--candidates',required=True);ap.add_argument('--context',required=True);ap.add_argument('--json',required=True);ap.add_argument('--md',required=True);a=ap.parse_args()
  ctx=json.load(open(a.context));fee=float(ctx.get('buy_fee_bps',5))/10000;cost=float(ctx.get('cost_buffer_upbit_bps',12))
  cands=dedup(load(a.candidates));grids={'CURRENT':[]};safeties=[0,1,2,3,5,8,10,15,20,25,30,34,35,40,45,50]
  for s in safeties:
    for ex in (False,True):grids[f'DYN_S{s}_T{int(ex)}']=[]
  details=[];adverse_all=[]
  for i,c in enumerate(cands,1):
    rows=fetch_candles(c['market'],c['created_at']-timedelta(seconds=5),c['created_at']+timedelta(seconds=185),seconds=True)
    er=first_at_or_after(rows,c['created_at'])
    if not er:continue
    ets=candle_ts(er);entry=float(er['trade_price']);one={'market':c['market'],'entry':entry,'policies':{}}
    r=pre180(rows,ets,entry,fee,'current',costbuf=cost);grids['CURRENT'].append(r);one['policies']['CURRENT']=r
    for s in safeties:
      for ex in (False,True):
        k=f'DYN_S{s}_T{int(ex)}';r=pre180(rows,ets,entry,fee,'dynamic',s,ex,cost);grids[k].append(r);one['policies'][k]=r
    seg=rows_between(rows,ets,ets+timedelta(seconds=180));cl=[float(x['trade_price']) for x in seg]
    for j in range(len(cl)-2):adverse_all.append(max(0,(1-cl[j+2]/cl[j])*10000))
    details.append(one);print(f'{i}/{len(cands)} {c["market"]}',flush=True)
  ag={k:summ(v) for k,v in grids.items()};cur=ag['CURRENT'];rank=[]
  for k,v in ag.items():
    if k=='CURRENT':continue
    # Optimize mean while requiring p10 no worse than current. Prefer smaller safety/no extra tick among near-ties.
    ok=v.get('mean',-999)>=cur.get('mean',-999) and v.get('p10',-999)>=cur.get('p10',-999)
    parts=k.split('_');s=float(parts[1][1:]);ex=int(parts[2][1:]);rank.append((1 if ok else 0,v.get('mean',-999),v.get('p10',-999),-s,-ex,k,v))
  rank.sort(reverse=True);best=rank[0]
  res={'context':ctx,'raw':len(load(a.candidates)),'dedup':len(cands),'replayed':len(details),'current':cur,'variants':ag,'best':{'name':best[5],'metrics':best[6]},'adverse_2s_unconditional_bps':aggregate(adverse_all),'details':details}
  json.dump(res,open(a.json,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
  lines=['# Upbit 24h Pre-180 Profit Protection Replay',f'- raw {res["raw"]}; dedup {res["dedup"]}; replayed {res["replayed"]}',f'- CURRENT mean={cur.get("mean",0):.4f}% p10={cur.get("p10",0):.4f}% arm={cur.get("arm_rate",0)*100:.1f}% hit={cur.get("hit_rate",0)*100:.1f}%',f'- BEST {best[5]} mean={best[6].get("mean",0):.4f}% p10={best[6].get("p10",0):.4f}% arm={best[6].get("arm_rate",0)*100:.1f}% hit={best[6].get("hit_rate",0)*100:.1f}%']
  ad=res['adverse_2s_unconditional_bps'];lines.append(f'- 2s adverse (zeros included): p90={ad.get("p90",0):.4f}bps p95={ad.get("p95",0):.4f}bps median={ad.get("median",0):.4f}bps')
  lines+=['','|Variant|N|Mean %|P10 %|Positive %|Arm %|Hit %|','|---|---:|---:|---:|---:|---:|---:|']
  for k in ['CURRENT']+[f'DYN_S{s}_T{ex}' for s in safeties for ex in (0,1)]:
    v=ag[k];lines.append(f'|{k}|{v.get("n",0)}|{v.get("mean",0):.4f}|{v.get("p10",0):.4f}|{v.get("positive_rate",0)*100:.2f}|{v.get("arm_rate",0)*100:.2f}|{v.get("hit_rate",0)*100:.2f}|')
  open(a.md,'w',encoding='utf-8').write('\n'.join(lines)+'\n')
if __name__=='__main__':main()
