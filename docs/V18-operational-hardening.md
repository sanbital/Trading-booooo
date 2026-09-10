# V18 operational hardening — deployment candidate

This branch contains the V18 implementation and local verification. It is not a record of a production executor/gateway deployment or a trading restart. The independent `v18-readonly-audit` function is strictly diagnostic.

## Change and policy

- `v10-lane-executor` remains the owner of order execution and the shared V17 database lease. New entries still use the existing scanner, signal claim, actual available balance, IOC sizing and manual-position allowlist.
- Persist the actual entry fill, then establish protection in that same call. A 93-unit fill of a 196-unit request protects 93 units. A protection failure records reconciliation state without changing the fill into a rejection. No top-up BUY is added.
- The existing gateway can run a serial management-only observer. It reloads durable position/stop state and calls the executor with the `x-v18-protection-token` header and `mode: protect`. That credential cannot invoke entry mode. The previous executor rejects this new header, including after rollback.
- Before software close, refresh the remembered native receipt and reload the owned position. A native fill already closing the position prevents a duplicate software SELL. CAS and the existing shared lease serialize updates.
- After uncertain dispatch, retry only `get_order` using the persisted client/order identity. Record executed quantity independently of pending price/fees; monetary unknowns stay null. Journal recovery repairs quantity once and money separately. It does not resend the original order.
- Closed software exit reasons survive native order cleanup. `runtime.last_exit_at` advances from actual `closed_at` rows and cannot regress. Entry intents record the latest same-symbol exit/loss context. A signal ending before the latest close cannot reopen that symbol; no new loss-based cooldown is introduced.

R5 remains the selected numeric exit policy. A/B/C research did not establish a robust replacement. Existing positions retain their entry policy stamp. Preserve margin 40 USDT, leverage 3, approximately 120 USDT notional and 10 maximum slots; the actual balance and existing sizing buffers still govern affordability.

Observer defaults: disabled; 2,000 ms between completed passes; one in-flight call; request timeout 45 seconds; failure backoff up to 60 seconds. This is a scheduling interval, not a guaranteed 2-second end-to-end observation latency. Accept exchange book observations at most 2 seconds old, no future observations, no pre-entry observations. A stale batch member gets a fresh single-symbol read. Native replacement requires a 5 bps improvement and 5 seconds since ACK; initial protection, quantity changes and crossed stops bypass the throttle. Stops only ratchet upward. Host shutdown does not cancel existing stops.

## Files and validation

Execution: `supabase/functions/v10-lane-executor/index.ts`; shared `leader-entry-protection.mjs`, `leader-operations.mjs`, `leader-settlement.mjs`, `leader-native-protection.mjs`, `leader-protection-adapter.mjs`.

Observer: `gateway/v18-fast-protection-host.mjs`, `gateway/server.mjs`, `gateway/Dockerfile`, `gateway/stage-engine.mjs`. The staging script also fixes Windows entry-point detection.

Diagnostic: `supabase/functions/v18-readonly-audit/index.ts`, shared `leader-readonly-audit.mjs`. Snapshot coverage is explicitly limited to remembered conditional orders; `allConditionalOrdersVerified: false` must never be interpreted as a full account audit.

Prerequisite: `supabase/migrations/20260910081107_v18_pending_accounting_nullable.sql` drops NOT NULL from the two monetary fields. It makes no quantity/control/order change. The deployment workflow refuses V18 until a read-only check confirms this prerequisite. Do not bulk-apply unrelated pending migrations.

Run from the repository root:

```text
node --test test-support/v17-exit/*.test.mjs
node --test gateway/server.test.mjs gateway/v17-shadow-worker.test.mjs gateway/v17-shadow-host.test.mjs gateway/v18-fast-protection-host.test.mjs
node research/v18/verify-image.mjs
```

The image verifier copies exactly the Dockerfile COPY set, starts the staged server locally with mocked outbound transport, verifies the real health endpoint and management-only observer request, and shuts it down. It does not claim that a Docker image has been built or deployed.

