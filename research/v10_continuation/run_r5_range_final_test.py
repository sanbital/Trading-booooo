#!/usr/bin/env python3
"""Immutable final TEST runner for the pre-locked V10 R5 RANGE candidate.
No candidate selection or threshold mutation occurs here.
"""
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from pathlib import Path

import run as base
import run_r3 as r3
import run_r4 as r4

UTC = timezone.utc
HERE = Path(__file__).resolve().parent
LOCK = HERE / 'final-lock-r5-range.json'
OUT = HERE / 'r5-range-final-test-result.json'
TS = datetime(2025, 11, 2, tzinfo=UTC)
TE = datetime(2026, 1, 1, tzinfo=UTC)
base.CACHE = Path('v10-cache-final-r5')
r3.base.CACHE = base.CACHE
BY = {c['key']: c for c in r4.CANDS}


def canon(x):
    return json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha(x):
    return hashlib.sha256(canon(x).encode()).hexdigest()


def main():
    lock = json.loads(LOCK.read_text())
    if lock.get('test_accessed_before_lock') is not False:
        raise RuntimeError('final TEST was not certified sealed before lock')
    if lock.get('final_test_window') != [TS.isoformat(), TE.isoformat()]:
        raise RuntimeError('final TEST window mismatch')
    if not lock.get('independent_confirmation_passed'):
        raise RuntimeError('candidate lacks independent confirmation')
    key = lock['candidate_key']
    c = BY.get(key)
    if c is None or c != lock['candidate']:
        raise RuntimeError('locked candidate payload mismatch')
    if sha(c) != lock['candidate_sha256']:
        raise RuntimeError('locked candidate hash mismatch')

    bars = r3.load_period(TS, TE)
    feats, indices = base.build_features(bars)
    y = r4.period_eval(c, TS, TE, bars, feats, indices)
    m = y['metrics']
    l = r4.loo(c, TS, TE, bars, feats, indices)
    gates = {
        'positive': m['stress_bps'] > 0,
        'pf': m['stress_pf'] >= 1.05,
        'sample': m['trades'] >= 8,
        'halves': m['first_half_stress_bps'] > 0 and m['second_half_stress_bps'] > 0,
        'subwindows': y['positive_quarters'] >= 2,
        'asset_share': m['max_asset_exposure_share'] <= 0.40,
        'loo': l['positive_share'] >= 0.60 and l['median_mean_stress_bps'] > 0,
    }
    out = {
        'revision': 'V10_R5_RANGE_FINAL_TEST_20260830',
        'test_accessed': True,
        'test_window': [TS.isoformat(), TE.isoformat()],
        'lock_sha256': sha(lock),
        'candidate': c,
        'metrics': m,
        'positive_subwindows': y['positive_quarters'],
        'subwindows': y['quarters'],
        'loo': l,
        'gates': gates,
        'passed': all(gates.values()),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    print('V10_R5_RANGE_FINAL_TEST_BEGIN')
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    print('V10_R5_RANGE_FINAL_TEST_END')


if __name__ == '__main__':
    main()
