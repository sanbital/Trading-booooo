# Trading-booooo v6.9.1 — FEE LEDGER INTEGRITY

Base: `6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION`

## Confirmed defect

Upbit supplied the exact aggregate `paid_fee`, but its individual `trades` omitted `fee`.
The prior code saw a non-empty trades array, summed zero per-fill fees, and never used the
positive aggregate fee. The result overstated realized PnL and contaminated online learning.

## Fixes

1. Centralized fee-source resolution in `fee-accounting.ts`.
2. Uses exact aggregate quote fee when per-fill fees are absent.
3. Allocates exact aggregate Upbit fee across fills by matched funds for auditability.
4. Binance order reconciliation now fetches `/api/v3/myTrades` so maker fills retain exact
   commission assets and amounts. If that detail endpoint is temporarily unavailable, the
   ledger records a conservative non-zero estimate instead of zero.
5. Preserves exact Binance quote fees, conservative third-asset estimates, and base-asset
   quantity accounting without double charging.
6. Repairs historical Upbit orders plus recoverable Binance commission rows, positions and PnL.
7. Rebuilds `lob_online_outcomes` and `lob_market_profiles` from corrected labels.
8. Adds regression tests using the confirmed KRW-EUL transaction.

## Confirmed economic correction

- Entry funds: `21,999.99998658 KRW`
- Exit funds: `22,002.03788389 KRW`
- Entry fee: `10.99999999329 KRW`
- Exit fee: `11.001018941945 KRW`
- Correct net PnL: `-19.963121625235 KRW`

## Unchanged

- Fixed 3-slot capital denominator
- Evidence-sized exploration
- Stops, targets and 180/300-second holding rails
- Spot-only and no-withdrawal/no-leverage invariants
- v6.8.1 residual accounting
- v6.9.0 canary governance
