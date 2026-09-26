import json,statistics as st
R=json.load(open('data/replay.json'));P={p['pid']:p for p in json.load(open('data/positions.json'))}
keys=['return_5m','return_15m','return_60m','taker_buy_ratio_5m','buyer_share_change','accel_5m_vs_15m','minutes_since_high_60m','volume_ratio_5m_vs_60m','oi_change_5m','distance_high_60m']
for k in keys:
    d=[(r['v'][k],r['gptFacts'][k]) for r in R if r['gptFacts'] and r['v'].get(k) is not None and r['gptFacts'].get(k) is not None]
    diffs=[abs(a-b) for a,b in d]
    print(f"{k:26s} n={len(d)} median|diff|={st.median(diffs):.5f} p90={sorted(diffs)[int(.9*len(diffs))]:.5f}")
# sim vs realized for filled positions
rows=[]
for r in R:
    p=P.get(r['pos'])
    if p and p['out'] and p['strat']=='LEADER_MOMENTUM_V17':
        rows.append((r['sim']['ret']-0.001, p['xp']/p['ep']-1-0.001, r['sym'], p['why'], r['sim']['why']))
import math
print('n',len(rows),'corr',st.correlation([a for a,*_ in rows],[b for _,b,*_ in rows]),'sim mean',st.mean(a for a,*_ in rows),'real mean',st.mean(b for _,b,*_ in rows))
print('sign agreement',sum((a>0)==(b>0) for a,b,*_ in rows)/len(rows))
