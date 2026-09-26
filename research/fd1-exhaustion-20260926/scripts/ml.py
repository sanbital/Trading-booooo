from models import *
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Ridge
F=['return_1m','return_5m','return_15m','return_30m','return_60m','return_4h','day_return','accel_5m_vs_15m','accel_15m_vs_60m','distance_high_60m','minutes_since_high_60m','distance_high_4h','distance_low_15m','distance_sma20','last_body','last_upper_wick','volume_ratio_5m_vs_60m','taker_buy_ratio_5m','taker_buy_ratio_15m','taker_buy_ratio_60m','buyer_share_change','btc_return_15m','btc_return_60m','relative_strength_15m','relative_strength_60m','signal_rank','oi_change_5m','oi_change_60m']
def X(rs): return np.array([[ (r['v'].get(k) if r['v'].get(k) is not None else 0) for k in F]+[r['nax']] for r in rs])
tr=[r for r in R if r['path']=='LEGACY'];te=[r for r in R if r['path']!='LEGACY']
ytr=np.array([r['net'] for r in tr]);yte=np.array([r['net'] for r in te])
for name,m in [('ridge',Ridge(alpha=10)),('gbr',GradientBoostingRegressor(n_estimators=150,max_depth=2,learning_rate=.05,subsample=.7,random_state=0))]:
    m.fit(X(tr),ytr);p=m.predict(X(te))
    q=np.quantile(p,[.2,.4,.6,.8])
    print(name,'OOS corr',round(np.corrcoef(p,yte)[0,1],3))
    for i,(lo,hi) in enumerate(zip([-1e9,*q],[*q,1e9])):
        s=(p>=lo)&(p<hi);print(f'   quintile {i+1}: n={s.sum()} avg net={yte[s].mean():.2f} lowMFE={np.mean([te[j]["lowmfe"] for j in np.where(s)[0]]):.2%}')
# reverse: train current, test legacy
m=GradientBoostingRegressor(n_estimators=150,max_depth=2,learning_rate=.05,subsample=.7,random_state=0).fit(X(te),yte);p=m.predict(X(tr))
print('reverse gbr OOS corr',round(np.corrcoef(p,ytr)[0,1],3))
# classification of low-MFE failures (the specific symptom)
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import roc_auc_score
c=GradientBoostingClassifier(n_estimators=150,max_depth=2,learning_rate=.05,subsample=.7,random_state=0).fit(X(tr),[r['lowmfe'] for r in tr])
print('lowMFE AUC OOS',round(roc_auc_score([r['lowmfe'] for r in te],c.predict_proba(X(te))[:,1]),3))
imp=sorted(zip(c.feature_importances_,F+['nax']),reverse=True)[:8];print(imp)
