#!/usr/bin/env python3
import argparse,csv,json,math,statistics
from datetime import timedelta
from upbit_24h_replay import parse_utc,fetch_candles,first_at_or_after,rows_between,candle_ts,net_ret,aggregate,iso_z

def load(path):
  out=[]
  with open(path,newline='',encoding='utf-8') as f:
    for r in csv.DictReader(f):
      r['created_at']=parse_utc(r['created_at']); out.append(r)
  return out

def dedup(rows,gap=180):
  out=[]; last={}
  for r in sorted(rows,key=lambda x:x['created_at']):
    p=last.get(r['market'])
    if p and (r['created_at']-p).total_seconds()<gap: continue
    out.append(r); last[r['market']]=r['created_at']
  return out

def recovery_sim(rows,entry_ts,entry,fee,start_s,ratio,timeout_s=600):
  seg=rows_between(rows,entry_ts,entry_ts+timedelta(seconds=timeout_s+2))
  if not seg:return None
  trough=entry; entered_recovery=False
  first180=None
  for r in seg:
    t=max(0,(candle_ts(r)-entry_ts).total_seconds())
    close=float(r['trade_price']); low=float(r['low_price'])
    if t<180: continue
    if first180 is None:
      first180=net_ret(entry,close,fee,fee)
      if first180>0:
        return {'net_return_pct':first180,'exit_s':t,'reason':'POSITIVE_AT_FIRST_180','recovery':False}
      entered_recovery=True
    trough=min(trough,low)
    nret=net_ret(entry,close,fee,fee)
    if nret>0:
      return {'net_return_pct':nret,'exit_s':t,'reason':'POSITIVE_NET','recovery':entered_recovery}
    if ratio is not None and t>=start_s and trough<entry:
      rr=(close-trough)/(entry-trough)
      if rr>=ratio:
        return {'net_return_pct':nret,'exit_s':t,'reason':'DRAWDOWN_RECOVERY','recovery':entered_recovery,'recovery_ratio':rr}
    if t>=timeout_s:
      return {'net_return_pct':nret,'exit_s':t,'reason':'TIMEOUT','recovery':entered_recovery}
  r=seg[-1]; return {'net_return_pct':net_ret(entry,float(r['trade_price']),fee,fee),'exit_s':(candle_ts(r)-entry_ts).total_seconds(),'reason':'CENSORED','recovery':entered_recovery}

def summarize(rows):
  vals=[x['net_return_pct'] for x in rows]; a=aggregate(vals)
  if not rows:return a
  a.update({'avg_exit_s':statistics.fmean(x['exit_s'] for x in rows),'loss_rate':sum(x['net_return_pct']<0 for x in rows)/len(rows),'drawdown_exit_rate':sum(x['reason']=='DRAWDOWN_RECOVERY' for x in rows)/len(rows)})
  return a

