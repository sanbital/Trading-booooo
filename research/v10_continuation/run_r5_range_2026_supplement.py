#!/usr/bin/env python3
"""Fixed-candidate supplemental OOS confirmation for V10 RANGE.
The original final TEST verdict is immutable; this script only evaluates a new 2026 period.
"""
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_r3 as r3
import run_r4 as r4

UTC=timezone.utc
HERE=Path(__file__).resolve().parent
LOCK=HERE/'r5-range-2026-supplement-lock.json'
OUT=HERE/'r5-range-2026-supplement-result.json'
START=datetime(2026,1,1,tzinfo=UTC)
END=datetime(2026,8,1,tzinfo=UTC)
base.CACHE=Path('v10-cache-range-2026-supplement'); r3.base.CACHE=base.CACHE
BY={c['key']:c for c in r4.CANDS}

def canon(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(x): return hashlib.sha256(canon(x).encode()).hexdigest()

def main():
    lock=json.loads(LOCK.read_text())
    if lock['evaluation_window'] != [START.isoformat(),END.isoformat()]: raise RuntimeError('supplement window mismatch')
    if lock.get('parameter_mutation_allowed') is not False: raise RuntimeError('parameter mutation not prohibited')
    key=lock['locked_candidate_key']; c=BY.get(key)
    if c is None or c!=lock['candidate']: raise RuntimeError('candidate payload mismatch')
    if sha(c)!=lock['locked_candidate_sha256']: raise RuntimeError('candidate hash mismatch')
    bars=r3.load_period(START,END); feats,indices=base.build_features(bars)
    y=r4.period_eval(c,START,END,bars,feats,indices); m=y['metrics']; l=r4.loo(c,START,END,bars,feats,indices)
    gates={
      'positive':m['stress_bps']>0,
      'pf':m['stress_pf']>=1.05,
      'sample':m['trades']>=8,
      'halves':m['first_half_stress_bps']>0 and m['second_half_stress_bps']>0,
      'subwindows':y['positive_quarters']>=2,
      'asset_share':m['max_asset_exposure_share']<=.40,
      'loo':l['positive_share']>=.60 and l['median_mean_stress_bps']>0,
    }
    out={'revision':'V10_R5_RANGE_2026_SUPPLEMENT_20260830','candidate':c,'window':[START.isoformat(),END.isoformat()],
         'metrics':m,'positive_subwindows':y['positive_quarters'],'subwindows':y['quarters'],'loo':l,
         'gates':gates,'passed':all(gates.values()),
         'original_final_test_verdict_changed':False}
    OUT.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print('V10_R5_RANGE_2026_SUPPLEMENT_BEGIN');print(json.dumps(out,ensure_ascii=False,sort_keys=True));print('V10_R5_RANGE_2026_SUPPLEMENT_END')

if __name__=='__main__':main()
