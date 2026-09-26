# Production failsafe source synchronization audit

Status: **Source synchronization verified; packet-binding regression fixed and locally validated.**

The first independently resolved remote main was `8203036ce018c1bf6aede5fe21bfc21321b8d1fa`.
PR #198 merged during discovery, after initial PR metadata still reported `4ea609462c68f926d17b350d59a439092d3b3afd`.
PRs #193, #195, #196 and #197 are ancestors of this main. Existing dirty checkouts were preserved;
this audit uses a fresh clone and `fix/sync-production-v106-failsafe-hardening`.
PR #199 was still open and was not merged or modified by this audit.
Before opening the PR, main advanced again to `3677a5251c99a2ea1e6041ac00af01fde862f448`
through PR #200. That successor was merged into the audit branch without conflicts and the
entire Node regression was rerun against it; none of its changes were overwritten.

The actual Supabase `get_edge_function` source initially returned executor v105,
artifact `f55a69d782600c41bd75b07b5af277baea896a397d9ad0b1a032bed3ef26adce`.
An independent deployment advanced it to v106 while the audit was running:
`b91fa4076e9a286918dd4521f7c4138b10e3872e3f992e346e86652f3baaea48`.
Freshly fetched v106 contains 67 files, all identical to main after CRLF/LF normalization.
This includes index.ts, gpt-final-decision-adapter.mjs, leader-native-protection.mjs,
exit-authority.mjs, hold.mjs, leader-protection-adapter.mjs, dual.mjs and advisory.mjs.
No runtime-source backport remains: PR #198 already inherited the v105 hardening.

Main and production both retain consumption-time `validateAdvisory`, frozen identity/market hashing,
position generation and OPEN/positive-quantity guards, completion-time freshness,
all acknowledged stops in the monotonic ratchet and `PR193_EMERGENCY_VALIDATION_1` readiness telemetry.
The telemetry identifies the active failsafe release in the authenticated readiness response.
GPT FINAL retains ENTRY authority; DeepSeek ENTRY authority remains NONE.

## Reproduced and corrected regression A

The new test starts with a valid frozen HOLD advisory and sets outer `result.valid=true`.
Changing only `record.packet.snapshot_hash` to a different 64-character hash still produces
`FD1_DEEPSEEK_EXIT` with `close=true`, in both the direct and persisted consumption paths.
The frozen input's own hash is checked, but the separately supplied packet is checked only
for selected task/position/generation/candidate fields. Its full content is not rebound to
the frozen `packet_hash`. A failed GPT result can therefore reach this emergency path.
This was reproduced as two failing assertions against unchanged v106 source, not stale source-identity tests.

Reproduce without credentials, production writes or orders:
`node --test --test-name-pattern="persisted packet snapshot_hash" tests/fd1-emergency-validation.test.mjs`

The user explicitly approved correcting this additional defect and merging after validation, with no deployment.
The adapter now compares the full supplied packet with its matching frozen initial/final `packet_hash`,
recomputes that snapshot's hash and checks its task, symbol, candidate, generation, position and time.
The legitimate refreshed FINAL packet may differ from the initial DeepSeek snapshot; this remains allowed.
Tests include serialized persisted packets, sensor normalization, actual arbitration output with unavailable
GPT, altered packet contents and final-snapshot mutations. The production code change adds only 11 lines.
Production v106 remains unchanged: 66/67 deployed files still match; the adapter difference is this
explicitly approved additional check. Its deployment is outside this task.

## Validation

- Repository `deno task test`: 1,055 passed, 13 steps, zero failures.
- Broad Node decision/capture/BTC/entry/exit/native-stop/lease/fencing/duplicate/partial-fill/
  reconciliation/self-evolution regression after the fix and PR #200 integration:
  **1,141 passed, zero failed or skipped**.
- Executable-stop parity invariants and formatting: passed; executor/autotrader Deno checks passed.
- Executable-stop and observation-ordering Deno tests: 15 passed.
- Focused emergency/native-protection suite: 114 passed. All requested A–S cases pass, including
  resident 101 versus 97.5/98 with legacy labels, delayed 102 ACK before 101 cancellation,
  failed replacement preservation and the previously failing packet-binding cases.

Eight older assertions in five test files were aligned to already-deployed contracts: 150 x 3
notional, advisory V30/chase verdicts with mandatory provenance, current arbitration identity,
explicit resident approval before partial close, and separate 98.8 hard / 101.25 soft protection.
Their 44 tests pass without changing runtime code, sizing, entry gates or protection thresholds.
An initial Windows PGlite URL/path configuration failure was corrected in the test environment only.

Read-only production observation at 2026-09-26 17:47:09 UTC: v106 logs show 16 HTTP 200 calls,
zero HTTP errors in the returned deployment window; last_error=null, protection_health=FLAT,
circuit_open=false, OPEN positions=0. GPT control remains ENFORCE, $50, 300 calls, approved.
Budget: reserved $4.66474255, settled $3.66474255, remaining reservable $45.33525745.

This task performs **no production deployment**, trading call or configuration change.
Main merge is authorized only after tests and PR checks pass. Existing deployment jobs were inspected:
the legacy market-autotrader and Supabase deployment jobs require explicit `workflow_dispatch`.
