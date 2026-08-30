#!/usr/bin/env python3
"""V10 R5: confirm the pre-locked RANGE candidate on the unused 2023 window.
No final TEST access and no candidate selection in this script.
"""
from __future__ import annotations
import json
from pathlib import Path

import run as base
import run_r3 as r3
import run_r4 as r4

HERE = Path(__file__).resolve().parent
LOCK = HERE / 'r5-range-lock.json'
OUT = HERE / 'r5-range-confirm-result.json'
base.CACHE = Path('v10-cache-r3')
r3.base.CACHE = base.CACHE


def main():
    lock = json.loads(LOCK.read_text())
    key = lock['candidate_key']
    assert lock['final_test_accessed'] is False
    matches = [c for c in r4.CANDS if c['key'] == key]
    assert len(matches) == 1, f'locked candidate not found: {key}'
    c = matches[0]
    assert all(c.get(k) == v for k, v in lock['candidate'].items())

    bars = r3.load_period(r3.D23S, r3.D23E)
    feats, indices = base.build_features(bars)
    confirmation = r4.holdout(c, bars, feats, indices)
    out = {
        'revision': 'V10_R5_RANGE_CONFIRM_20260830',
        'locked_candidate': key,
        'candidate': c,
        'confirmation': confirmation,
        'confirmed': bool(confirmation['passed']),
        'test_accessed': False,
        'final_test_window_untouched': lock['final_test_window'],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    print('V10_R5_RANGE_CONFIRM_BEGIN')
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    print('V10_R5_RANGE_CONFIRM_END')


if __name__ == '__main__':
    main()
