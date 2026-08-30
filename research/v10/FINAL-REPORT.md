# V10 final research, deployment, and verification report

Completed 2026-08-30. Research decision frozen at 03:41 UTC; production cutover and
post-cutover reconciliation completed before the 15:00 KST deadline.

## Executive decision

V10 found **no statistically defensible new RANGE or BEAR edge**. All 24 preregistered
configurations across 12 independent economic families failed rolling validation, and
every family lost money even under the BASE cost model. In accordance with the frozen
protocol, no candidate was locked and the final 2025-11-02 through 2026-01-01 TEST was
never downloaded or accessed.

The production decision is therefore deliberate abstention:

- preserve and re-enable the existing validated I46/P10 BULL LONG lane;
- route RANGE/NEUTRAL, BEAR/RISK_OFF, every SHORT request, stale state, and resolver
  errors to CASH/BLOCK;
- do not deploy a merely “best” negative candidate;
- repair the live claim path, remove fail-open behavior, restrict legacy resolvers, and
  verify the live claim/block path plus downstream source wiring without submitting an
  order.

This is a live production decision, not a shadow recommendation. The active DB router is
`P10-PRODUCTION-REGIME-ROUTER-V10`, registry revision is
`V10-CANDIDATE-LOCK-NO-VALIDATION-EDGE-20260830`, and validation status is
`REJECTED_NO_ROBUST_EDGE`.

## A. What V10 tested

### Independent lineage and validation

- Revision: `REGIME_ROUTER_V10_INDEPENDENT_RANGE_BEAR_15M_365D_20260830`.
- Discovery cutoff: `[2025-01-01, 2025-10-08)`; V9 was read only as historical
  evidence and its TEST results were not used for selection.
- Universe: 21 overlapping Binance USD-M and Upbit KRW assets at 15-minute frequency.
- Four chronological walk-forward folds with 120-day TRAIN and a 40-day validation span
  whose first 16 bars (four hours) were embargoed; no time-series shuffle.
- Executable decisions at next-bar open, STOP_FIRST intrabar convention, ATR bracket,
  maximum 16-bar hold, at most three positions, and duplicate positions forbidden.
- Round-trip costs: 14 bps BASE and 23 bps STRESS for each executable Binance position
  (entry plus exit). Cross-exchange observations were predictive features, not a claim
  that an Upbit hedge could be executed from this infrastructure. No hedged two-leg
  candidate reached the frozen executable universe, so V10 does not report a synthetic
  two-leg result without its extra fees, sizing, and fill risk.
- Frozen family-wise eligibility gates covered trade and signal-day minimums, at least
  three positive stress folds, minimum stress profit factor and mean stress return per
  trade, maximum single-market trade share, and a positive preregistered neighbor.
- Drawdown, downside tails, top-winner removal, and half-sample stability were mandatory
  fragility diagnostics and selection evidence, but were not mislabeled as hard gate
  booleans.

### Data and point-in-time controls

- Binance: 210/210 official monthly 15-minute USD-M archives; all official checksum,
  ZIP CRC, timestamp-boundary, and 15-minute continuity checks passed. The 612,864
  physical rows were filtered at the frozen cutoff before features or forward returns.
- Upbit: exact observed KRW 15-minute candles for 21 markets, paginated with exclusive
  timestamps. Missing no-trade candles were not forward-filled; OP's real shorter
  listing history remained missing.
- Causal features used completed candles only. Cross-exchange observations were aligned
  at or before the Binance decision timestamp; no future regime or candle high/low was
  used in entry features.
- Historical L2/microprice, complete point-in-time OI, and complete funding history were
  not available for the frozen window through practical public retention paths. V10 did
  not fabricate or backfill them from current snapshots. Those mechanisms were assessed
  from current exchange documentation and research but excluded from statistical claims.
- Historical-universe reconstruction is limited to the selected overlap set and each
  asset's observed listing history. This is documented survivorship scope, not a claim of
  a complete delisted-asset universe.

Data manifest hashes:

