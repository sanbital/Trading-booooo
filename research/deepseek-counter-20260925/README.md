# DeepSeek counter-model research — not a production trading release

Update: the credential blocker has been resolved and 122 live-network historical
replays completed. See [connection results](CONNECTION-RESULTS.md) for current
status. The report below is the original pre-credential audit, retained as history.

2026-09-25. Baseline main: `a6e27077fd6e9e54576d31609048c6afc96bb3f6`.
Production project: `etaajwpernzrcdrifdnw`.

## Release decision

**No DeepSeek authority is supported by evidence yet.** The complete production
Edge Function custom-secret list was inspected in the authenticated Supabase
dashboard. It contains `OPENAI_API_KEY`, but no DeepSeek credential under any
name. No secret value was viewed, copied, changed, or logged. No model API
experiment was run using a fake key. The research is blocked on this credential.

The added module and replay runner are research infrastructure, not a completed
production integration. No trading code imports them. No migration, executor
deployment, live parallel call, or trading performance improvement is claimed.
Adding a secret alone cannot grant authority or activate the research module.

## Source verification

Actual main `api.mjs`: GPT `gpt-5.4-mini-2026-03-17`, Responses API, strict JSON
schema, reasoning `none`, ENTRY/HOLD request cap 8000 ms. RECHECK has its own
4000 ms request cap, 8000 ms answer-age cap, and 3000 ms execution reserve.
Actual slot-sizing contract: 150 USDT margin, 3x leverage. Executor MAX_SLOTS=10.
No sizing, stop, lease, fill accounting, IOC, or safety policy was modified.

Official documentation inspected on 2026-09-25:

- https://developers.openai.com/api/docs/models/gpt-5.4-mini
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/thinking_mode/

The current DeepSeek Chat Completions specification lists `deepseek-flash` and
`deepseek-v4-pro` and an explicit thinking toggle. They are candidates, not a
selected winner. JSON-object output still receives strict local shape, identity,
fact-availability, enum, and confidence-range validation. Self-reported
confidence is never used as a calibrated probability or execution weight.
Provider costs remain unknown until actual usage and applicable pricing are
verified. No invented prices are used.

## Baseline revalidation

DB query window: positions entered since `2026-09-24T16:02:00Z` (01:02 KST).
At the audit, all 15 positions were closed: 7 wins, 8 losses; realized PnL
`+11.04213902 USDT`, win rate `46.67%`, profit factor `1.221394`, average winner
`+8.70252206`, average loser `-6.23443943`, worst loss `-7.98308799` USDT.
These are DB accounting values; independent live Binance reconciliation was
not completed in this task. They are not TRAIN/VALIDATION/TEST results.

The originally reported RECHECK means reproduce, but counts require care:

| Decision | Initial queried rows | Non-null outcome rows | Mean counterfactual USDT |
|---|---:|---:|---:|
| No recheck | 24 | 23 | -0.991659 |
| SKIP | 19 | 17 | +8.832516 |
| BUY | 4 | 2 | -11.308556 |
| ABSTAIN | 2 | 2 | -6.504255 |

Production continued during the audit. `recheck-audit.json` captures 51 rows at
its recorded timestamp; later unlabelled events must not be treated as zeros.
The separate input export contains 122 saved packets (76 ENTRY, 27 RECHECK,
19 HOLD) and may have a later cutoff. The two exports are joined by identities,
never row order. Raw provider outcomes are deliberately excluded from inputs.

The SKIP sum of `+150.15277019` contains one XAI observation worth
`+121.19179284` (approximately 80.7%). Excluding it leaves `+28.96097736` over
16 labelled SKIPs, mean `+1.81006109`. This sensitivity does not prove that all
SKIPs are wrong. Many SKIPs correctly avoid the stop proxy.

The tracker migration `20260924064044_fd1_final_recheck_log.sql` defines its
outcome at **600 USDT notional**, a **2.5% stop proxy**, **60-minute close**, and
**0.1% round-trip fees**, at one-minute resolution. This is not the actual
450-USDT slot's path-dependent exit PnL. Existing FD1 book-depth facts also use a
600-USDT reference. Do not compare these proxy amounts directly with realized
450-USDT trades or claim a deployable 150-USDT opportunity improvement.

