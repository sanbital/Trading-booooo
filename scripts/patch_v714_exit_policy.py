# Read-only validator: this file must never rewrite trading source or migrations.
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "supabase/functions/market-autotrader/index.ts"
EXIT_POLICY = ROOT / "supabase/functions/_shared/lob/exit.ts"
POLICY_MIGRATION = (
    ROOT
    / "supabase/migrations/20260801023000_enforce_v714_volatility_aware_exit_policy.sql"
)
LOCK_MIGRATION = ROOT / "supabase/migrations/20260801024500_lock_v714_exit_policy.sql"

engine = ENGINE.read_text(encoding="utf-8")
exit_policy = EXIT_POLICY.read_text(encoding="utf-8")
policy_migration = POLICY_MIGRATION.read_text(encoding="utf-8")
lock_migration = LOCK_MIGRATION.read_text(encoding="utf-8")

checks = {
    "engine version": 'const VERSION = "7.1.4-VOLATILITY-AWARE-EXIT";' in engine,
    "pre-60 target-only lock": "lob:pre-60-sell-lock-except-target" in engine,
    "60-180 persistent reversal rule": (
        "lob:60-180-hold-unless-target-or-qualified-reversal" in engine
    ),
    "30-second signal reversal": (
        'softReason === "SIGNAL_REVERSAL"' in engine and "? 30" in engine
    ),
    "50-second LOB invalidation": (
        'softReason === "LOB_INVALIDATION"' in engine and "? 50" in engine
    ),
    "post-180 net-positive exit": "guardedNetProfitQuote > 0" in engine,
    "post-180 minus-three stop": "lob:post-180-minus-3pct-stop" in engine,
    "soft signals do not sell immediately": "return hard(softReason" not in exit_policy,
    "v7.1.4 position function": (
        "enforce_v714_volatility_aware_position_policy" in policy_migration
    ),
    "v7.1.4 order guard": "guard_lob_sell_order_v714" in policy_migration,
    "v7.0.8 trigger removed": (
        "drop trigger if exists trading_positions_v708_profit_only_exit" in lock_migration
    ),
    "v7.1.3 position trigger removed": (
        "drop trigger if exists zz_trading_positions_exit_policy_v713" in lock_migration
    ),
    "v7.1.3 order guard removed": (
        "drop trigger if exists zz_trading_orders_lob_exit_guard_v713" in lock_migration
    ),
    "v7.1.4 position trigger locked": (
        "create trigger zz_trading_positions_exit_policy_v714" in lock_migration
    ),
    "v7.1.4 order trigger locked": (
        "create trigger zz_trading_orders_lob_exit_guard_v714" in lock_migration
    ),
}

failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit("v7.1.4 policy validation failed: " + ", ".join(failed))

for name in checks:
    print("PASS:", name)

print("PASS: v7.1.4 is immutable; this script performs no source mutation")