| Dataset | Manifest SHA-256 |
|---|---|
| Binance archives | `e806f181951d3ced630fdf789456823073d91ef7880fd540acb74e878e987754` |
| Upbit exact JSONL | `03e09e693a13bf0c58e70a9e61731ea64ab12351f0d735d74a9c75e8eaa4d357` |
| Primary runner 231-file snapshot | `3974eb88c0d771b91ffb9d0e2a6950e1c8d9cb2dbbf756fe4afe2ed99c9b4b1e` |
| Independent replay 231-file snapshot | `b505a83805dfae3a28997cd98016c834db8c2e3fbf9056b009952c83247516fc` |

### Hypothesis breadth

V10 tested two frozen neighboring configurations for each of these 12 mechanisms:

1. Upbit lead continuation;
2. Upbit/Binance divergence convergence;
3. Korean volume-shock transmission;
4. Korean residual cross-sectional rank;
5. cross-exchange breadth;
6. Binance/Upbit aggressive-flow disagreement;
7. Korean-flow volatility breakout;
8. KST intraday transmission;
9. RANGE VWAP/ATR reversal;
10. BEAR rebound-failure SHORT;
11. BEAR capitulation-recovery LONG;
12. Binance BTC/ETH beta-residual continuation.

These families were derived from current Binance and Upbit API/stream capabilities plus
public microstructure, cross-exchange, and online-selection research. ML was not used as
a rescue step: four fold-level rewards and no positive base family do not justify a
contextual selector without severe overfitting risk.

## B. What failed

The table reports the best frozen configuration within each family, not an optimized
post-hoc winner. Returns are four-fold validation aggregates. BASE/STRESS include 14/23
bps round-trip costs.

| Family | Best config | Trades | Signal days | Win | BASE bps | STRESS bps | Stress PF | Positive folds | Stress DD bps | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Flow disagreement | `V10_FLOW_DISAGREEMENT_B` | 23 | 19 | 39.13% | -494.69 | -701.69 | 0.413 | 1/4 | -735.13 | Reject: sparse, negative, neighbor/gates fail |
| BEAR capitulation LONG | `V10_BEAR_CAPITULATION_RECOVERY_B` | 114 | 37 | 42.98% | -633.68 | -1,659.68 | 0.736 | 1/4 | -2,573.42 | Reject: three folds negative, unstable |
| Korean volume shock | `V10_KOREAN_VOLUME_SHOCK_B` | 350 | 102 | 38.57% | -7,687.44 | -10,837.44 | 0.516 | 0/4 | -10,896.25 | Reject |
| Korean-flow vol breakout | `V10_KOREAN_FLOW_VOL_BREAKOUT_B` | 534 | 105 | 41.20% | -8,249.01 | -13,055.01 | 0.483 | 0/4 | -13,055.01 | Reject |
| BEAR rebound SHORT | `V10_BEAR_REBOUND_FAILURE_B` | 756 | 75 | 41.14% | -12,332.07 | -19,136.07 | 0.563 | 0/4 | -19,136.07 | Reject |
| KST transmission | `V10_INTRADAY_KST_TRANSMISSION_A` | 931 | 113 | 39.10% | -17,801.08 | -26,180.08 | 0.460 | 0/4 | -26,311.65 | Reject |
| RANGE VWAP reversal | `V10_RANGE_VWAP_REVERSAL_B` | 1,557 | 129 | 37.51% | -31,155.84 | -45,168.84 | 0.468 | 0/4 | -45,566.85 | Reject |
| Upbit lead | `V10_UPBIT_LEAD_A` | 1,832 | 140 | 39.41% | -36,065.75 | -52,553.75 | 0.474 | 0/4 | -52,574.03 | Reject |
| Cross-exchange breadth | `V10_CROSS_EXCHANGE_BREADTH_B` | 2,317 | 142 | 39.92% | -36,327.12 | -57,180.12 | 0.487 | 0/4 | -57,244.37 | Reject |
| Divergence convergence | `V10_DIVERGENCE_CONVERGENCE_B` | 2,496 | 142 | 40.06% | -44,401.47 | -66,865.47 | 0.562 | 0/4 | -66,865.47 | Reject |
| Korean residual rank | `V10_KOREAN_RESIDUAL_RANK_B` | 3,162 | 144 | 38.55% | -63,096.83 | -91,554.83 | 0.524 | 0/4 | -91,554.83 | Reject |
| BTC/ETH beta residual | `V10_BINANCE_BETA_RESIDUAL_B` | 3,585 | 144 | 40.78% | -64,295.64 | -96,560.64 | 0.594 | 0/4 | -96,798.95 | Reject |

