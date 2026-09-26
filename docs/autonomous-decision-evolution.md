# Autonomous decision evolution

`SELF_EVOLUTION_1` adds an isolated research worker and a versioned, data-only interpretation policy to the existing production decision path. It does not train model weights or rewrite source code. The model registry initially contains the two already deployed models.

## Authority and preserved baseline

Initial audit: main `bcdc3b2`, executor v101. During implementation main advanced to `d89c55f` and the deployed executor to v104 (`48a2657336b7ecb5b47aab79d79f2d48357e8522b367c6b41d6fadcfbe03f6a1`). PRs 192–197 and the production-only v105 emergency-validation/native-stop ratchet hotfixes were reconciled. Executor v106 adds only the policy reader and two intelligence integrations over that v105 bundle. The operator explicitly selected preservation of PR193 resident profit protection and the DeepSeek emergency exit exception; these fixed execution mechanisms are outside policy evolution. Ordinary strategy arbitration remains GPT FIRST + independent DeepSeek, followed by refreshed GPT FINAL.

The frozen comparison account is 332.01243023 USDT, slot margin 150 USDT, leverage 3, MAX_SLOTS 10, with available-capital competition. Commission is 0.0005 per side, observed in 500 recent fills. These are research inputs, not writes to trading settings. No AI confidence affects quantity. No research code has an order, withdrawal, transfer, credential-management or source-deployment operation.

## Closed loop

The minute scheduler archives the production journal and observed micro buckets, attaches position generation IDs, and leases one durable research job. Closed trades receive independent parallel GPT/DeepSeek retrospectives, then parallel reciprocal critiques. Actual fills and observed outcomes outrank interpretations. Successes and failures both enter structured patterns. Hypothesis proposals are independent and cross-critiqued; a frozen challenger is generated only inside the schema allowlist.

The worker runs public Binance universe scans through the existing production scanner. It stores the point-in-time roster, source observations and selected opportunities, including assets never traded. Actual-trigger replay is recorded separately. Both portfolio arms use identical capital, the existing sizing, hard-floor, P142 and HOLD kernels, FINAL RECHECK, fixed resident protection, funding history, measured model latency and observed executable impact. Missing depth/partial fills remain unresolved, not profitable synthetic fills. Five-second VWAP is an execution estimate; it does not prove historical fill priority.

Discovery ends before the candidate freezes. Validation uses the following 14 days; holdout uses days 14–21, with an embargo. Holdout metrics are withheld until maturity. One challenger per parent is tested at a time, and a final evaluation is immutable. Gate failure retains the champion; insufficient historical microstructure cannot be overcome with invented second-level data.

## Promotion and rollback

JS and SQL independently enforce scope and quantitative gates: at least 100 validation and 50 holdout trades in each arm, 14 days, 20 symbols, 3 regimes, positive paired day-bootstrap lower confidence bound, net and expectancy improvement, bounded drawdown/tail deterioration, activity and winner-retention checks, concentration limits, market/lifecycle coverage, actual-trade replay and source/hash integrity. Source-kernel drift blocks qualification.

Promotion is a compare-and-swap transaction in `evolution_private.active_policy`. It snapshots the prior champion and enters PROMOTING. At least three valid realtime journal decisions on the new policy hash establish ACTIVE_CHAMPION. A health deadline or deterministic error/performance degradation restores the previous version and queues failure research. Policy switches never close a position; entry versions live in a sidecar table. Models cannot call the promotion RPC or change its gates.

Realtime reads are cached for 15 seconds with a 250ms deadline; a short bounded cache and built-in audited baseline cover a database outage. Research work is never awaited. Calls use separate daily call/reservation budgets, hashes and retry leases. Dollar reservations are cost estimates, while the call count is a hard ceiling.

## Inspect

Service role only: `select public.evolution_report();`. This report contains the active/previous policy, challengers, queue, last review/scan/simulation, patterns, hypotheses, calibration, disagreement and promotion/rollback events. Full lineage and evidence remain in the additive `evolution_*` tables. Anonymous and authenticated clients have no access. No existing trading history is updated or deleted.

The immutable original bootstrap is `POLICY_BASELINE_V104`; the operator baseline was reconciled to `POLICY_BASELINE_V105` without changing decision rubrics or capital settings. Calibration without adequate exact observed outcomes stays absent. A proposal or replay is not profitability evidence. Until a full forward study and live lifecycle exist: **PROFITABILITY UNKNOWN**.

## Verification

Set `PGLITE_MODULE` to the native filesystem path of `@electric-sql/pglite/dist/index.js`, then run `node --test development/self-evolution/tests/*.test.mjs`. The suite includes forbidden scope, independent reviews, provider failure, causality, portfolio authority, migration roles, immutable history, lease fencing, SQL null rejection, atomic promotion and rollback. The release also ran 570 related decision/capture/IOC/partial-fill/native-protection tests and Deno checks.

Production verification: executor v106 (`b91fa4076e9a286918dd4521f7c4138b10e3872e3f992e346e86652f3baaea48`), worker v4 (`d1f4a45084ac8c1414993ff65c83f9edf3696156297724fbe76d0e3f2caea2e4`). The no-order QUSDT probe returned valid GPT FINAL HOLD with identical independent snapshot hashes and active policy V105. QUSDT, SPELLUSDT, JELLYJELLYUSDT and WLDUSDT each returned AVAILABLE with 24 ordered buckets. Initial dual reviews include a +30.8573 USDT winner and two losses; full-universe collection evaluated 525/525 symbols. `POLICY_20260926_f6be6ff8f8b50d7d` is a frozen research challenger, not an active trading policy. See the release receipt for the evidence and remaining limitations.

