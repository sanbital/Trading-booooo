from axes import *
import json,datetime
K=json.load(open('data/k1.json'));MIN=60000;idx={s:{r[0]:i for i,r in enumerate(v)} for s,v in K.items()}
P={p['pid']:p for p in json.load(open('data/positions.json'))}
T=[r for r in R if r['pos'] and P.get(r['pos']) and P[r['pos']]['in']>=1790350000000]
T.sort(key=lambda r:P[r['pos']]['in'])
def kst(ms): return (datetime.datetime.utcfromtimestamp(ms/1000)+datetime.timedelta(hours=9)).strftime('%H:%M')
for r in T:
    p=P[r['pos']];s=r['sym'];e=p['ep'];v=r['gptFacts'] or r['v']
    i=idx[s].get(p['out']//MIN*MIN);post=K[s][i+1:i+61] if i is not None else []
    postHi=max(x[2] for x in post)/e-1 if post else None;postLo=min(x[3] for x in post)/e-1 if post else None
    # path: returns at +1,+3,+5,+10 min from entry
    j=idx[s].get(p['in']//MIN*MIN);path=[K[s][j+k][4]/e-1 for k in (1,3,5,10)] if j is not None else []
    pv=r['prev'];pvs=f"prev {pv['min_since_exit']:.0f}m ago pnl={pv['pnl']:.1f} mfe={pv['mfe']:.3f} px/peak={pv['px_vs_peak']:+.4f} newHigh={pv['new_high_since_exit']}" if pv and pv['min_since_exit']<240 else 'no prev(4h)'
    print(f"{s:10s} {kst(p['in'])} pnl={p['pnl']:6.2f} MFE={p['pk']/e-1:.4f} {p['why']:16s} axes={[k for k,x in r['ax'].items() if x]} cec={r['cec']}/{r['cecp']:.2f}")
    print(f"   t5={v['taker_buy_ratio_5m']:.3f} bsc={v['buyer_share_change']:+.3f} a5={v['accel_5m_vs_15m']:+.4f} a15={v['accel_15m_vs_60m']:+.4f} msh={v['minutes_since_high_60m']:.0f} vol={v['volume_ratio_5m_vs_60m']:.2f} oi5={v['oi_change_5m']} imb={v.get('book_imbalance_25bps')} r60={v['return_60m']:.3f} r4h={v['return_4h']:.3f} day={v['day_return']:.3f} btc15={v['btc_return_15m']:+.4f}")
    print(f"   path +1/3/5/10m: {['%+.4f'%x for x in path]}  post-exit 60m hi={postHi:+.4f} lo={postLo:+.4f}   {pvs}")
