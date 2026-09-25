# LE-SHADOW V3 — compressed global market context preregistration

Date: 2026-09-25 KST  
Scope: order-free shadow only. Production executor, signal generator, trading controls, sizing, circuit and production GPT are unchanged.

## Change under test

The existing ALT GPT V2 decision is versioned to `LE_GPT_ALT2_2_MARKET_CONTEXT`. Its candidate facts, six axes, cost model, hard execution safety, WAIT lifecycle, budgets and outcome labeling are unchanged.

One new input is added: `market_context`, built read-only from the latest `public.market_regime_observations` row at or before the candidate snapshot, with a maximum age of 10 minutes. No future observer row may be used.

The raw observer feature tree is not sent to GPT. It is deterministically compressed to:

- universe sizes (Binance futures/spot, Upbit spot)
- Binance-futures 30m and 24h breadth
- BTC/ETH/SOL benchmark returns from the observer
- observer regime, bull score/confidence and momentum phase
- a simple breadth-state label

## Non-gating semantics

Global context is background evidence only.

- It is never a deterministic hard gate.
- It cannot be cited as a BUY support key or SKIP reason key; the server contract continues to accept only symbol-level `facts` citations.
- Broad market weakness alone must not reject an independently strong candidate.
- Broad market strength alone must not approve a weak candidate.
- Missing/stale global context is ignored and is not an ABSTAIN reason by itself.

## Deliberate exclusions in phase 1

News sentiment and direct market-wide liquidity aggregates are not included. They will be tested, if needed, as separate later shadow changes so their effect is not confounded with breadth/regime context.

The implementation adds no Binance requests: it reuses the already-running full-market regime observer. It adds no production DB write.

## Evaluation

Evaluate only decisions whose packet version is `LE_GPT_ALT2_2_MARKET_CONTEXT`; do not pool them with pre-cutover ALT2_1 decisions.

Primary forward outcomes remain net bps at 60/120/240 minutes, MFE/MAE and decision-group comparisons. Also inspect disagreement cases where symbol-level evidence is bullish while market breadth is adverse, because the main failure mode under test is over-vetoing strong independent leaders.

No threshold or rule will be changed from outcome knowledge inside this version.
