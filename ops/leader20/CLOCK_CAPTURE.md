# Top20 fixed clock capture

User contract: entry evidence covers only the two minutes immediately before each
00/10/20/30/40/50 minute boundary. For 08:50, the trajectory is 08:48–08:50.
The first boundary book supplies the start price; the model receives exactly 24
ordered five-second intervals, not a rolling path gathered while it answers.

The preceding minute prepares sockets and depth snapshots and selects the latest
Binance USDT perpetual COIN rolling-24-hour Top20. This transport preparation is
not model evidence. Rankings remain fixed for the complete capture and decision.
The collector closes non-held candidate streams at the boundary. Holdings,
unsettled exposure and the existing BTC market sensor stay continuous.

At the boundary the existing observer starts one Top20 DeepSeek batch; each READY
symbol receives independent GPT judgment. BUY still needs the existing FINAL
RECHECK with a current execution quote. Both AI stages use the same fixed path.
WAIT/SKIP do not create another paid full batch in the same slot. Provider/ingest
latency means judgment and order completion are shortly after the nominal clock,
not guaranteed at its exact millisecond. All entry permission ends at boundary +
120 seconds; incomplete windows wait for the next slot. Existing position review,
native protection, sizing, account reconciliation and provider caps remain intact.

Candidate trajectory intervals fall from 1,200 per ten minutes (continuous Top10)
to 480 (Top20 × 24), a 60% reduction. Including the start-price seed gives 500 rows.
This excludes continuous holdings/BTC and does not imply lower model costs:
twenty symbols are now judged per batch under the existing provider caps.

The migration is disabled by default. The release workflow verifies the previous
production bundles, updates the existing collector image without resizing, deploys
both Edge bundles, checks downloaded sources, waits for pending entries to settle,
then enables the clock flag and Top20 together. No validation order is submitted.

Local verification includes real PostgreSQL fixed-cutoff, causality, membership,
duplicate claims, materialization expiry, role delegation and permission tests;
Node regression tests; Deno tests and both Edge type checks. Production boundary
observations must be recorded separately from these synthetic tests.

2026-09-28 local verification: 1,549 Node regression tests passed; the subsequently
added actual FINAL RECHECK fixed-window BUY/WAIT/SKIP test also passed (13 focused
clock checks including PostgreSQL steps). Deno: 1,055 tests and 13 steps passed;
executor/generator type checks passed. The opt-in migration was applied as
`20260928115811_leader20_clock_capture_top20`; its source filename is
`20260928114749_leader20_clock_capture_top20.sql`. Post-migration clock mode was
still disabled with watch_limit=10, and anonymous access to the new raw reader
and batch claim was denied. Activation is recorded by the release workflow.

Release baseline audit: executor v148 contains 81 files and generator v43 contains
15 files. The executor retains `leader20/batch-runtime.mjs` and `leader20/batch.mjs`
from `ee2d0b44c23ac8aa687dd19a5d142bb542071f49`; the generator has their later main
versions. All 96 downloaded files matched their recorded sources after CRLF/LF
normalization, including both explicitly pinned older executor files. No source
file is excluded from parity verification. Initial attempts stopped at this
pre-deployment comparison and did not activate the clock or replace the collector.
