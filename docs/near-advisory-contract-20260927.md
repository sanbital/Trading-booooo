# NEAR advisory / FINAL interface correction

Baseline: main `19a75fd9362739926f05b6d0c1d675ea86c9adde`, executor v115,
artifact `836b1331f6c4fe362d668ec2abbce752fdc474816e046b0ab3800255ff1a7779`.
All 68 downloaded production source files matched main before editing. This preserves
the #208 citation work and #209/#210 compact FIRST, request limits and independent time budgets.

## Incident

Production journal `8ee011a926046d46d2e4091626c12d2dd126bf1bb98e7827e1bed818770ea2ba`
(2026-09-27 06:06:08 UTC, NEARUSDT) recorded FIRST WAIT (1,434 ms), DeepSeek SKIP
(3,691 ms), FINAL SKIP, then ABSTAIN at 10,777 ms. DeepSeek cited
`facts.trend.relative_strength_60m` instead of the supplied
`facts.market.relative_strength_60m`. Its identity and snapshot matched.
The single bad citation invalidated its entire opinion. FINAL correctly ignored it,
but returned `dual_confidence_degraded=false`, triggering `FD_DYNAMIC_DUAL_STATUS_MISMATCH`.
The production record is pinned in `test-support/near-contract-20260927.json`.

## Contract

- Dynamic ENTRY/RECHECK schemas no longer ask models for `dual_confidence_degraded`.
  FINAL canonicalization always writes `advisory.valid !== true`. A legacy wire value
  is ignored; it can neither change server state nor invalidate SKIP. Other integrity
  and single-model BUY confidence/propulsion checks remain unchanged.
- Live DeepSeek wire uses `bullish_evidence_ids` / `bearish_evidence_ids` and a sorted,
  bounded ID-to-exact-path table derived from the same frozen snapshot evidence menu.
  Unknown IDs are never corrected or treated as paths. Only the server expands IDs.
  FIRST still uses its existing exact-path schema.
- Standard `/chat/completions` JSON-object transport is retained. The documented strict
  tool-call mode requires the separate beta endpoint; changing that production transport
  is outside this minimal fix. The ID table is sent once; server membership validation is
  exact, regardless of the JSON schema's ID syntax hint.
  References: [JSON output](https://api-docs.deepseek.com/guides/json_mode/),
  [strict tool calls](https://api-docs.deepseek.com/guides/tool_calls/).
- Structure, task/decision enums, candidate, snapshot and confidence violations invalidate
  the whole opinion. Citation membership errors alone remove those citations and retain
  DEGRADED_VALID if at least one unique numeric/boolean citation remains. Zero citations,
  including UNCERTAIN with no evidence, is INVALID. Failed provider access is UNAVAILABLE.
  VALID means no citation was rejected. Existing persisted/emergency validation still
  requires an already sanitized canonical answer and retains its strict boundary.
- FINAL sees explicit server status/availability/validity/error and the surviving and
  rejected citations. Invalid/unavailable opinions are not exposed as usable advice.
  FINAL must review surviving advisory evidence and can reject it; DeepSeek cannot grant ENTRY.
- Audit retains `deepseek_status`, `deepseek_available`, `deepseek_valid`, `deepseek_error`,
  `deepseek_invalid_evidence`, `deepseek_valid_evidence`, `deepseek_decision_preference`,
  `final_decision`, `final_advisor_usage`, `final_advisor_ignored_reason` and the raw wire.
  Partial rejection retains `DEEPSEEK_UNSUPPORTED_EVIDENCE` as a diagnostic with valid=true.

## Verification and latency

The unchanged historical FINAL wire with historical invalid DeepSeek now validates as
SKIP with canonical dual degradation=true and no entry ticket. Separately, the same
DeepSeek wire assessed under the new citation contract retains five citations and rejects
exactly the one bad path. The new live ID orchestration also preserves FINAL SKIP.
Tests include advisory BUY disagreement, all-invalid/empty evidence, identity/snapshot/task/
enum errors, provider failures, forbidden adoption of rejected citations, and existing
single-model BUY rules. Every tested full review makes at most two GPT requests and one
DeepSeek request, without retry; admission/intent authorization remains denied for SKIP.

On identical stored NEAR input and invalid advisor state, serialized request sizes:

| Request | v115 bytes | corrected bytes |
| --- | ---: | ---: |
| DeepSeek | 39,624 | 39,178 |
| FINAL | 113,763 | 113,758 |
| FINAL schema | 30,590 | 30,517 |

Local validation is below 1 ms median on this fixture. This is not a live provider latency
measurement. No extra call, retry, timeout, refresh, or inference budget is introduced.
Provider/network variance still requires production observation before claiming a new
end-to-end latency. Recovered usable advice naturally includes the surviving opinion in FINAL.

Production code changes are limited to `advisory.mjs`, `dual.mjs`, and `dynamic-contract.mjs`.
`contract.mjs`, all execution/protection/sizing sources, R5, FINAL RECHECK, trigger/snapshot
freshness, reconciliation and reduceOnly remain unchanged. Tests and fixture helpers follow
the new transport. Runtime smoke uses only the existing read-only `ops-readiness` mode;
no forced order or additional model probe is required.
