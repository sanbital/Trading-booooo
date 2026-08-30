# V10-H Cross-Venue Forward Collector Deployment

Deployment date: 2026-08-30 UTC
Mode: `NO_CAPITAL`

## Deployed research infrastructure

- Supabase Edge Function: `v10-crossvenue-forward-collector`
- Edge Function version: 1
- Edge bundle SHA-256: `31b0e3e14c5548c4985a4ddff180b3adc7f7d42bc989636960aa63e73fa4d019`
- Collector revision: `V10_CROSSVENUE_FORWARD_COLLECTOR_R1`
- Feature revision: `V10_CROSSVENUE_POINT_IN_TIME_V1`
- Universe revision: `V10_CROSSVENUE_STABLE_7_V1`
- Fixed assets: BTC, ETH, SOL, XRP, DOGE, ADA, LINK
- Venues: Binance USD-M and Upbit KRW
- Structural model: `MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET`
- Production-order/capital effect: NONE

Persisted tables are isolated from the existing Binance-only V10 collector:
- `v10_crossvenue_forward_collection_runs`
- `v10_crossvenue_forward_snapshots`
- `v10_crossvenue_forward_collection_errors`

Writes are through service-role-only `record_v10_crossvenue_forward_collection(...)`; anon/authenticated table privileges are revoked and RLS is enabled.

## Scheduler

- Supabase cron job id: 32
- Job name: `v10-crossvenue-forward-collector`
- Schedule: every minute
- The collector token was rotated after manual verification; cron reads the current server-side token at invocation time.

## Verification

1. Manual no-capital invocation
   - observation bucket: `2026-08-30T07:47:00Z`
   - status: COMPLETE
   - symbols: 7/7
   - errors: 0
   - duration: 1149 ms

2. First post-rotation cron invocation
   - observation bucket: `2026-08-30T07:50:00Z`
   - status: COMPLETE
   - symbols: 7/7
   - errors: 0
   - duration: 1287 ms

## Source semantics

The collector simultaneously captures:
- Binance USD-M 15-level order book and 60-second aggregate-trade flow
- Upbit KRW 15-level order book and 60-second recent-trade flow
- venue-local spread, 5-level imbalance, microprice displacement, signed 60-second return, trade-sign imbalance, and trade count
- cross-venue flow spread, return spread, and book spread
- source receipt times, source event times, feature cutoff, and feature availability time

Upbit `BID` is treated as aggressive buy and `ASK` as aggressive sell. Raw low-trade observations are retained. For cross-venue candidate evaluation, Upbit trade count < 5 is a preregistered `NO_SIGNAL` data-quality state rather than a synthetic zero-flow observation.

## Research state

Cross-venue candidates H-G/H-H were preregistered before outcome evaluation. No promotion decision has been made from the initial collector samples.
