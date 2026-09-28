# Top10 GPT reason/evidence schema correction

2026-09-28, based on main `1a10a3e395ec136bfb844091c615f7d21588b141` / executor v144.

## Observed defect and change

INX 05:21 and 05:31 returned SKIP with `FILL_WORSE` citing both slippage and spread. PUMP 05:31 returned WAIT with a `SELL_DOMINANCE` citation outside that category. The existing server correctly rejected these answers; they were not missed BUY decisions. The provider schema offered a Cartesian product of categories and all observed facts, despite the prompt's existing category mapping.

`batchFinalPayload` now uses nested `anyOf` objects to bind each reason category to its existing permitted evidence keys. GPT_JUDGMENT, EV_UNFAVORABLE and DATA_INCOMPLETE retain their original evidence choices. Non-data reasons require at least one citation, matching the existing server validator. The batch engine version advances to `TOP10_BATCH_GPT_FINAL_2`, so journal identities distinguish this transport revision.

No source data, ordered 24-bucket path, prompt, decision choices, risk bands, server validation, FINAL RECHECK/HOLD/EXIT route, deadline, cost limit or order authority is changed. OpenAI documents nested anyOf support in Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs .

## Verification

- Original packet/wire replay: INX 05:21 plus all ten 05:31 ENTRY records, using Ajv 8.17.1 and the unchanged server validator. Eight valid BUY/WAIT/SKIP answers remain accepted; all three original category errors are excluded by the new provider schema and remain rejected by the server. Model input is byte-identical and all 24 rows remain present. Request increase 291–919 UTF-8 bytes; every request remains below 130,000 bytes. This is structural validation, not a semantic accuracy score.
- Node 1,505 tests; Deno 1,055 tests plus 13 steps; executor/generator type checks pass.
- Bounded internally authenticated, order-free replay of two exact historical packets: INX valid WAIT, 17,588 input / 766 output, $0.016638, 4,384 ms; QNT valid WAIT, 17,590 / 734, $0.0164955, 3,972 ms. Both use the real provider ledger and existing budget enforcement. Total $0.0331335. Historical QNT was BUY; a fresh probabilistic replay choosing WAIT is not claimed to preserve the prior decision. No order authority or trading writes exist in the replay function.
- The first audit-only invocation omitted a wall-clock dispatch deadline and was rejected before provider dispatch by `API_PARENT_EXPIRED_OR_TERMINAL` (surface error API_LEDGER_WRITE_FAILED). Its RESERVED row was automatically CANCELLED with actual cost zero, verified at 05:42:52 UTC. The corrected audit has a new verification deadline while preserving the original historical packet clock; production TTLs are unchanged. The audit endpoint is closed after these two calls.

Local evidence: `work/first-fill-checks/20260928T0531Z-reason-source.json`, `20260928T0541Z-reason-replay.json`; helper `work/replay-reason-schema.mjs`. Replay jobs: INX `05cbf2730afd5c924a105608227c90bad89307a3e6f57f5eea9dc809e45f9f51`, QNT `b79fad0f159a02292bab4677549ac362b24deec3effeee79b2d0da4fbda87ae1`.

## Remaining production limits

At 05:31, fresh QNT and BTW FINAL RECHECK completed with valid WAIT, not timeout; no order was authorized. SOON's earlier ENTRY BUY expired before a FINAL review. Those timing limits are not relaxed here. Original reason interpretation and s60 time-unit errors need separate monitoring. This correction does not establish semantic accuracy or sustainable monthly costs: current all-ten GPT forwarding remains above the approved $100/month scenario. Budgets and strict ten-minute scheduling are unchanged.