Every family was already negative at BASE cost, so rejection does not depend on the
additional 9 bps stress increment. Full machine-readable results include gross/base/
stress return, expected return, win/PF/drawdown/tails, MAE/MFE, turnover, exposure,
market/month/fold/regime/tactical breakdowns, concentration checks, top-winner removal,
half stability, and all frozen gate booleans.

An independently written replay agreed on eligibility and positive-fold classification
for 24/24 configurations. It matched all compared metrics exactly for 13/24. Five
configurations had small trade-count differences (-1, +3, -15, +1, -1), and the maximum
stress-P&L difference was 2,235.47 bps; both implementations remained decisively
negative and no promotion decision changed. This residual implementation variance is
recorded rather than hidden.

## C. What survived

### New RANGE/BEAR candidates

None. Candidate set `[]`; candidate is `null`; final TEST access timestamp is `null`.

The candidate-lock SHA-256 is
`d7da8d3e6703b2981f174d09e8b900f0753638ee7ed0296111a444455c9a6554`.
The discovery-results embedded SHA-256 is
`b1b0c1c9d376a2e223545ef5c56395d8e960c7272daa4b641bc031c07fada51f`.

Not opening TEST is the frozen protocol's required terminal outcome when no validation
candidate exists. Opening it “for completeness” would contaminate the only untouched
window and turn a rejection into test fitting.

### Preserved existing BULL lane

V10 did not reselect the historical I46/P10 BULL LONG model. It preserved it because the
mission explicitly protected that lane and the production ledger shows positive executed
evidence:

| Venue | Side | Closed trades | Wins | Position-ledger fee-net quote P&L | Mean realized return | Worst | Best |
|---|---|---:|---:|---:|---:|---:|---:|
| Binance spot | LONG | 3 | 3 | +8.456463 | +7.129049% | +0.355972% | +14.077364% |
| Binance futures | LONG | 41 | 17 | +354.462306 | +5.852108% | -14.017055% | +45.258540% |
| Combined | LONG | 44 | 20 | +362.918769 | — | — | — |

Chronological closed-trade LONG drawdown was -57.111290 quote. By contrast, the
existing futures SHORT history was 10 trades, 3 wins, -11.183806 quote, so it was not
treated as a proven lane. These August 2026 live outcomes are execution evidence, not a
substitute for independent backtest validation. The position ledger accounts for
recorded fills and fees; historical futures funding was not reconstructed, so this is not
full account-equity P&L.

The preserved production exit remains: 2 ATR stop, 40% partial at 2R, 5R target,
breakeven at 1.5R, 2.5 ATR trail, EMA/loss timeout, and 96-hour maximum hold.

## D. Final production router

Structural regime and tactical state remain independently persisted and evaluated.

| Structural regime | Tactical state | Strategy | Side | Live status |
|---|---|---|---|---|
| `STRONG_BULL` / `BULL` | accelerating / impulse | `P10_DONCHIAN_BREAKOUT_E10_SLOW_4R` via `BULL_TREND` | LONG | ENABLED, existing edge |
| `STRONG_BULL` / `BULL` | other causal Bull phases | same strategy via `BULL_DECELERATING` | LONG | ENABLED, existing edge |
| `RANGE` / `NEUTRAL` | any | CASH | NONE | LIVE NO TRADE |
| `BEAR` / `RISK_OFF` | rebound / capitulation | CASH | NONE | LIVE NO TRADE |
| `BEAR` / `RISK_OFF` | rebreak / continuation | CASH | NONE | LIVE NO TRADE |
| any | any SHORT request | CASH | NONE | LIVE BLOCK |
| stale / unknown / observer error | any | CASH | NONE | LIVE FAIL CLOSED |

The V10 route requires an exact persisted signal/run attestation, a fresh causal observer
state, and exact strategy/revision agreement. The end-to-end executor and DB guards
separately enforce side/mode, duplicate and cross-asset exposure, book/spread/depth,
capital, leverage, exchange filters, pause/emergency, and global suspension controls. The
claim no longer permits the previous LONG fail-open path on resolver exceptions.

