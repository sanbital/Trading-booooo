# V10 regime-specific exit runtime cutover

Revision: `V10-LANES-EXIT-RUNTIME-1.0.0`  
Spec SHA256: `f6480355e2e0c987afe1af7a8b66dc61d5fd35b1fa165d1ad940f3b5b331741d`

## Policies

- **BULL** — 30% partial at +22.5% margin ROE; 70% continuation remainder; break-even floor plus 6.75% ROE high-water giveback; 12h risk backstop.
- **RANGE** — full exit when `current_bb_pos - entry_bb_pos >= 1.0`; alternatively arm full-position trail at +18% ROE with 0.75% ROE giveback; 6h risk backstop.
- **BEAR** — raw R8 state-recovery policy is retained for shadow evaluation only. It did not pass the final neighbourhood/plateau gate and cannot trade live.

`bb_pos` parity formula: `(close - SMA20) / (2 * stddev_samp(last 20 completed 15m closes))`.

## First deployment boundary

This revision is compile-time shadow-only. It can read open V10 positions, evaluate completed 15m bars, and append `is_shadow=true` decisions. It cannot submit, amend, cancel, or reconcile a Binance order. It does not change `trading_settings.mode`, clear `pause_new_entries`, close the V10 circuit, or enable any V10 lane live flag.