def main():
  ap=argparse.ArgumentParser();ap.add_argument('--candidates',required=True);ap.add_argument('--context',required=True);ap.add_argument('--json',required=True);ap.add_argument('--md',required=True);a=ap.parse_args()
  ctx=json.load(open(a.context));fee=float(ctx.get('buy_fee_bps',5))/10000
  cands=dedup(load(a.candidates)); episodes=[]
  grids={}; starts=[360,420,460,500,540]; ratios=[.20,.25,.33,.40,.50,.67]
  for st in starts:
    for rr in ratios:grids[f'S{st}_R{int(round(rr*100))}']=[]
  grids['POSITIVE_NET_ONLY']=[]
  adverse=[]
  for i,c in enumerate(cands,1):
    rows=fetch_candles(c['market'],c['created_at']-timedelta(seconds=5),c['created_at']+timedelta(seconds=905),seconds=True)
    er=first_at_or_after(rows,c['created_at'])
    if not er:continue
    ets=candle_ts(er);entry=float(er['trade_price'])
    base=recovery_sim(rows,ets,entry,fee,460,.33)
    off=recovery_sim(rows,ets,entry,fee,460,None)
    g={}
    for st in starts:
      for rr in ratios:
        k=f'S{st}_R{int(round(rr*100))}';x=recovery_sim(rows,ets,entry,fee,st,rr);g[k]=x
        if x and x.get('recovery'):grids[k].append(x)
    x=recovery_sim(rows,ets,entry,fee,460,None);g['POSITIVE_NET_ONLY']=x
    if x and x.get('recovery'):grids['POSITIVE_NET_ONLY'].append(x)
    seg=rows_between(rows,ets,ets+timedelta(seconds=600)); closes=[float(r['trade_price']) for r in seg]
    for j in range(len(closes)-2):
      move=(closes[j+2]/closes[j]-1)*10000
      if move<0: adverse.append(-move)
    episodes.append({'market':c['market'],'signal_at':iso_z(c['created_at']),'entry':entry,'current_460_33':base,'positive_only':off,'grid':g})
    print(f'{i}/{len(cands)} {c["market"]}',flush=True)
  summaries={k:summarize(v) for k,v in grids.items()}
  current=summaries['S460_R33']; off=summaries['POSITIVE_NET_ONLY']
  candidates=[]
  for k,v in summaries.items():
    if k=='POSITIVE_NET_ONLY' or not v.get('n'):continue
    # Require no worse p10 than current, then prioritize mean, then shorter time.
    ok=(v.get('p10',-999)>=current.get('p10',-999) and v.get('mean',-999)>=current.get('mean',-999))
    candidates.append((1 if ok else 0,v.get('mean',-999),v.get('p10',-999),-v.get('avg_exit_s',9999),k,v))
  candidates.sort(reverse=True);best=candidates[0] if candidates else None
  result={'execution_context':ctx,'raw_candidates':len(load(a.candidates)),'dedup_candidates':len(cands),'episodes':len(episodes),'recovery_cohort_current':current,'positive_net_only':off,'grid':summaries,'best_grid':{'name':best[4],'metrics':best[5]} if best else None,'adverse_2s_bps':aggregate(adverse),'episode_detail':episodes}
  json.dump(result,open(a.json,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
  lines=['# Upbit 24h Recovery Replay',f'- raw BUY {result["raw_candidates"]}; 180s-dedup {result["dedup_candidates"]}; replayed {result["episodes"]}',f'- Recovery cohort current 460/33: n={current.get("n",0)}, mean={current.get("mean",0):.4f}%, p10={current.get("p10",0):.4f}%, loss_rate={current.get("loss_rate",0)*100:.2f}%, avg_exit={current.get("avg_exit_s",0):.1f}s',f'- Positive-net only to 600: n={off.get("n",0)}, mean={off.get("mean",0):.4f}%, p10={off.get("p10",0):.4f}%, loss_rate={off.get("loss_rate",0)*100:.2f}%, avg_exit={off.get("avg_exit_s",0):.1f}s']
  if best:lines.append(f'- Best constrained grid: {best[4]} mean={best[5].get("mean",0):.4f}% p10={best[5].get("p10",0):.4f}% avg_exit={best[5].get("avg_exit_s",0):.1f}s')
  ad=result['adverse_2s_bps'];lines.append(f'- 2s adverse magnitude: p90={ad.get("p90",0):.4f}bps p95={ad.get("p95",0):.4f}bps')
  lines+=['','|Policy|N|Mean %|P10 %|Loss %|Avg exit s|','|---|---:|---:|---:|---:|---:|']
  keys=['S460_R33','POSITIVE_NET_ONLY']+[f'S{st}_R{int(rr*100)}' for st in starts for rr in ratios]
  seen=set()
  for k in keys:
    if k in seen:continue
    seen.add(k);v=summaries.get(k,{})
    if not v.get('n'):continue
    lines.append(f'|{k}|{v.get("n",0)}|{v.get("mean",0):.4f}|{v.get("p10",0):.4f}|{v.get("loss_rate",0)*100:.2f}|{v.get("avg_exit_s",0):.1f}|')
  open(a.md,'w',encoding='utf-8').write('\n'.join(lines)+'\n')
if __name__=='__main__':main()
