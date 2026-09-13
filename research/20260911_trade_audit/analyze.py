"""Read-only, reproducible attribution and performance audit. No account credentials or IO."""
import argparse, collections, datetime as dt, json, math
from pathlib import Path

def epoch(x):
    if isinstance(x, (int,float)): return x
    return dt.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()*1000
def iso(x): return dt.datetime.fromtimestamp(x/1000,dt.timezone.utc).isoformat()
def number(x): return None if x is None else float(x)
def stats(rows):
    vals=[r['net_before_funding'] for r in rows if r['net_before_funding'] is not None]
    wins=[x for x in vals if x>0]; losses=[x for x in vals if x<0]
    equity=peak=mdd=0
    for r in sorted(rows,key=lambda x:x['exit_ms']):
        equity+=r['net_before_funding'] or 0;peak=max(peak,equity);mdd=max(mdd,peak-equity)
    return dict(n=len(rows),known_net_n=len(vals),net_before_funding=sum(vals),wins=len(wins),losses=len(losses),
        win_rate=len(wins)/len(vals) if vals else None,avg_win=sum(wins)/len(wins) if wins else None,
        avg_loss=sum(losses)/len(losses) if losses else None,profit_factor=sum(wins)/-sum(losses) if losses else None,
        expectancy=sum(vals)/len(vals) if vals else None,closed_trade_curve_drawdown=mdd,
        worst_loss=min(vals) if vals else None,positive_1pct_then_loss=sum(r['observed_mfe']>=.01 and (r['net_before_funding'] or 0)<0 for r in rows),
        notional_turnover=sum(r['entry_notional']+r['exit_notional'] for r in rows))

