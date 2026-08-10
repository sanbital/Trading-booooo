from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


# 1) Wire the new residual reasons into the engine's final sell allow-list.
index_path = "supabase/functions/market-autotrader/index.ts"
index = read(index_path)
index = replace_once(
    index,
    "  futuresEntryMinimums,\n  futuresRecoveryLatched,\n  futuresSplitExitDecision,\n",
    "  futuresEntryMinimums,\n  futuresSplitExitDecision,\n",
    "remove obsolete recovery import",
)
index = replace_once(
    index,
    '''          decision.reason === "FUTURES_HALF_TAKE_PROFIT_ROE_15" ||
          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||
          decision.reason === "FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30" ||
          decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "RESIDUAL_TAKE_PROFIT_10" ||
          decision.reason === "RESIDUAL_STOP_LOSS_4" ||
''',
    '''          decision.reason === "FUTURES_HALF_TAKE_PROFIT_ROE_15" ||
          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||
          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||
          decision.reason === "RESIDUAL_PROTECTED_TRAIL_EXIT" ||
''',
    "engine exit allow-list",
)
write(index_path, index)

# 2) Bring the end-to-end futures lane tests onto the protected trailing contract.
test_path = "supabase/functions/market-autotrader/futures-lane.test.ts"
test = read(test_path)
test = replace_once(
    test,
    '''const MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810010000_binance_futures_lane_v760.sql", ROOT),
);
''',
    '''const MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810010000_binance_futures_lane_v760.sql", ROOT),
);
const PROTECTED_MIGRATION = await Deno.readTextFile(
  new URL("supabase/migrations/20260810133000_protected_trailing_exit_v761.sql", ROOT),
);
''',
    "protected migration test fixture",
)
test = replace_once(
    test,
    '''  assert(ENGINE.includes("futuresSplitExitDecision({"));
  assert(ENGINE.includes("futuresRecoveryLatched({"));
''',
    '''  assert(ENGINE.includes("futuresSplitExitDecision({"));
  assert(ENGINE.includes("peakGrossReturnPct,"));
  assert(!ENGINE.includes("futuresRecoveryLatched({"));
''',
    "leverage test runtime expectation",
)
test = replace_once(
    test,
    '''Deno.test("futures recovery state records residual rather than whole-position recovery", () => {
  assert(ENGINE.includes('exit_rule: "RESIDUAL_NET_PNL_GT_0"'));
  assert(ENGINE.includes('decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||'));
  assert(ENGINE.includes("(entryPrice * (1 + policyFeeRate)) - 1) * 100"));
});
''',
    '''Deno.test("futures residual state uses peak-aware protected trailing", () => {
  assert(ENGINE.includes('decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(ENGINE.includes("peakGrossReturnPct,"));
  assert(ENGINE.includes("recoveryLatchedNow = false"));
  assert(ENGINE.includes("recoveryMode = false"));
});
''',
    "remove recovery integration test",
)
test = replace_once(
    test,
    '''Deno.test("every futures exit reason is authorized end to end", () => {
  for (const reason of FUTURES_EXIT_APPROVED_REASONS) {
    assert(
      ENGINE.includes(`decision.reason === "${reason}"`) ||
        ENGINE.includes(`decisionReason === "${reason}"`),
      `${reason} is not on an engine allow list`,
    );
  }
  // The two that liquidate the protected half must also clear the database guard.
  assert(MIGRATION.includes("FUTURES_RECOVERY_NET_POSITIVE_EXIT"));
  assert(MIGRATION.includes("FUTURES_RESIDUAL_ROE_NOT_REACHED"));
  assert(MIGRATION.includes("if v_gross_roe_pct < 29.999 then"));
  assert(MIGRATION.includes("FUTURES_FIRST_TRANCHE_ROE_NOT_REACHED"));
});
''',
    '''Deno.test("every futures exit reason is authorized end to end", () => {
  for (const reason of FUTURES_EXIT_APPROVED_REASONS) {
    assert(
      ENGINE.includes(`decision.reason === "${reason}"`) ||
        ENGINE.includes(`decisionReason === "${reason}"`),
      `${reason} is not on an engine allow list`,
    );
  }
  assert(PROTECTED_MIGRATION.includes("FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT"));
  assert(PROTECTED_MIGRATION.includes("FUTURES_PROTECTED_TRAIL_NOT_REACHED"));
  assert(PROTECTED_MIGRATION.includes("v_protect_roe_pct := greatest(9, v_peak_roe_pct - 4.5)"));
  assert(PROTECTED_MIGRATION.includes("FUTURES_FIRST_TRANCHE_THRESHOLD_NOT_REACHED"));
});
''',
    "futures end-to-end reason test",
)
test = replace_once(
    test,
    '''Deno.test("the spot lane's own thresholds are untouched", () => {
  // The whole point of the futures work is that it is additive. If any of these moved,
  // the spot lane changed behaviour and this test is the tripwire.
  assert(ENGINE.includes("spotSplitExitDecision({"));
  assert(MIGRATION.includes("v_net_return_pct < 9.999 and v_net_return_pct > -3.999"));
  assert(MIGRATION.includes("v_gross_return_pct < 4.999 and v_gross_return_pct > -3.999"));
});
''',
    '''Deno.test("the spot lane uses the approved protected trailing thresholds", () => {
  assert(ENGINE.includes("spotSplitExitDecision({"));
  assert(ENGINE.includes('decision.reason === "RESIDUAL_PROTECTED_TRAIL_EXIT"'));
  assert(PROTECTED_MIGRATION.includes("v_protect_pct := greatest(3, v_peak_return_pct - 1.5)"));
  assert(PROTECTED_MIGRATION.includes("SPOT_PROTECTED_TRAIL_NOT_REACHED"));
  assert(PROTECTED_MIGRATION.includes("v_gross_return_pct <= -3.999"));
});
''',
    "spot protected trail integration test",
)
write(test_path, test)

# 3) Make the protected migration authoritative over the obsolete later-running v7.6.2 spot trigger.
migration_path = "supabase/migrations/20260810133000_protected_trailing_exit_v761.sql"
migration = read(migration_path)
migration = replace_once(
    migration,
    '''comment on function public.guard_residual_sell_order_v751() is
  'Protected trailing v1 durable sell guard with full hard-stop exits and peak-aware residual protection';

-- Re-stamp currently open positions with the new canonical policy metadata/levels.
''',
    '''comment on function public.guard_residual_sell_order_v751() is
  'Protected trailing v1 durable sell guard with full hard-stop exits and peak-aware residual protection';

-- v7.6.2 was a later-running spot-only trigger that rewrote +10/-4 residual fields after
-- the unified v751 protected-trailing trigger. It must not coexist with this policy.
drop trigger if exists zzzzzzz_trading_positions_spot_split_stop_v762 on public.trading_positions;
comment on function public.enforce_spot_split_stop_v762() is
  'Obsolete after protected trailing v1; trigger removed so unified v751 owns spot and futures exits.';

-- Re-stamp currently open positions with the new canonical policy metadata/levels.
''',
    "remove obsolete spot split trigger",
)
write(migration_path, migration)

print("protected trailing integration finalized")
