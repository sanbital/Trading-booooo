from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
TEST = Path("supabase/functions/market-autotrader/exit-idempotency.test.ts")

source = INDEX.read_text()

patched_marker = '"EXIT_DEFERRED_UNSETTLED_ORDER"'
claim_marker = '`id=eq.${position.id}&state=eq.OPEN`'
reopen_marker = '`id=eq.${position.id}&state=eq.EXITING`'

old_claim = '''  if (!position.is_paper) {
    position = {
      ...position,
      ...(await patch("trading_positions", `id=eq.${position.id}`, {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: action,
          pending_exit_reason: decisionReason || action,
          pending_exit_at: new Date().toISOString(),
          ...(protectedExitAudit ? { exit_policy_quote: protectedExitAudit } : {}),
        },
      }))[0],
    };
  }
'''

new_claim = '''  if (!position.is_paper) {
    // Exit idempotency v7.6.11: never submit a second exchange SELL while an earlier
    // bot SELL for this position is still unresolved. The order ledger is durable and
    // reconciliation owns UNKNOWN/REQUESTED orders, so retrying here would be unsafe.
    const pendingSellOrders = await unappliedBotSellOrders(position);
    if (pendingSellOrders.length > 0) {
      await event(
        "EXIT_DEFERRED_UNSETTLED_ORDER",
        `${position.exchange}:${position.market} exit deferred because a bot SELL is still unsettled`,
        {
          action,
          decision_reason: decisionReason || action,
          pending_order_ids: pendingSellOrders.map((row) => row.id).filter(Boolean),
          pending_order_states: pendingSellOrders.map((row) => row.state).filter(Boolean),
        },
        { cycleId, positionId: position.id, level: "INFO" },
      );
      return {
        action: "NONE",
        reason: "exit deferred: unresolved bot SELL already exists",
        position,
      };
    }

    // This conditional PATCH is the exchange-side-effect claim. Concurrent monitor
    // invocations may both hold a stale OPEN snapshot, but only one can move OPEN to
    // EXITING and therefore only one is allowed to reach sellLive().
    const claimed = await patch(
      "trading_positions",
      `id=eq.${position.id}&state=eq.OPEN`,
      {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: action,
          pending_exit_reason: decisionReason || action,
          pending_exit_at: new Date().toISOString(),
          ...(protectedExitAudit ? { exit_policy_quote: protectedExitAudit } : {}),
        },
      },
    );
    if (!claimed.length) {
      await event(
        "EXIT_CLAIM_SKIPPED",
        `${position.exchange}:${position.market} exit skipped because position is no longer OPEN`,
        { action, decision_reason: decisionReason || action },
        { cycleId, positionId: position.id, level: "INFO" },
      );
      return {
        action: "NONE",
        reason: "exit already claimed or position not open",
        position,
      };
    }
    position = { ...position, ...claimed[0] };
  }
'''

if patched_marker not in source:
    count = source.count(old_claim)
    if count != 1:
        raise SystemExit(f"EXIT_IDEMPOTENCY_SOURCE_DRIFT: expected one live exit claim block, found {count}")
    source = source.replace(old_claim, new_claim, 1)
else:
    print("exit idempotency claim already present")

# Scope the FOK no-fill reopen to the exact EXITING state claimed by this attempt.
old_reopen = '''    const reopened = (await patch("trading_positions", `id=eq.${position.id}`, {
      state: "OPEN",
'''
new_reopen = '''    const reopened = (await patch(
      "trading_positions",
      `id=eq.${position.id}&state=eq.EXITING`,
      {
        state: "OPEN",
'''
if reopen_marker not in source:
    count = source.count(old_reopen)
    if count != 1:
        raise SystemExit(f"EXIT_REOPEN_SOURCE_DRIFT: expected one protected FOK reopen block, found {count}")
    source = source.replace(old_reopen, new_reopen, 1)
    # The multiline patch call needs the matching close-paren indentation changed once.
    close_anchor = '''        protected_limit_last_unfilled_at: new Date().toISOString(),
      },
    }))[0] || position;
    await event(
'''
    close_replacement = '''        protected_limit_last_unfilled_at: new Date().toISOString(),
      },
      },
    ))[0] || position;
    await event(
'''
    count = source.count(close_anchor)
    if count != 1:
        raise SystemExit(f"EXIT_REOPEN_CLOSE_SOURCE_DRIFT: expected one reopen close anchor, found {count}")
    source = source.replace(close_anchor, close_replacement, 1)
else:
    print("conditional EXITING reopen already present")

# Fail closed if the core invariants are not visible after patching.
for needle in (
    patched_marker,
    '"EXIT_CLAIM_SKIPPED"',
    claim_marker,
    reopen_marker,
    'const pendingSellOrders = await unappliedBotSellOrders(position);',
):
    if needle not in source:
        raise SystemExit(f"EXIT_IDEMPOTENCY_PATCH_INCOMPLETE: missing {needle}")

# Settlement scope is intentionally NOT rewritten here. v7.0.1 apply_trading_exit_order
# receives the complete exchange fill, prorates the managed-position share internally,
# and preserves the full order as the exchange audit. Sending only the local allocation
# would lose residual-inventory accounting.
if 'p_fill_quantity: quantity' not in source or 'p_fill_funds: finite(fill.executedFunds, price * quantity)' not in source:
    raise SystemExit("EXIT_SETTLEMENT_CALL_SOURCE_DRIFT: raw exchange fill RPC contract changed")

INDEX.write_text(source)

TEST.write_text(r'''import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("live exits have a single exchange-side-effect claim", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const needle of [
    'const pendingSellOrders = await unappliedBotSellOrders(position);',
    '"EXIT_DEFERRED_UNSETTLED_ORDER"',
    '`id=eq.${position.id}&state=eq.OPEN`',
    '"EXIT_CLAIM_SKIPPED"',
    '`id=eq.${position.id}&state=eq.EXITING`',
  ]) {
    assert(source.includes(needle), `missing exit idempotency invariant: ${needle}`);
  }
});

Deno.test("exit accounting keeps the complete exchange fill contract", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(source.includes("p_fill_quantity: quantity"));
  assert(source.includes("p_fill_funds: finite(fill.executedFunds, price * quantity)"));
  assert(source.includes("p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee)"));
});
''')

print("exit idempotency v7.6.11 patch prepared")