def audit(evidence,out):
    read=lambda n:json.loads((evidence/n).read_text())
    ps=read('positions.json'); orders=read('orders_export.json'); dbfills=read('fill_export.json');ds=read('decisions_export.json')
    fs=read('signed-fills.json'); candles=read('candles_1m.json');gates=read('promotion-gates.json');cut=epoch(gates['analysis_cutoff_utc'])
    fs=[f for f in fs if epoch(f['time'])<=cut];known=collections.defaultdict(set)
    for o in orders:
        if o['position_id'] and o['exchange_order_id']:known[(o['symbol'],str(o['exchange_order_id']))].add(o['position_id'])
    for p in ps:
        m=p['metadata']
        for k in ['entryOrderId','lastExitOrderId']:
            if m.get(k):known[(p['symbol'],str(m[k]))].add(p['id'])
        for s in m.get('exitProtection',{}).get('orders',[]):
            if s.get('actualOrderId'):known[(p['symbol'],str(s['actualOrderId']))].add(p['id'])
    linked=collections.defaultdict(list);ambiguous=[];dbkeys={(f['market'],str(f['exchange_trade_id'])):f for f in dbfills}
    for f in fs:
        ids=known.get((f['symbol'],str(f['orderId'])),set())
        if len(ids)==1:linked[next(iter(ids))].append(f)
        else:ambiguous.append(f)
    decisions=collections.defaultdict(list)
    for d in ds: decisions[d['position_id']].append(d)
    rows=[]
    for p in ps:
        fills=sorted(linked[p['id']],key=lambda x:(x['time'],x['id']));buy=[f for f in fills if f['isBuyer']];sell=[f for f in fills if not f['isBuyer']]
        bqty=sum(float(f['qty']) for f in buy);sqty=sum(float(f['qty']) for f in sell)
        bval=sum(float(f['quoteQty']) for f in buy);sval=sum(float(f['quoteQty']) for f in sell)
        if not buy or not sell: raise ValueError('Missing owned entry/exit fills: '+p['id'])
        ent=bval/bqty;ex=sval/sqty;entry_ms=min(f['time'] for f in buy);exit_ms=max(f['time'] for f in sell)
        fee_known=all(f['commissionAsset']=='USDT' for f in fills);fees=sum(float(f['commission']) for f in fills) if fee_known else None
        gross=sum(float(f['realizedPnl']) for f in fills);net=gross-fees if fee_known else None
        owned_complete=abs(bqty-sqty)<=max(1e-8,bqty*1e-8)
        if not owned_complete: raise ValueError('Unbalanced position: '+p['id'])
        if abs(net-float(p['realized_pnl_usdt']))>1e-5: raise ValueError('Exchange/DB PnL mismatch: '+p['id'])
        path=[d for d in decisions[p['id']] if d['details'].get('bid') and entry_ms<=epoch(d['decided_at'])<=exit_ms]
        quotes=[float(d['details']['bid']) for d in path];observed_peak=max([ent,ex]+quotes)
        observed_mfe=observed_peak/ent-1;bars=candles[p['id']]
        full=[b for b in bars if b[0]>=entry_ms and b[6]<=exit_ms]
        overlap=[b for b in bars if b[6]>=entry_ms and b[0]<=exit_ms]
        mfe_low=max([observed_peak]+[float(b[2]) for b in full])/ent-1
        mfe_high=max([observed_peak]+[float(b[2]) for b in overlap])/ent-1
        mae_low=min([ent,ex]+quotes+[float(b[3]) for b in full])/ent-1
        mae_outer=min([ent,ex]+quotes+[float(b[3]) for b in overlap])/ent-1
        peak_decision=max(path,key=lambda d:float(d['details']['bid'])) if path else None
        closing=[d for d in decisions[p['id']] if d['action'] in ('FULL_CLOSE','CLOSE') and entry_ms<=epoch(d['decided_at'])<=exit_ms+120000]
        signal=min([d['details'].get('detectedAtMs',epoch(d['decided_at'])) for d in closing],default=None)
        post={}
        for minutes in [5,15,30]:
            target=exit_ms+minutes*60000;finished=[b for b in bars if b[0]>=exit_ms and b[6]<=target]
            complete=target<=cut and bool(finished) and target-finished[-1][6]<=60000
            post[str(minutes)]={'horizon_complete':complete,'last_close_return_from_exit':float(finished[-1][4])/ex-1 if complete else None,
                'max_high_return_from_exit':max(float(b[2]) for b in finished)/ex-1 if complete else None}
        patch=p['metadata'].get('executorPatch','UNKNOWN');ispost=patch==gates['operational_patch']
        categories=[]
        if net<0:
            if observed_mfe>=.01:categories.append('OBSERVED_PROFIT_1PCT_THEN_LOSS')
            elif mfe_low>=.01:categories.append('INTRAMINUTE_PROFIT_1PCT_THEN_LOSS')
            else:categories.append('LOW_FAVORABLE_EXCURSION_LOSS')
            if gross>0:categories.append('FEES_FLIPPED_GROSS_PROFIT')
            if signal and exit_ms-signal>10000:categories.append('SOFTWARE_EXIT_DELAY_OVER_10S')
            if post['30']['horizon_complete'] and post['30']['last_close_return_from_exit']>0:categories.append('POST_EXIT_REBOUND_RETROSPECTIVE_ONLY')
        else:categories.append('PROFIT')
        if any((d.get('details',{}).get('nativeStop') or {}).get('status') in ('SYNC_FAILED','UNKNOWN') for d in path):categories.append('PROTECTION_QUERY_OR_SYNC_ERROR')
        if any((f['symbol'],str(f['id'])) not in dbkeys for f in fills):categories.append('FILL_COLLECTION_GAP')
        row=dict(id=p['id'],symbol=p['symbol'],side=p['side'],attribution='AUTOMATED_IDENTITY_AND_QUANTITY_VERIFIED',patch=patch,
            policy=p['metadata'].get('leaderExitPolicyVersion','ORIGINAL_OR_BE_BY_MANAGER_PATCH'),cohort='POST' if ispost else 'PRE',
            entry_ms=entry_ms,exit_ms=exit_ms,entry_time=iso(entry_ms),exit_time=iso(exit_ms),entry_price=ent,exit_price=ex,
            quantity=bqty,entry_notional=bval,exit_notional=sval,leverage=3,estimated_initial_margin=bval/3,
            gross_realized=gross,fees=fees,funding=None,net_before_funding=net,total_net_including_funding=None,
            price_return=ex/ent-1,net_notional_return=net/bval,net_estimated_margin_return=net/(bval/3),
            held_minutes=(exit_ms-entry_ms)/60000,observed_mfe=observed_mfe,mfe_1m_lower=mfe_low,mfe_1m_upper=mfe_high,
            mae_1m_inner=mae_low,mae_1m_outer=mae_outer,observed_peak=observed_peak,
            observed_peak_at=peak_decision['decided_at'] if peak_decision else None,
            protection_at_observed_peak=peak_decision['details'].get('stopPrice') if peak_decision else None,
            indicative_gross_giveback=(observed_peak-ex)*bqty,signal_to_final_fill_ms=exit_ms-signal if signal is not None else None,
            exit_reason=p['exit_reason'],categories=categories,post_exit=post,features=p['metadata'].get('entryFeatures',{}),
            entry_fee=sum(float(f['commission']) for f in buy),fills=fills,baseline_config=p['metadata'].get('leaderExitPolicy',{}))
        rows.append(row)
    rows.sort(key=lambda x:x['entry_ms'])
    bysymbol=collections.defaultdict(list)
    for r in rows:bysymbol[r['symbol']].append(r)
    repeats=[]
    for symbol,rs in bysymbol.items():
        for previous,current in zip(rs,rs[1:]):
            if previous['net_before_funding']<0 and 0<=current['entry_ms']-previous['exit_ms']<1800000:
                repeats.append({'symbol':symbol,'previous':previous['id'],'next':current['id'],'gap_minutes':(current['entry_ms']-previous['exit_ms'])/60000,
                    'next_net':current['net_before_funding'],'previous_net':previous['net_before_funding']})
    missing=[f for f in fs if (f['symbol'],str(f['id'])) not in dbkeys]
    reclassified=[{'symbol':f['symbol'],'trade_id':f['id'],'order_id':f['orderId'],'db_source':dbkeys[(f['symbol'],str(f['id']))]['source']}
        for pid,fills in linked.items() for f in fills if (f['symbol'],str(f['id'])) in dbkeys and dbkeys[(f['symbol'],str(f['id']))]['source']!='AUTOMATED']
    output={'asof':gates['analysis_cutoff_utc'],'period_start':iso(cut-7*86400000),'cost_convention':'fees positive expenses; funding unverified; no extra slippage deduction from actual fills',
        'coverage':{'positions':len(rows),'symbols':len({r['symbol'] for r in rows}),'signed_fills':len(fs),'owned_fills':sum(len(x) for x in linked.values()),
            'db_missing_fills':len(missing),'missing_by_symbol':dict(collections.Counter(f['symbol'] for f in missing)),
            'reclassified_analysis_only':reclassified,'unlinked_fills':len(ambiguous),'funding_verified':False,'unseen_manual_symbols_cannot_be_ruled_out':True},
        'summary':{'post':stats([r for r in rows if r['cohort']=='POST']),'pre':stats([r for r in rows if r['cohort']=='PRE']),
            'last24h':stats([r for r in rows if r['exit_ms']>=cut-86400000]),'last7d':stats(rows)},
        'by_patch':{k:stats([r for r in rows if r['patch']==k]) for k in sorted({r['patch'] for r in rows})},
        'loss_categories':dict(collections.Counter(c for r in rows for c in r['categories'])),
        'repeat_entries_after_loss':repeats,'trades':rows,'unlinked_fills':ambiguous}
    out.mkdir(parents=True,exist_ok=True);(out/'trade_audit.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
    print(json.dumps({k:output[k] for k in ['coverage','summary','loss_categories','repeat_entries_after_loss']},ensure_ascii=False,indent=2))
    return output

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();audit(args.evidence,args.out)
