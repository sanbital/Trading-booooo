from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# Preserve the monitor-cycle terminal reason across the order-time executable re-quote and
# expose explicit machine-readable net-authority fields for the independent DB guard.
replace_once(
    'supabase/functions/market-autotrader/executable-exit.ts',
    '''  const executablePrice = quote.executableVwap > 0 ? quote.executableVwap : quote.limitPrice;
  return {
''',
    '''  const executablePrice = quote.executableVwap > 0 ? quote.executableVwap : quote.limitPrice;
  const priorApprovedReason = typeof priorQuote?.approved_reason === "string"
    ? String(priorQuote.approved_reason).trim()
    : "";
  return {
''',
)
replace_once(
    'supabase/functions/market-autotrader/executable-exit.ts',
    '''    ...(quote.allowed
      ? { approved_action: "STOP", approved_reason: "POSITIVE_NET_AFTER_180S" }
      : { approved_action: "NONE", approved_reason: `BLOCKED_${quote.reason}` }),
''',
    '''    ...(quote.allowed
      ? {
        approved_action: "STOP",
        approved_reason: priorApprovedReason || "POSITIVE_NET_AFTER_180S",
        executable_net_allowed: true,
        expected_net_profit_quote: quote.expectedNetProfitQuote,
      }
      : {
        approved_action: "NONE",
        approved_reason: `BLOCKED_${quote.reason}`,
        executable_net_allowed: false,
        expected_net_profit_quote: quote.expectedNetProfitQuote,
      }),
''',
)

# DB defense in depth: prefer the pending terminal recovery reason, and accept either the
# new explicit executable_net_allowed field or the older generic allowed field.
replace_once(
    'supabase/migrations/20260811090700_first_tranche_recovery_exit_v765.sql',
    '''  v_approved_reason := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
    nullif(p.metadata->>'pending_exit_reason', ''),
    ''
  );
''',
    '''  v_approved_reason := case
    when coalesce(p.metadata->>'pending_exit_reason', '') in (
      'STALE_RECOVERY_NET_POSITIVE_EXIT_180M',
      'FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M'
    ) then p.metadata->>'pending_exit_reason'
    else coalesce(
      nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
      nullif(p.metadata->>'pending_exit_reason', ''),
      ''
    )
  end;
''',
)
replace_once(
    'supabase/migrations/20260811090700_first_tranche_recovery_exit_v765.sql',
    '''  v_executable_net_allowed := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,executable_net_allowed}', '')::boolean,
    false
  );
''',
    '''  v_executable_net_allowed := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,executable_net_allowed}', '')::boolean,
    nullif(p.metadata#>>'{exit_policy_quote,allowed}', '')::boolean,
    false
  );
''',
)

# Focused regression: stale-recovery reason must survive the re-quote and DB net fields must
# be populated. This catches a policy->re-quote->DB disconnect before deployment.
test_path = Path('supabase/functions/market-autotrader/executable-exit.test.ts')
test_text = test_path.read_text()
marker = 'order-time quote preserves stale-recovery authority'
if marker in test_text:
    raise SystemExit('requote regression test already exists')
test_text += '''

Deno.test("order-time quote preserves stale-recovery authority and explicit net fields", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 10.5, size: 10 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(quote.allowed, quote.reason);
  const merged = orderTimeExitPolicyQuote(
    {
      approved_action: "STOP",
      approved_reason: "STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
      held_seconds: 10_900,
    },
    { revision: "7.6.5-RECOVERY180M" },
    quote,
  );
  assert(
    merged.approved_reason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
    String(merged.approved_reason),
  );
  assert(merged.approved_action === "STOP");
  assert(merged.executable_net_allowed === true);
  assert(Number(merged.expected_net_profit_quote) > 0);
});
'''
test_path.write_text(test_text)

# Cross-layer static test: migration must defend both the pending reason and old/new net flags.
lane_path = Path('supabase/functions/market-autotrader/futures-lane.test.ts')
lane_text = lane_path.read_text()
needle = '''  assert(RECOVERY_MIGRATION.includes("STALE_RECOVERY_REQUIRES_POSITIVE_NET"));
});
'''
replacement = '''  assert(RECOVERY_MIGRATION.includes("STALE_RECOVERY_REQUIRES_POSITIVE_NET"));
  assert(RECOVERY_MIGRATION.includes("pending_exit_reason"));
  assert(RECOVERY_MIGRATION.includes("executable_net_allowed"));
  assert(RECOVERY_MIGRATION.includes("'{exit_policy_quote,allowed}'"));
});
'''
if lane_text.count(needle) != 1:
    raise SystemExit('futures-lane v765 assertion anchor missing')
lane_path.write_text(lane_text.replace(needle, replacement, 1))

print('v765 re-quote authority fix staged')