## E. Portfolio improvement

The candidate-selection comparison is a **marginal router replay**, against the intended
production baseline of existing BULL LONG plus CASH in non-BULL regimes. Because V10
locked no new candidate, the marginal non-BULL action set is empty by construction; this
is not presented as a signal-level Bull replay or a new absolute Bull walk-forward
backtest.

| Portfolio metric | Intended baseline | V10 router | Increment |
|---|---:|---:|---:|
| BULL lane definition | Existing I46/P10 LONG | Preserved | 0 |
| RANGE contribution | 0 / CASH | 0 / CASH | 0 |
| BEAR contribution | 0 / CASH | 0 / CASH | 0 |
| New-lane BASE P&L | 0 | 0 | 0 |
| New-lane STRESS P&L | 0 | 0 | 0 |
| Marginal drawdown | 0 | 0 | 0 |
| Added turnover / conflict | 0 | 0 | 0 |

V10 therefore makes no unsupported claim of incremental alpha. Its economic value is
avoided negative expectancy: promoting even the least-negative new family would have
added -701.69 stress bps over 23 validation trades before sizing.

For absolute operational context, the historical closed live P10 BULL LONG ledger was
replayed with a cost overlay. “BASE/STRESS overlay” keeps recorded fills and slippage,
adds back recorded fees, then substitutes 14/23 bps of persisted entry-notional proxy.
Historical futures funding was not reconstructed. This is context from positions that
predate V10, not an OOS study or a claim that all 44 signals would have passed V10:

| Historical live-ledger metric | Context only |
|---|---:|
| Closed BULL LONG trades | 44 |
| Position-ledger fee-net quote P&L | +362.918769 |
| BASE overlay quote P&L | +357.344903 |
| STRESS overlay quote P&L | +348.065562 |
| Fee-net / STRESS max DD | -57.111290 / -60.792059 |
| Entry-notional turnover proxy | 10,310.379830 quote |
| Trade frequency over 6.85-day ledger span | 6.43/day |
| Position exposure | 287.49 hours; 1.75 average concurrent |

Only the separately identified ORDIUSDT historical signal was replayed through the exact
V10 resolver. The 44-trade ledger demonstrates that the preserved strategy has reached
real order/fill/exit handling; it does not constitute signal-level V10 counterfactual
parity.

A percentage capital-utilization replay cannot be reconstructed honestly because the
point-in-time wallet-equity series was not retained with the closed-position ledger. The
1.75 average concurrent-position exposure is reported as the available utilization
proxy rather than inventing a denominator.

Operationally, the actual pre-cutover database was not the intended baseline: an
out-of-band global entry suspension and old resolver drift had disabled Bull eligibility.
The cutover restored the intended BULL lane while leaving every unvalidated non-BULL
lane at CASH. That operational restoration is real, but it is not reported as backtest
profit improvement.

## F. Deployment and verification

### Source and database revisions

| Artifact | Revision / checksum |
|---|---|
| Frozen V10 research commit | `ca515e391382669fa6c3724f6a3a6e1207d2ad64` |
| Base V10 production commit | `0e37d82262c813a1de3e91dd7cbce85c3b20aa76` |
| Legacy ACL finalization commit | `54f4b80479a4531fac6d8569c3c8833b124259e4` |
| Claim-drift reconciliation source commit | `b0a9965bf0896d71d41fadd90348651e17bb5c21` |
| Candidate registry hash | `d7da8d3e6703b2981f174d09e8b900f0753638ee7ed0296111a444455c9a6554` |
| Base router migration implementation SHA-256 | `06c338e0831517f9ef980adfde3ebc26192696adde848177164239bdc7b0b454` |
| ACL migration implementation SHA-256 | `00e01bcec89f659a379119dffacb72525e5f1e0a9bd07f6feecc0d218e1aa0a8` |
| Reconciliation migration implementation SHA-256 | `703903378a6174dcc533caf780044cd68868c1ac899f1409fde2227f83dd026b` |

Applied Supabase migrations:

- `20260830035405_v10_production_regime_router_fail_closed` at 03:54:06 UTC;
- `20260830035723_v10_legacy_resolver_acl_finalization` at 03:57:23 UTC;
- `20260830040404_v10_claim_drift_reconciliation` at 04:04:04 UTC.

### Actual live call chain

The audited production path is:

`market scan -> signal/run persistence -> side/mode/duplicate/cross-asset checks ->
live book/spread/depth and symbol/capital/leverage/quantity checks -> claim_p10_signal()
-> resolve_p10_production_regime_route_v10() -> persisted-attestation and regime/tactical
route -> position insert with pause/emergency guards -> createOrderRecord with global
suspension guard -> Binance gateway -> fill/position monitor -> preserved P10 exit
manager`.

The post-cutover smoke exercised the chain only through the V10 claim/block decision.
Static source and DB-trigger inspection established the downstream ordering; historical
executed P10 positions supply separate order/fill/exit evidence. Because the current
regime was correctly blocked, the smoke did not invoke Binance order construction,
submit an order, produce a fill, or exercise an exit.

Function-definition hashes after reconciliation:

| Function | Canonical MD5 |
|---|---|
| V10 resolver | `f31c901351c186c52c4e08ba206a6600` |
| persisted-attestation verifier | `66978b605759c8b874fbb82c34ff8826` |
| live wrapper | `5a895ceb7ce3906c3754db24ff83a3bd` |
| `claim_p10_signal()` | `e1b02f1e26fa09ea608ce423f32ccc17` |

The live claim contains V10 and no V3 or FAIL_OPEN call. V3/V4 execution is revoked from
`service_role`, `anon`, `authenticated`, and `public`; the V10 resolver, wrapper, and
claim are service-only. V10 manifest and cutover tables have RLS enabled with no app
policies and explicit app-role ACL removal.

### Drift incident and durable correction

At 03:56 UTC, a concurrent unrelated migration redefined the wrapper and claim back to
the V3/fail-open bodies after the first V10 cutover. The immutable cutover hashes detected
the mismatch. V10 then:

1. finalized legacy-resolver ACLs;
2. restored exact canonical V10 wrapper/claim definitions;
3. recorded an append-only reconciliation audit;
4. added a CI tripwire that fails if any later migration redefines the claim after the
   V10 reconciliation migration.

The incident is evidence that registry rows alone are insufficient; the final decision
is based on the actual claim body and executable grants.

### Edge revisions and smoke results

No Edge source edit was required because the strategy key, claim contract, order
constructor, and exit key remained compatible. Active revisions after the DB cutover:

| Edge Function | Active revision | Source SHA-256 |
|---|---:|---|
| `market-autotrader` | v408 | `bc059b10eab068a0d60dca02e0066bfc40aee1fccdd0552797ac120236b25a67` |
| `market-regime-observer` | v55 | `ebea76c26b5ef97e19c68706822d589ff8b5ff50391c89dc7f5ed352a74e0ab4` |
| `market-v2-signal` | v47 | `71f77bf3114d21853f5accff65d33e56e619b8611db50e435bb14f7c0f4bf32d` |

- Historical causal BULL dry replay: run
  `9c63b83d-ebe5-478d-b554-251606a20c44`, ORDIUSDT LONG, resolved PASS through V10 as
  `BULL_DECELERATING`, exact attestation true.
- Actual live claim smoke: run `76401353-1172-424d-9021-c23daefe4594`, UNIUSDT LONG.
  The current structural state was NEUTRAL; `claim_p10_signal()` returned
  `claimed=false`, `blocked=true`, reason `RANGE_NO_TRADE_NO_LOCKED_V10_EDGE`, with exact
  persisted attestation and V10 revision.
- The live smoke produced one auditable gate attempt and **zero claims, zero positions,
  and zero orders**. This verified claim/block routing without risking capital; it is not
  described as a post-cutover exchange-order smoke.
- Post-reconciliation Edge logs sampled 92/92 autotrader requests and the observer
  request at HTTP 200, with no sampled non-2xx response.
- Local production parity and security suite: 15/15 Deno tests passed, including exact
  migration hashes, live function-definition parity, the post-V10 redefinition tripwire,
  and static signal-to-order call-chain checks.
