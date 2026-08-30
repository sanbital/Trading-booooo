#!/usr/bin/env python3
"""Final TEST runner. It only evaluates exact candidates recorded in final-lock.json."""
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_r3 as r3

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
LOCK=HERE/'final-lock.json'
OUT=HERE/'r3-final-test-result.json'
TS=datetime(2025,11,2,tzinfo=UTC); TE=datetime(2026,1,1,tzinfo=UTC)
base.CACHE=Path('v10-cache-final'); r3.base.CACHE=base.CACHE
BY={c['key']:c for c in r3.CANDS}


def canon(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(x): return hashlib.sha256(canon(x).encode()).hexdigest()


def main():
    lock=json.loads(LOCK.read_text())
    if lock.get('final_test_window')!=[TS.isoformat(),TE.isoformat()]: raise RuntimeError('lock test window mismatch')
    if lock.get('test_accessed_before_lock') is not False: raise RuntimeError('lock does not certify unopened test')
    specs=lock.get('lanes',{})
    if not specs: raise RuntimeError('no locked candidates')
    for lane,s in specs.items():
        if not s.get('independent_confirmation_passed'): raise RuntimeError(f'{lane} not independently confirmed')
        key=s['candidate_key']; c=BY.get(key)
        if c is None or c['lane']!=lane: raise RuntimeError(f'{lane} candidate mismatch')
        if c!=s['candidate']: raise RuntimeError(f'{lane} candidate payload mismatch')
        if sha(c)!=s['candidate_sha256']: raise RuntimeError(f'{lane} candidate hash mismatch')
    bars=r3.load_period(TS,TE); feats,indices=base.build_features(bars)
    results={}
    for lane,s in specs.items():
        c=BY[s['candidate_key']]
        y=r3.year_eval(c,TS,TE,bars,feats,indices); m=y['metrics']
        l=r3.loo(c,TS,TE,bars,feats,indices)
        fixed=c['family'] in ('BTC_FADE','INDEX_SHORT')
        gates={
          'positive':m['stress_bps']>0,
          'pf':m['stress_pf']>=1.05,
          'sample':m['trades']>=8,
          'halves':m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0,
          'subwindows':y['positive_quarters']>=2,
          'asset_share':fixed or m['max_asset_exposure_share']<=.40,
          'loo':(not l['applicable']) or (l['positive_share']>=.60 and l['median_mean_stress_bps']>0),
        }
        results[lane]={'candidate':c,'metrics':m,'subwindows':y['quarters'],'positive_subwindows':y['positive_quarters'],'loo':l,'gates':gates,'passed':all(gates.values())}
    out={'revision':'V10_R3_FINAL_TEST_20260830','test_accessed':True,'test_window':[TS.isoformat(),TE.isoformat()],
         'lock_sha256':sha(lock),'results':results,'all_locked_lanes_passed':all(x['passed'] for x in results.values())}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R3_FINAL_TEST_BEGIN'); print(json.dumps(out,ensure_ascii=False,sort_keys=True)); print('V10_R3_FINAL_TEST_END')

if __name__=='__main__': main()