Regression coverage includes terminal partial fills and residual closes, timeouts after exchange execution, post-fill DB write failure, monetary reconciliation and duplicate recovery, native/software races, manual ownership, stale/future prices, native replacement failures, cancellation/fill races, observer restart/abort/backoff, source wiring, affordability and execution lease behavior.

Remaining production validation: real API latency/rate limits, complete conditional-order inventory, fee/funding attribution, actual DDL application, live observer restart, and first natural V18 entry-to-protection ACK latency. Native fills whose detailed receipt is not yet exact remain explicit reconciliation pending; do not infer zero quantity or zero fees from an incomplete receipt. The existing lease expires after 10 minutes and must not be forcibly cleared while a worker could still be running.

## Ordered operator rollout

1. Record the reviewed commit, current main SHA, downloaded deployed executor bundle, gateway health/version, live controls, lease owner/expiry, automatic/manual position attribution and both ordinary and conditional order inventories. Resolve uncertain ownership/execution first. Leave existing native stops in place throughout.
2. Apply only the V18 nullable-accounting migration. Confirm the two fields are nullable. Retain a backup of the deployed bundle and control values; do not store credentials in evidence.
3. Deploy the gateway image through `deploy-binance-gateway.yml` with `V18_FAST_PROTECTION_ENABLED=false`. Verify the copied host module and `v18_fast_protection` health field. Do not change leverage, allocations or unrelated scheduler settings.
4. Deploy the complete V18 executor dependency bundle through `deploy-v17-exit-reliability-20260908.yml` from the reviewed commit. Check `PATCH=V18-OPS-HARDENING-1` in the actual downloaded deployed source, not only workflow success. Preserve `V17_NATIVE_STOP=true` when already enabled.
5. Configure the gateway's `V18_EXECUTOR_TOKEN` from the existing `edge_internal_tokens` executor credential through the secret manager; never print it. Enable `V18_FAST_PROTECTION_ENABLED=true` only after the new executor is verified. Observe real pass duration, last success, stale quote rejection, lease contention and protection ACKs. The existing minute cron remains the fallback.
6. Independently reconcile DB automatic quantities, signed Binance positions and every ordinary/conditional order. Confirm manual quantities and valid native stops unchanged, no unresolved dispatch, and no unowned exposure. Distinguish account-level balances from a strategy-owned position.
7. Check scanner → current strategy signal → executor identity → protection → reconciliation, along with operator entry control, runtime circuit, pause and kill-switch values. A healthy observer alone is not proof that entries are enabled. A configured entry flag alone is not proof of a trade. Never synthesize a live signal or test order to demonstrate rollout.

## First natural fill observation

Select only new positions stamped `executorPatch=V18-OPS-HARDENING-1` after the verified deployment. Bind the entry to its original client and exchange order IDs. Compare requested versus raw executed quantity, DB original/remaining quantity, signed account quantity and native stop quantity. Calculate delay from raw first-fill time to persisted native ACK, not from a delayed DB polling timestamp. Check the entry order is unique for that signal, protection failure preserves fill ownership, and no second BUY fills the requested remainder.

Alert on missing/uncertain protection, quantity mismatch, duplicate entry, observer failure or stale last success, an unresolved dispatch, and a later native/software exit mismatch. If there is no natural signal, report enabled/healthy waiting separately from an observed fill. Monitoring is not activated by committing this document.

## Rollback

Preserve all exchange-resident stops. Stop the V18 polling host through its feature flag before restoring the previous executor bundle. The separate V18 header also prevents the old executor from interpreting the observer request as a normal entry run. Do not use cancel-all orders as part of rollback.

Reconcile every nullable/pending monetary row and uncertain execution before letting the older executor manage those rows. Keep the nullable schema during rollback; never replace unknown values with zero to restore a constraint. Restore the entire previously captured source bundle, not only its entrypoint, and verify the actual restored version. Recheck ownership, quantities and protection after restore. The old bundle retains its known operational defects; rollback is a containment procedure, not evidence that those defects are fixed.

## Primary references

- [Binance futures account API: actual funding income](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account).
- [Binance futures trade API: ordinary and conditional orders](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).
- [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits). A persistent host belongs in the existing gateway, not an indefinitely running Edge background task.
