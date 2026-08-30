#!/usr/bin/env python3
"""Immutable final TEST runner for exact candidates recorded in final-lock.json.

No selection or tuning occurs here. The runner loads only the sealed 2025-11-02..2026-01-01
window after a candidate payload + SHA256 has been committed to final-lock.json.
"""
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_r3 as loader
import run_r6 as model

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
LOCK=HERE/'final-lock.json'
OUT=HERE/'r3-final-test-result.json'
TS=datetime(2025,11,2,tzinfo=UTC); TE=datetime(2026,1,1,tzinfo=UTC)
base.CACHE=Path('v10-cache-final'); loader.base.CACHE=base.CACHE; model.base.CACHE=base.CACHE; model.r3.base.CACHE=base.CACHE
BY={c['key']:c for c in model.CANDS}


def canon(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(x): return hashlib.sha256(canon(x).encode()).hexdigest()


def main():
    lock=json.loads(LOCK.read_text())
    if lock.get('final_test_window')!=[TS.isoformat(),TE.isoformat()]: raise RuntimeError('lock test window mismatch')
    if lock.get('test_accessed_before_lock') is not False: raise RuntimeError('lock does not certify unopened test')
    specs=lock.get('lanes',{})
    if not specs: raise RuntimeError('no locked candidates')
    for lane,s in specs.items():
        if not s.get('pretest_validation_passed'): raise RuntimeError(f'{lane} pretest validation not certified')
        key=s['candidate_key']; c=BY.get(key)
        if c is None or c['lane']!=lane: raise RuntimeError(f'{lane} candidate mismatch')
        if c!=s['candidate']: raise RuntimeError(f'{lane} candidate payload mismatch')
        if sha(c)!=s['candidate_sha256']: raise RuntimeError(f'{lane} candidate hash mismatch')
    bars=loader.load_period(TS,TE); feats,indices=base.build_features(bars)
    results={}
    for lane,s in specs.items():
        c=BY[s['candidate_key']]
        y=model.period(c,TS,TE,bars,feats,indices); m=y['metrics']
        l=model.loo(c,TS,TE,bars,feats,indices)
        gates={
          'positive':m['stress_bps']>0,
          'pf':m['stress_pf']>=1.05,
          'sample':m['trades']>=8,
          'halves':m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0,
          'subwindows':y['positive_quarters']>=2,
          'asset_share':m['max_asset_exposure_share']<=.40,
          'loo':l['positive_share']>=.60 and l['median_mean_stress_bps']>0,
        }
        results[lane]={'candidate':c,'metrics':m,'subwindows':y['quarters'],
                       'positive_subwindows':y['positive_quarters'],'loo':l,
                       'gates':gates,'passed':all(gates.values())}
    out={'revision':'V10_R6_LOCKED_FINAL_TEST_20260830','test_accessed':True,
         'test_window':[TS.isoformat(),TE.isoformat()],'lock_sha256':sha(lock),
         'results':results,'all_locked_lanes_passed':all(x['passed'] for x in results.values())}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R6_FINAL_TEST_BEGIN'); print(json.dumps(out,ensure_ascii=False,sort_keys=True)); print('V10_R6_FINAL_TEST_END')

if __name__=='__main__': main()
