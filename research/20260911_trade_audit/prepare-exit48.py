"""Frozen 48h episode reconstruction. No network or trading side effects."""
import json,sys,datetime as dt
from pathlib import Path
root=Path(sys.argv[1]);prior=Path(sys.argv[2])
load=lambda p:json.loads(p.read_text())
ms=lambda s:int(dt.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
positions=load(root/'positions.json');candles=load(root/'candles.json');decisions=load(root/'decisions.json')
old={r['id']:r for r in load(prior)['trades']};fresh={}
for response in load(root/'fresh-signed-fills.json'):
 assert response['status_code']==200 and not response['body']['paginationRequired']
 for f in response['body']['trades']:
  key=(f['symbol'],str(f['id']))
  if key in fresh:assert fresh[key]==f
  fresh[key]=f
rows=[]
for p in positions:
 assert p['metadata']['executionMode']=='LEADER_MOMENTUM_V17'
 if p['id'] in old:
  fs=old[p['id']]['fills'];source='PRIOR_SIGNED_FILL_AUDIT'
 else:
  meta=p['metadata'];ids={str(meta.get(k,'')) for k in ['entryOrderId','lastExitOrderId']}
  ids|={str(o.get('actualOrderId','')) for o in meta.get('exitProtection',{}).get('orders',[])}
  fs=[f for f in fresh.values() if f['symbol']==p['symbol'] and str(f['orderId']) in ids];source='FRESH_SIGNED_ACCOUNT_FILLS'
 assert fs and len({(f['symbol'],str(f['id'])) for f in fs})==len(fs),p['id']
 assert all(f['commissionAsset']=='USDT' for f in fs)
 buys=[f for f in fs if f['isBuyer']];sells=[f for f in fs if not f['isBuyer']]
 qty=sum(float(f['qty']) for f in buys);sold=sum(float(f['qty']) for f in sells)
 assert qty>0 and abs(qty-sold)<max(1e-8,qty*1e-8),p['id']
 entry=sum(float(f['quoteQty']) for f in buys)/qty;exit=sum(float(f['quoteQty']) for f in sells)/sold
 fee=sum(float(f['commission']) for f in fs);gross=sum(float(f['realizedPnl']) for f in fs);net=gross-fee
 assert abs(net-float(p['realized_pnl_usdt']))<1e-5,(p['id'],net,p['realized_pnl_usdt'])
 ent=min(f['time'] for f in buys);ex=max(f['time'] for f in sells)
 ds=[d for d in decisions if d['position_id']==p['id'] and ent<=ms(d['decided_at'])<=ex and d['details'].get('bid')]
 observed=max([entry,exit]+[float(d['details']['bid']) for d in ds]);bs=candles[p['id']]
 full=[b for b in bs if b[0]>=ent and b[6]<=ex];overlap=[b for b in bs if b[6]>=ent and b[0]<=ex]
 categories=[]
 if net<0:
  categories.append('OBSERVED_PROFIT_THEN_LOSS' if observed/entry-1>=.01 else 'LOW_FAVORABLE_EXCURSION_LOSS')
  if gross>0:categories.append('FEES_FLIPPED_PROFIT')
 else:categories.append('PROFIT')
 post={}
 for minutes in [5,15,30]:
  path=[b for b in bs if b[0]>=ex and b[6]<=ex+minutes*60000]
  complete=bool(path) and ex+minutes*60000-path[-1][6]<=60000 and ex+minutes*60000<=ms('2026-09-11T12:11:25.984451Z')
  post[str(minutes)]={'complete':complete,'returnFromExit':float(path[-1][4])/exit-1 if complete else None}
 rows.append({'id':p['id'],'symbol':p['symbol'],'patch':p['metadata']['executorPatch'],'policy':p['metadata']['leaderExitPolicyVersion'],
  'entry_ms':ent,'exit_ms':ex,'entry_price':entry,'exit_price':exit,'quantity':qty,'fees':fee,'gross':gross,'net':net,
  'entry_fee':sum(float(f['commission']) for f in buys),'baseline_config':p['metadata']['leaderExitPolicy'],
  'features':p['metadata']['entryFeatures'],'source':source,'fills':fs,'funding':None,
  'observed_mfe':observed/entry-1,'mfe_inner':max([observed]+[float(b[2]) for b in full])/entry-1,
  'mfe_outer':max([observed]+[float(b[2]) for b in overlap])/entry-1,
  'mae_inner':min([entry,exit]+[float(b[3]) for b in full])/entry-1,
  'mae_outer':min([entry,exit]+[float(b[3]) for b in overlap])/entry-1,
  'observed_giveback_usdt':(observed-exit)*qty,'categories':categories,'post_exit':post,
  'observed_quote_count':len(ds),'held_minutes':(ex-ent)/60000})
rows.sort(key=lambda r:r['entry_ms'])
(root/'episodes.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
print(json.dumps({'episodes':len(rows),'fresh_signed':sum(r['source']=='FRESH_SIGNED_ACCOUNT_FILLS' for r in rows),
 'net':sum(r['net'] for r in rows),'post_net':sum(r['net'] for r in rows if r['patch']=='V18-OPS-ISOLATION-3'),
 'all_fills_match_db':True,'fundingVerified':False},ensure_ascii=False))