## RECHECK observations, not learned rules

- XAI SKIP: adverse price, selling tape, depth deterioration followed by a
  strong rebound; 60m return +20.30%, MFE +28.45%, MAE -0.42%.
- SAGA SKIP: adverse tape/depth followed by +7.83% at 60m; MFE +26.41%.
- QNT SKIPs include both positive 60m outcomes and a negative 60m outcome with
  positive interim MFE. Horizon selection changes apparent correctness.
- XAI BUY (aged-answer trigger): +1.18% at 15m, but -1.07% at 60m; this is not
  automatically dead-on-arrival (MFE +2.06%).
- ONDO BUY (aged-answer trigger): MFE only +0.276%, then -2.23% at 60m and a
  stop-proxy hit at minute 58. It is an early-failure research candidate.
- A QNT SKIP record has a position ID despite NO_ORDER_SKIP. Retry/candidate
  identity must be reconciled before interpreting it as an unexecuted trade.

These observations were inspected during development. No untouched OOS test
result may be claimed by fitting rules to them and re-scoring them.

## Required research protocol before authority

1. Verify the actual key's existing environment-variable name and availability
   without logging it; authenticate current model availability and pricing.
2. Partition by packet version, source commit, prompt/schema hash and strategy
   revision; source_commit currently includes policy labels, not always Git
   SHAs, so it alone is insufficient provenance.
3. Freeze chronological TRAIN -> VALIDATION -> TEST cutoffs before tuning.
   Purge overlapping candidate/position outcomes at boundaries; use at least
   the evaluated horizon as embargo. Keep repeated candidate/retry observations
   together. Exclude unresolved/missing outcomes; never impute zero.
4. Keep exact historical packets and timestamps. The replay runner accepts
   input packets only and never fetches later prices. Historical source prompt
   hashes and the current replay payload hash are logged separately; changed
   prompt versions must not silently become the historical GPT baseline.
5. Run both DeepSeek candidates with the same saved input. One GPT call and
   both research counter calls start concurrently per packet. Store short
   validated JSON and usage only; no provider chain-of-thought.
6. Compare A-G on TRAIN/VALIDATION; freeze selection, then evaluate TEST once.
   Report fee-net PnL, loss tails, winner capture and opportunity cost with
   capacity, latency, fills, stop ordering, and real sizing accounted for.
   No default numeric weights, confidence thresholds or automatic authority.
7. HOLD requires exact historical review sequences and actual/proxy exit
   reconstruction with native-stop precedence. Preserve ARK/QNT/SYN winners.
   Nineteen saved HOLD reviews alone do not prove an early-failure policy.
8. Only after positive OOS evidence: add the selected task-specific deterministic
   policy, append-only service-role audit migration, executor integration,
   deadline/fallback policy, complete regressions, main release, deploy, and
   independently verify provider overlap, fusion/order linkage and reconciliation.

TRAIN, VALIDATION, TEST model comparison metrics are all **not measured**.
No ENTRY, RECHECK, HOLD or winner-preservation authority has been granted.

## Files and usage

- `inputs.json`: saved point-in-time packets with provenance, no outcome columns.
- `recheck-audit.json`: separate observational outcomes; never feed to models.
- `replay.mjs`: explicit credential-name argument; exclusive output file prevents
  overwriting a prior experiment. It fails before network/output creation if
  the credential is absent. Example:

  `node research/deepseek-counter-20260925/replay.mjs inputs.json results.jsonl EXISTING_KEY_ENV_NAME`

Production executor observed during audit: version 87, ACTIVE,
bundle SHA256 `753aae6b3e65b6b064085b95d287b8c18ba500b4be1c642eb7d3527800643ace`.
This is the pre-existing deployment, not a deployment made by this task.

## Validation

See `validation.json` for final test results. Parallel tests use controlled
fetch callbacks and a two-start barrier with monotonic timestamps. They prove
overlapping call invocation and input equality in code, not production API
latency. A malformed response, HTTP error, or timeout cannot promote the counter
model to authority. Stops and trading safety are outside this module.

