"""Reconcile observed fills and DB without modifying either. No network or orders."""
import json,sys,datetime as dt,collections,math
from pathlib import Path
root=Path(sys.argv[1]);load=lambda n:json.loads((root/n).read_text())
protocol=load('protocol.json')
ms=lambda s:int(dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
cut=ms(protocol['cutoff']);start=ms(protocol['start']);split=ms(protocol['split']);deploy=ms(protocol['latest_deployment_registered'])
positions=load('positions.json');dbfills=load('fills.json');orders=load('orders.json');decisions=load('decisions.json');candles=load('candles.json')
responses=load('signed-fills.json')
for p in sorted(root.glob('signed-retry*.json')):responses+=json.loads(p.read_text())
signed={};success=set();errors=[]
for r in responses:
 if r['status_code']!=200:errors.append({'request_id':r['id'],'status':r['status_code'],'error':r.get('body',{}).get('error')});continue
 b=r['body'];assert b.get('paginationRequired') is False
 success.add(b['symbol'])
 for f in b['trades']:
  key=(f['symbol'],str(f['id']))
  if key in signed:assert signed[key]==f,('CONFLICTING_SIGNED_FILL',key)
  signed[key]=f
assert len(success)==len({p['symbol'] for p in positions}),'INCOMPLETE_SIGNED_SYMBOLS'
dbby={(f['market'],str(f['exchange_trade_id'])):f for f in dbfills};assert len(dbby)==len(dbfills),'DUPLICATE_DB_FILL'
allused=set();episodes=[];parity=[]
for p in positions:
 assert p['metadata']['executionMode']=='LEADER_MOMENTUM_V17' and p['side']=='LONG'
 assert p['state']=='CLOSED' and float(p['remaining_quantity'])==0
 meta=p['metadata'];ids={str(meta.get(k,'')) for k in ['entryOrderId','lastExitOrderId']}
 ids|={str(o.get('actualOrderId','')) for o in meta.get('exitProtection',{}).get('orders',[])}
 ids|={str(o.get('exchange_order_id','')) for o in orders if o['position_id']==p['id']}
 fs=sorted([f for (s,_),f in signed.items() if s==p['symbol'] and str(f['orderId']) in ids],key=lambda f:(int(f['time']),int(f['id'])))
 assert fs,('NO_FILLS',p['id'])
 buys=[f for f in fs if f['isBuyer']];sells=[f for f in fs if not f['isBuyer']]
 assert buys and sells and all(f['commissionAsset']=='USDT' for f in fs)
 qty=sum(float(f['qty']) for f in buys);sold=sum(float(f['qty']) for f in sells)
 assert abs(qty-sold)<max(1e-8,qty*1e-8)
 gross=sum(float(f['realizedPnl']) for f in fs);fee=sum(float(f['commission']) for f in fs);net=gross-fee
 assert abs(net-float(p['realized_pnl_usdt']))<1e-5,('PNL_MISMATCH',p['id'])
 for f in fs:
  key=(f['symbol'],str(f['id']));assert key not in allused,('DOUBLE_ATTRIBUTION',key);allused.add(key)
  if key in dbby:
   db=dbby[key];raw=db['raw_response']
   assert all(str(raw[k])==str(f[k]) for k in ['id','orderId','symbol','qty','price','commission','realizedPnl','time']),('FILL_DIFFERENCE',key)
 ent=min(int(f['time']) for f in buys);ex=max(int(f['time']) for f in sells)
 entry=sum(float(f['quoteQty']) for f in buys)/qty;exit=sum(float(f['quoteQty']) for f in sells)/sold
 quotes=[d for d in decisions if d['position_id']==p['id'] and d['details'].get('bid') and ent<=ms(d['decided_at'])<=ex]
 observed=max([entry,exit]+[float(d['details']['bid']) for d in quotes]);bs=candles[p['id']]
 assert len(set(b[0] for b in bs))==len(bs) and all(bs[i][0]-bs[i-1][0]==60000 for i in range(1,len(bs)))
 inner=[b for b in bs if b[0]>=ent and b[6]<=ex];outer=[b for b in bs if b[6]>=ent and b[0]<=ex]
 post={}
 for n in [5,15,30]:
  path=[b for b in bs if b[0]>=ex and b[6]<=ex+n*60000]
  complete=bool(path) and ex+n*60000-path[-1][6]<=60000 and ex+n*60000<=cut
  post[str(n)]={'complete':complete,'return_from_exit':float(path[-1][4])/exit-1 if complete else None}
 delays=[]
 for o in meta.get('exitProtection',{}).get('orders',[]):
  if o.get('ackAt') and o.get('submittedAt'):delays.append(o['ackAt']-o['submittedAt'])
 evidence=[]
 if net<0:evidence.append('PROFIT_THEN_LOSS' if observed/entry-1>=.01 else 'LOW_OBSERVED_MFE_LOSS')
 if net>0:evidence.append('PROFIT')
 if gross>0 and net<0:evidence.append('FEES_FLIPPED_PROFIT')
 if meta.get('exitProtection',{}).get('health') not in ['PROTECTED',None]:evidence.append('PROTECTION_HEALTH_REQUIRES_REVIEW')
 e={'id':p['id'],'symbol':p['symbol'],'ownership':'AUTO_ORDER_ID_PROVEN','patch':meta['executorPatch'],'policy':meta.get('leaderExitPolicyVersion'),
 'entry_ms':ent,'state_entry_ms':ms(p['entry_at']),'exit_ms':ex,'entry_price':entry,'exit_price':exit,'quantity':qty,'gross':gross,'fees':fee,'net':net,'funding':None,
 'entry_fee':sum(float(f['commission']) for f in buys),'baseline_config':meta['leaderExitPolicy'],'features':meta['entryFeatures'],'fills':fs,
 'held_minutes':(ex-ent)/60000,'observed_mfe':observed/entry-1,'mfe_inner':max([observed]+[float(b[2]) for b in inner])/entry-1,
 'mfe_outer':max([observed]+[float(b[2]) for b in outer])/entry-1,'mae_inner':min([entry,exit]+[float(b[3]) for b in inner])/entry-1,
 'mae_outer':min([entry,exit]+[float(b[3]) for b in outer])/entry-1,'giveback_observed_usdt':(observed-exit)*qty,
 'post_exit':post,'recorded_reason':p['exit_reason'],'last_fill_to_db_closed_ms':ms(p['closed_at'])-ex,
 'protection_ack_delays_ms':delays,'observed_quote_count':len(quotes),'categories':evidence,
 'after_latest_deployment':ent>=deploy,'crossed_latest_deployment':ent<deploy<ex,'crossed_patch_in_decisions':len(set(d['details'].get('executorPatch') for d in quotes))>1,
 'signal_age_ms':ent-meta['entryFeatures']['signal5Close'],'entry_drift_pct':entry/meta['entryFeatures']['referenceClose']-1}
 episodes.append(e)
episodes.sort(key=lambda x:x['entry_ms'])
def stats(xs):
 vals=[x['net'] for x in xs];w=[v for v in vals if v>0];l=[v for v in vals if v<0];eq=peak=dd=0
 for x in sorted(xs,key=lambda x:x['exit_ms']):eq+=x['net'];peak=max(peak,eq);dd=max(dd,peak-eq)
 return {'n':len(xs),'net_excluding_unverified_funding':sum(vals),'gross':sum(x['gross'] for x in xs),'fees':sum(x['fees'] for x in xs),'expectancy':sum(vals)/len(vals) if vals else None,'win_rate':len(w)/len(vals) if vals else None,'average_win':sum(w)/len(w) if w else None,'average_loss':sum(l)/len(l) if l else None,'profit_factor':sum(w)/-sum(l) if l else None,'realized_curve_drawdown':dd,'worst':min(vals) if vals else None,'notional_hours':sum(x['entry_price']*x['quantity']*x['held_minutes']/60 for x in xs)}
groups={'ALL':episodes,'FIRST_24H':[x for x in episodes if x['entry_ms']<split],'SECOND_24H':[x for x in episodes if x['entry_ms']>=split],
 'LATEST_DEPLOYMENT':[x for x in episodes if x['after_latest_deployment']],'CROSSED_LATEST_DEPLOYMENT':[x for x in episodes if x['crossed_latest_deployment']]}
for patch in set(x['patch'] for x in episodes):groups[patch]=[x for x in episodes if x['patch']==patch]
unknown=[f for f in dbfills if (f['market'],str(f['exchange_trade_id'])) not in allused]
missing=[{'symbol':s,'trade_id':t} for s,t in allused if (s,t) not in dbby]
out={'protocol':protocol,'actual':{k:stats(v) for k,v in groups.items()},'signed_symbols':len(success),'historical_fill_rows':len(allused),'db_fill_rows':len(dbfills),
 'missing_from_db':missing,'unmatched_db_fills':unknown,'raw_errors_preserved':errors,'price_resolution':'1 minute OHLC plus sparse actual executable bid decisions',
 'funding_verified':False,'independent_trades':0,'account_total_pnl_verified':False,'all_conditional_orders_verified':False,
 'version_warning':'Patch labels are NOT deploy/build identifiers; exact historical deployment boundaries beyond the latest build remain unverified.'}
(root/'episodes.json').write_text(json.dumps(episodes,ensure_ascii=False,indent=2)+'\n');(root/'audit-summary.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:out[k] for k in ['actual','signed_symbols','historical_fill_rows','db_fill_rows','missing_from_db']},ensure_ascii=False))
