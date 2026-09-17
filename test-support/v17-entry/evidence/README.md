# 2026-09-17 entry-extinction evidence

`rejected-signals-20260917.json` is every non-stale REJECTED row written by
v10-lane-executor v48 between its deploy at `2026-09-16T23:09:24.323Z` and
`2026-09-17T13:05Z`, read from `public.v11_long_regime_signals` in the production
Supabase project `etaajwpernzrcdrifdnw`. Nothing is synthesised: `symbol`,
`reject_reason`, `created_at`, `updated_at` and the `features` fields are the
stored values.

`quantityStep` / `priceTick` come from `v11_long_regime_orders.request_payload`,
which the executor writes from the venue's own `symbol_info` response at dispatch
time, for the same symbol. Where a symbol has no such order on record the filter
is marked `"stepSource": "DERIVED"` and is recovered from the reject itself: the
recorded refusal figure pins `quantity x ask` exactly, and only one lot step in
{1, 0.1, 0.01, 0.001} reproduces it with an ask inside the 1% entry-drift band
the signal passed. The replay asserts that reproduction before drawing any
conclusion from a row, so a bad reconstruction fails the test rather than
flattering the fix.

`stale-timing-20260917.json` is the timing reconstruction for the
SIGNAL_STALE_OR_FUTURE rejections over the same window: bar close, row insert,
and the executor's terminal write.
