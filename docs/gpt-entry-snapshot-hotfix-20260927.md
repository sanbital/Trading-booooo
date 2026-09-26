# GPT FINAL ENTRY snapshot / durable resume hotfix

Baseline: remote main `5ad96b80c7cfc999cc2c8343b1bc10c2df8c60b4` (tree `3f6a847e032dcdb155df1415b9eecd7787dafea9`), executor v106, artifact SHA256 `b91fa4076e9a286918dd4521f7c4138b10e3872e3f992e346e86652f3baaea48`.

The deployed 67-file bundle was read before editing. 66 files matched main after LF normalization. The sole existing difference was main's already committed `gpt-final-decision-adapter.mjs` validation binding a HOLD packet to its exact initial/final frozen snapshot. This release retains that main protection and all self-evolution changes; it does not revert to an older artifact. Latest applied migration was `20260926180102_evolution_replay_receipt_cutoff`. No migration or control change is required.

## Proven cause

`readSources` normalized the BTC sensor at request-start time. `prepare` hashed the packet after capture. `frozenReview` then normalized the sensor again at capture time, changing `age_ms` and `sensor_freshness_ms` without updating the packet hash. GPT received the changed evidence and returned valid BUY, but the durable packet failed `validateStored`. `waitReady` discarded that failure and left the signal lifecycle at PENDING.

Actual production records were read without modification. Resetting only the two derived ages to their source `as_of_ms` values reproduced the original hash exactly in all three cases:

| Signal | Symbol | Derived age delta | Original outcome |
|---|---|---:|---|
| `690f570a-237d-4436-bd9b-452199564a89` | KITEUSDT | 201 ms | GPT_SNAPSHOT_MISMATCH |
| `4b55d95b-9eaf-477c-bf0e-475d72aa4114` | MARSCOINUSDT | 335 ms | GPT_SNAPSHOT_MISMATCH |
| `39301393-7feb-4733-84a3-e986522159b7` | MARSCOINUSDT | 311 ms | STALE:GPT_REVIEW_PENDING |

All were DONE, BUY, valid=true, error=null. The last completed at 17:37:22.110 UTC with answer validity to 17:37:33.148 and trigger expiry at 17:38:00; this was not a response-timeout diagnosis.

## Change

`frozenReview` first verifies the incoming packet, then normalizes the sensor and hashes the final canonical clone using `snapshot_hash:''`. Only then does it build model payloads, snapshot identity and the recursively frozen object. The same object feeds providers, FINAL and durable storage. Rehashing cannot legalize an already-mutated input. The common boundary covers ENTRY, HOLD and RECHECK.

`waitReady` rereads durable DONE and reconstructs a fully validated ticket without relying on `pending`, `tickets`, `readyHints` or `yieldArmed`. A fresh coordinator recovers by `consider` using the unchanged durable job identity. No duplicate API claim is made. DONE outcomes are reported after lease release, including one read at the wait deadline. The adapter replaces only the matching identity's NEW/PENDING lifecycle note using a fresh read and whole-features compare-and-swap. It neither claims nor terminalizes the signal. Validation failures remain no-order and are exposed in the run response.

ENTRY/HOLD/RECHECK audit: source_errors, execution_ref and current_ref are hashed before dispatch; capture normalization and policy injection build separate model payloads; the discovered mutation was the common sensor normalization. No broad refactor was made.

The legacy autotrader workflow already excluded `gpt-final-decision`, but not `gpt-final-review`. This hotfix adds that matching exclusion to prevent an unrelated legacy deployment when main changes. Only regression/guard/lint workflows match the release files.

## Validation

- Initial 20 regression cases: 12 fail before the patch, 20 pass afterward. Expanded suite: 25 new cases, all pass.
- Integrated Node suite: 1,111 passed, zero failed/skipped. Includes decision/coordinator, independent advisory/final arbitration, sensor SQL validation, lifecycle, entry/IOC, duplicate prevention, final recheck, aged-BUY forced recheck, native protection, self-evolution and gateway tests.
- Repository Deno suite: 1,055 passed and 13 steps, zero failures. Executor Deno graph/type check passed.
- Existing HOLD refresh fixtures now calculate a hash after constructing their new snapshot. The sensor cutoff test both rejects mutation without a hash and verifies future events remain UNAVAILABLE in a newly built hashed packet. No assertion was weakened or removed.
- BUY creates a validated ticket. SKIP/ABSTAIN never create entry eligibility. Actual price/sensor tampering yields GPT_SNAPSHOT_MISMATCH; identity and invalid response tests fail closed. Cold recovery makes zero extra API calls. Aged BUY still needs FINAL RECHECK before dispatch.

Historical replay reconstructs the original pre-freeze payload only after proving its original hash. The patched freeze produces **identical market evidence** to that actually seen by GPT, with consistent bookkeeping. All three original wire responses then pass durable validation, waitReady, ticket restoration and cold-coordinator recovery. After validity expiry direct dispatch remains denied. This is an offline replay with zero orders and zero production writes, not a claim that those historical trades should have filled. Historical malformed rows are never repaired or accepted in live execution.

GPT prompts, strategic criteria, evidence providers, DeepSeek advisory role, GPT FINAL authority, trigger requirements, FINAL RECHECK, order/claim CAS, margin 150 USDT, leverage 3x, 10 slots, sizing, exit rules, stops, account/withdrawal/transfer controls, policy scope and trading history are unchanged by this patch. Deployment and live verification are recorded in the task's separate release receipt.
