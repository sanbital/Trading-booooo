#!/usr/bin/env python3
import argparse,csv,json,statistics
from datetime import timedelta
from upbit_24h_replay import parse_utc,fetch_candles,first_at_or_after,rows_between,candle_ts,aggregate,net_ret,tick_size_krw,ceil_tick,floor_tick,current_fixed_sim

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

def sim(rows,ets,entry,fee,arm_bps,horizon=600,costbuf=12,pattern=''):
  seg=rows_between(rows,ets,ets+timedelta(seconds=horizon))
  if not seg:return None
  momentum=pattern.upper()=='MOMENTUM_CONTINUATION'; peak=entry; protect=None; armed=False
  buycost=entry*(1+fee); remaining=1.0; realized=0.0;t1=False;exitp=float(seg[-1]['trade_price']);reason='TIMEOUT';exits=horizon
  raw_be=buycost/(1-fee);be=ceil_tick(raw_be)
  for idx,r in enumerate(seg):
    hi=float(r['high_price']);lo=float(r['low_price']);close=float(r['trade_price']);peak=max(peak,hi);mfe=(peak/entry-1)*10000
    if not t1 and lo<=entry*.96:
      exitp=entry*.96;reason='SL4';remaining=0;exits=(candle_ts(r)-ets).total_seconds();break
    if not t1 and hi>=entry*1.05:
      realized+=.5*entry*1.05*(1-fee);remaining=.5;t1=True
    if t1:
      pr=(peak/entry-1)*100;floorret=max(3,pr-1.5);fp=entry*(1+floorret/100)
      if lo<=fp:
        exitp=fp;realized+=remaining*exitp*(1-fee);remaining=0;reason='RESIDUAL_TRAIL';exits=(candle_ts(r)-ets).total_seconds();break
      continue
    if mfe>=arm_bps and close>be and be*(1-fee)>buycost:
      protect=max(protect or 0,be);armed=True
    locknet=6 if momentum else 20
    if mfe>=max(20,costbuf+locknet+2):
      cand=entry*(1+(costbuf+locknet)/10000);cand=floor_tick(cand)
      if close>cand and cand*(1-fee)>buycost:protect=max(protect or 0,cand)
    if mfe>=max(23,costbuf+20):
      cand=peak*(1-(12 if momentum else 6)/10000);cand=floor_tick(cand);cand=min(cand,peak-tick_size_krw(peak))
      if close>cand and cand*(1-fee)>buycost:protect=max(protect or 0,cand)
    if idx>0 and protect and lo<=protect:
      exitp=protect;realized+=remaining*exitp*(1-fee);remaining=0;reason='PROTECT';exits=(candle_ts(r)-ets).total_seconds();break
  if remaining>0:realized+=remaining*exitp*(1-fee)
  return {'net_return_pct':(realized/buycost-1)*100,'armed':armed,'hit':reason=='PROTECT','exit_s':exits,'reason':reason,'be':be}

def summ(rows):
  a=aggregate([r['net_return_pct'] for r in rows]);
  if rows:a.update({'arm_rate':sum(bool(r.get('armed')) for r in rows)/len(rows),'hit_rate':sum(bool(r.get('hit')) for r in rows)/len(rows),'avg_exit_s':statistics.fmean(float(r.get('exit_s',600)) for r in rows)})
  return a

def main():
  ap=argparse.ArgumentParser();ap.add_argument('--candidates',required=True);ap.add_argument('--context',required=True);ap.add_argument('--json',required=True);ap.add_argument('--md',required=True);a=ap.parse_args()
  ctx=json.load(open(a.context));fee=float(ctx.get('buy_fee_bps',5))/10000;cost=float(ctx.get('cost_buffer_upbit_bps',12));cands=dedup(load(a.candidates))
  arms=[10,12,14,15,16,18,20,22,25,30,35,40,50];g={str(x):[] for x in arms};current=[];details=[]
  for i,c in enumerate(cands,1):
    rows=fetch_candles(c['market'],c['created_at']-timedelta(seconds=5),c['created_at']+timedelta(seconds=605),seconds=True);er=first_at_or_after(rows,c['created_at'])
    if not er:continue
    ets=candle_ts(er);entry=float(er['trade_price']);pattern=c.get('pattern','');one={'market':c['market'],'entry':entry,'arms':{}}
    cur=current_fixed_sim(rows,ets,entry,pattern,600,fee,cost)
    if cur: current.append({'net_return_pct':cur['net_return_pct'],'armed':bool(cur.get('protected_stop')),'hit':cur.get('exit_reason')=='PRE_T1_PROTECT','exit_s':600,'reason':cur.get('exit_reason')})
    for arm in arms:
      r=sim(rows,ets,entry,fee,arm,600,cost,pattern);g[str(arm)].append(r);one['arms'][str(arm)]=r
    details.append(one);print(f'{i}/{len(cands)} {c["market"]}',flush=True)
  ag={k:summ(v) for k,v in g.items()};curagg=summ(current);rank=[]
  for k,v in ag.items():
    # Prefer variants that improve both mean and p10 vs exact same-sample current.
    ok=v.get('mean',-999)>=curagg.get('mean',-999) and v.get('p10',-999)>=curagg.get('p10',-999)
    rank.append((1 if ok else 0,v.get('mean',-999),v.get('p10',-999),v.get('positive_rate',0),-float(k),k,v))
  rank.sort(reverse=True);best=rank[0]
  res={'context':ctx,'raw':len(load(a.candidates)),'dedup':len(cands),'replayed':len(details),'current_same_sample':curagg,'variants':ag,'best':{'arm_bps':best[5],'metrics':best[6],'dominates_current':bool(best[0])},'details':details}
  json.dump(res,open(a.json,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
  lines=['# Upbit Hybrid Protection Replay',f'- raw {res["raw"]}; dedup {res["dedup"]}; replayed {res["replayed"]}',f'- CURRENT same-sample mean={curagg.get("mean",0):.4f}%, p10={curagg.get("p10",0):.4f}%, positive={curagg.get("positive_rate",0)*100:.2f}%',f'- Best arm={best[5]}bps, mean={best[6].get("mean",0):.4f}%, p10={best[6].get("p10",0):.4f}%, positive={best[6].get("positive_rate",0)*100:.2f}%, dominates_current={bool(best[0])}','','|Arm bps|N|Mean %|P10 %|P05 %|Positive %|Arm %|Hit %|','|---:|---:|---:|---:|---:|---:|---:|---:|']
  for arm in arms:
    v=ag[str(arm)];lines.append(f'|{arm}|{v.get("n",0)}|{v.get("mean",0):.4f}|{v.get("p10",0):.4f}|{v.get("p05",0):.4f}|{v.get("positive_rate",0)*100:.2f}|{v.get("arm_rate",0)*100:.2f}|{v.get("hit_rate",0)*100:.2f}|')
  open(a.md,'w',encoding='utf-8').write('\n'.join(lines)+'\n')
if __name__=='__main__':main()
