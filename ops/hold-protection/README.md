# HBAR HOLD/EXIT protection release — 2026-09-29

Based on main 08665eb98f7bbe251896609f35a84bd0d0c9a081 and production executor v155 (all 85 bundled files matched main after line-ending normalization). No rollback.

## Root cause and measured request costs

The two rejected FINAL requests were 156,173 and 157,744 UTF-8 bytes against the existing 130,000-byte input guard. Output allowance was 1,400, below the 1,800 ceiling. `FD_REQUEST_COST_BOUND` was raised locally before the FINAL provider reservation or HTTP call. It was not a daily/monthly dollar rejection. The journal's $0.10 parent reservation is not a physical provider charge.

For the first oversized review, the preceding FIRST request was 124,493 bytes / 44,137 actual input tokens + 94 output tokens / $0.03352575; FINAL never ran. The actual model was gpt-5.4-mini-2026-03-17. FINAL actual tokenizer usage does not exist. Admission conservatively estimates one token per UTF-8 byte plus 4,096 framing tokens: 160,269 / 161,840 input-token upper bounds, corresponding to $0.12650175 / $0.12768000 max cost with 1,400 output tokens. The bound is deliberately conservative, not a tokenizer count.

After lossless references the recorded requests are 96,766 / 97,994 bytes. Corresponding conservative max costs are $0.08194650 / $0.08286750. Full section-size breakdowns, original provider ledgers, fixture hashes and causal indicator values are in [audit.json](audit.json); reproduce with `node ops/hold-protection/audit.mjs`.

Position state appeared twice (top-level and snapshot), identical entry/final captures and deltas were repeated, and critical-segment rows repeated the full ordered path. The new transport replaces repeated JSON subtrees with explicit JSON pointers and critical-segment references with row indices. It retains every 24×5s row and every column, all horizons, costs and evidence. Both providers share the canonical evidence. Existing compact paths remain resolvable.

A separate degraded-data validator required unavailable dynamic citations despite valid static HOLD evidence. Valid static citations now suffice only when the full capture is unavailable. ABSTAIN is excluded from the current HOLD model schema and remains only an internal technical-failure state.

## Protected admission and authority

Absolute monthly limits remain OpenAI $100 / DeepSeek $100; existing daily caps $50 / $100 are unchanged. Low-priority ENTRY/RECHECK/VERIFICATION cannot consume the final $20 / $5 of the monthly totals. Daily protection is at least $1 / $0.50 (existing DeepSeek $0.50 floor retained). All physical requests, retries and UNKNOWN costs still use the atomic ledger; HOLD never bypasses the absolute limits.

The available new-ledger sample spans about 12 hours, not a full month: OpenAI ENTRY 610 settled calls / $10.49555505; HOLD 6 settled / $0.15257925, p95 $0.03365569, plus one UNKNOWN reserved $0.08393850. DeepSeek ENTRY 82 / $1.450089924; HOLD 2 / $0.015845928, p95 $0.008168556. Extrapolating a conservative two calls per protection review and failure reserve gives roughly $14.65/month OpenAI and $1.96/month DeepSeek; $20/$5 rounds upward for the sparse sample and unknowns. This is an admission partition, not increased spending authority.

Hard safety still runs first. Urgent open-position reviews bypass ordinary review frequency/call-count restrictions but retain atomic provider limits. FAST HOLD goes directly to GPT FINAL with independently bounded DeepSeek advice, then at most one compact GPT retry. DeepSeek never acquires authority for the current dynamic lifecycle. Urgent results are consumed in the same management invocation, avoiding a later tick expiring the result.

## Deterministic protection and replay calibration

On technical failure, a fresh, complete, position-bound capture must show simultaneous negative 15s/30s price, negative 30s/60s taker flow, falling 30s bid liquidity, negative book imbalance and price below the recent peak. Protection raises to the maximum of the existing protection, hard floor and recorded 120s sampled bid low. Recovery, participation, high renewal and acceleration are recorded. No invented percentage threshold or technical-indicator gate is added. A floor breach uses EMERGENCY_EXIT_THESIS_FAILURE through existing ownership, generation, lease, reconciliation and CLOSE/reduce-only transport checks. Otherwise HOLD_WITH_TIGHTER_RISK installs a real monotonic protection level. The same level is offered to GPT as a candidate so a valid PROTECT has a concrete action.

Calibration uses 537 recorded observations from six positions (two winners, four losers), yielding 370 valid complete windows. Short 15/30s floors cut both winners on first failure; a 60s floor cut one. The 120s candidate preserved both winning paths while crossing earlier on all four losing paths. HBAR's first qualifying recorded failure was 00:04:25 KST, floor ~0.11832 (-0.3766% from entry), first later recorded crossing 00:07:50; the actual native stop occurred at 00:11:09. These are sampled-price counterfactuals, not simulated fills or promised PNL. Gapped windows are excluded. Decisions only use data available at the event; outcomes score the candidates afterward.

The user's illustrative -0.78% 30s snapshot is not substituted for stored review data: the first actual failed packet has 30s -0.20169%, 60s -0.46934%, 30s flow -29,570 / 60s -58,036 and positive short recovery. It warrants calibrated protection under technical failure, not a fabricated forced GPT EXIT.

## Causal technical evidence

Added RSI14 1m/5m; slow Stochastic (14,3,3) K/D and cross 1m/5m; BB20/2 population standard deviation mid/upper/lower/position/width; EMA9/20 distance and relationship; normalized Wilder ATR14; lower wick, candle range, body/range and close location; compact last three completed 1m candle shapes. Missing history yields null and a reason. Live and replay use the same functions and exclude current/future candles.

HBAR entry completed-candle values: RSI 53.60 / 45.71; Stoch 1m K63.53/D61.33, 5m K26.41/D26.01; BB position .7670; EMA9 vs EMA20 -.0954%; normalized ATR .7953%. No BUY/WAIT/SKIP result is imposed. Dynamic 5/15/30/60/120s evidence, flow and executable microstructure retain priority. Spread/slippage/depth/walls/VWAP/fees remain in inputs.

## Validation and deployment

Regression coverage includes actual HBAR/SOON oversized packets, lossless reconstruction, three failure cases, same-invocation application, real executor CLOSE transport, stale/forged proof rejection, causal/missing/flat indicators and SQL admission at exhausted entry budget. Existing clock, dynamic, NMR, SOON, gateway and native protection suites remain required.

Production replay/deployment and subsequent natural-trade evidence are appended after deployment. No artificial live trade is authorized or submitted by this audit.
