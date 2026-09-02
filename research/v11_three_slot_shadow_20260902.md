# V11 three-slot shadow verification — 2026-09-02

Mode: **SHADOW_ONLY_NO_ORDERS**

Production-data verification run: `35b02913-24f7-4b72-b09f-cc7f865aacd3`

- Observer regime: `NEUTRAL`
- Routed lane: `RANGE`
- Stored Binance Futures available USDT: `119.35899779`
- Requested slot margin: `40.00 USDT`
- Cash buffer: `1.25 USDT`
- Full 40-USDT slot capacity after buffer: `2`
- Three 40-USDT slots feasible: `false`
- Three-slot recommended margin: `39.36 USDT` each
- Recommended total margin: `118.08 USDT`
- Leverage: `3x`
- Per-slot notional at 39.36 margin: `118.08 USDT`
- Candidate count: `6`
- Selected count: `3`

Selected shadow slots:

1. `FILUSDT` — RANGE — 39.36 USDT margin — 118.08 USDT notional
2. `UNIUSDT` — RANGE — 39.36 USDT margin — 118.08 USDT notional
3. `CRVUSDT` — RANGE — 39.36 USDT margin — 118.08 USDT notional

The harness writes only to `v11_three_slot_shadow_runs` and `v11_three_slot_shadow_positions`. It does not call the Binance order gateway, does not create `v11_long_regime_orders`, and does not alter live runtime/circuit state.

Live production remains on the single-open-position safety index and single-slot generator gate.