- Final 04:21 UTC checkpoint, after unrelated migrations through
  `20260830041628_mf_test2_result_and_live_collection`: `LIVE_LIMITED`, new entries
  unpaused, emergency liquidation false, Binance spot/futures enabled and trade-ready,
  futures sizing 40 USDT margin at 3x, maximum three new entries per scan,
  cross-exchange same-asset suppression enabled, zero active positions, and zero claims
  or orders since the smoke timestamp. The exact four function hashes and ACLs still
  matched; the most recent live RANGE attempt remained an audited V10 BLOCK.

### Remaining limitations and safety boundary

- `service_role` remains the trusted producer/observer root and can write the ledgers
  needed for routing. App roles cannot. Compromise of that credential is therefore a
  root-risk boundary, not something a database row signature alone can solve.
- Supabase advisors report no V10-specific ERROR. They do report pre-existing unrelated
  public-schema RLS, security-definer, mutable-search-path, foreign-key-index, and auth
  policy issues elsewhere. Those were not blanket-edited during this deadline-sensitive
  router cutover.
- No capital was allocated to new RANGE/BEAR research. Any future promotion must begin a
  genuinely independent lineage and must not tune against V10's untouched final TEST.
- The fixed research cost model did not explicitly simulate partial/failed fills,
  nonlinear market impact, or per-symbol filter rejection. The production executor does
  enforce live spread/depth, tick/step, minimum-notional, capital, and FOK/IOC rules, but
  that does not retroactively turn the research model into a fill simulator.

## Research and API sources

- Binance public archive and integrity model:
  <https://github.com/binance/binance-public-data>
- Binance Spot REST and WebSocket specifications:
  <https://developers.binance.com/en/docs/products/spot/rest-api> and
  <https://developers.binance.com/en/docs/products/spot/web-socket-streams>
- Binance USD-M Futures REST and WebSocket specifications:
  <https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data>
  and
  <https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect>
- Upbit market-data, candle, WebSocket, and rate-limit specifications:
  <https://docs.upbit.com/kr>,
  <https://global-docs.upbit.com/reference/list-candles-minutes>,
  <https://docs.upbit.com/kr/reference/websocket-guide>, and
  <https://docs.upbit.com/kr/reference/rate-limits>
- Order-flow imbalance mechanism: Cont, Kukanov, and Stoikov,
  <https://arxiv.org/abs/1011.6402>
- Microprice mechanism: Stoikov,
  <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2970694>
- Cross-exchange price discovery: Makarov and Schoar,
  <https://www.aeaweb.org/articles?id=10.1257%2Fpandp.20191020>
- Contextual online selection reference: Li et al.,
  <https://arxiv.org/abs/1003.0146>

## Reproducibility map

- `preregistration.json`: immutable windows, targets, costs, gates, and test policy.
- `candidate-universe.json`: all 24 frozen configurations.
- `run.py`: primary discovery runner.
- `discovery-results.json`: full candidate/fold/breakdown metrics.
- `candidate-lock.json`: empty lock and untouched-TEST record.
- `independent_replay.py` / `independent-replay.json`: independent decision replay.
- `DATA-INTEGRITY.md`: archive and exact-candle validation.
- `PRODUCTION-BASELINE.md`: pre-cutover execution and drift snapshot.
- `portfolio-ledger-replay.sql`: reproducible closed-live-ledger BASE/STRESS overlay and
  exposure metrics used in section E.
- `supabase/migrations/20260830054000_v10_production_regime_router_fail_closed.sql`:
  base V10 cutover.
- `supabase/migrations/20260830055500_v10_legacy_resolver_acl_finalization.sql`:
  executable-grant finalization.
- `supabase/migrations/20260830060500_v10_claim_drift_reconciliation.sql`:
  canonical claim restore and CI tripwire.
- `supabase/functions/market-autotrader/p10-regime-router-v10.test.ts`:
  exact production parity/security checks.

**Final state:** BULL LONG preserved and live; RANGE and BEAR explicitly CASH; no new
SHORT; claim path V10-only and fail-closed; live claim/block smoke verified; downstream
order path statically audited and supported by historical P10 execution evidence; full
research, candidate-lock, implementation, migration, and reconciliation lineage retained.
