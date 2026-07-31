from pathlib import Path

RELEASE = "7.1.0-LOB-45S-180-300-RISK20"


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    old_count = text.count(old)
    if old_count == 1:
        p.write_text(text.replace(old, new))
        return
    if old_count == 0 and new in text:
        return
    raise SystemExit(f"{path}: expected one old marker or an already-applied new marker; old_count={old_count}")


def replace_all(path: str, old: str, new: str, minimum: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    old_count = text.count(old)
    if old_count >= minimum:
        p.write_text(text.replace(old, new))
        return
    if old_count == 0 and new in text:
        return
    raise SystemExit(f"{path}: expected at least {minimum} old markers or an already-applied new marker; old_count={old_count}")


scanner = "supabase/functions/market-scanner/index.ts"
replace_once(
    scanner,
    "// Trading-booooo Market Scanner v7.0.5-LOB-30S-MINIMUM — Supabase Edge Function",
    f"// Trading-booooo Market Scanner v{RELEASE} — Supabase Edge Function",
)
replace_once(
    scanner,
    "// A 32-second collection timer gives the first/last websocket frame enough margin to prove\n"
    "// at least 30 seconds of actual order-book and tape coverage.\n"
    "const DEFAULT_DYNAMIC_OBSERVATION_MS = 32_000;\n"
    "const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 35_000;\n"
    "const MIN_DYNAMIC_OBSERVATION_MS = 32_000;\n"
    "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;\n"
    "// Every symbol must receive its own full 30-second wall-clock observation window.\n"
    "// The global socket-open timer alone is insufficient because a symbol's first frame can arrive late.\n"
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 30_000;",
    "// The collector runs slightly beyond the required per-market window so late first frames\n"
    "// still receive a full 45 seconds. Low-liquidity books may use the 60-second ceiling.\n"
    "const DEFAULT_DYNAMIC_OBSERVATION_MS = 47_000;\n"
    "const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 60_000;\n"
    "const MIN_DYNAMIC_OBSERVATION_MS = 47_000;\n"
    "const MAX_DYNAMIC_OBSERVATION_MS = 60_000;\n"
    "// Every symbol must receive its own full 45-second wall-clock observation window.\n"
    "// The global socket-open timer alone is insufficient because a symbol's first frame can arrive late.\n"
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 45_000;",
)
replace_once(
    scanner,
    'finite(Deno.env.get("LOB_OBSERVATION_MS"), 32_000),\n    32_000,\n    60_000,',
    'finite(Deno.env.get("LOB_OBSERVATION_MS"), DEFAULT_DYNAMIC_OBSERVATION_MS),\n'
    '    MIN_DYNAMIC_OBSERVATION_MS,\n'
    '    MAX_DYNAMIC_OBSERVATION_MS,',
)
replace_once(
    scanner,
    'lob: "Top 10 중 흐름 유지 종목 최소 30초 실시간 호가·체결",',
    'lob: "Top 10 중 흐름 유지 종목 최소 45초 실시간 호가·체결",',
)

engine = "supabase/functions/market-scanner/engine.ts"
replace_once(
    engine,
    "// Trading-booooo Market Scanner v7.0.5-LOB-30S-MINIMUM",
    f"// Trading-booooo Market Scanner v{RELEASE}",
)
replace_once(
    engine,
    'export const ENGINE_VERSION = "7.0.5-LOB-30S-MINIMUM";',
    f'export const ENGINE_VERSION = "{RELEASE}";',
)
replace_once(engine, "const DYNAMIC_MIN_OBSERVATION_MS = 30_000;", "const DYNAMIC_MIN_OBSERVATION_MS = 45_000;")
replace_once(engine, "const DYNAMIC_MIN_BOOK_UPDATES = 12;", "const DYNAMIC_MIN_BOOK_UPDATES = 25;")
replace_once(engine, "const DYNAMIC_MIN_TRADES = 8;", "const DYNAMIC_MIN_TRADES = 20;")
replace_once(
    engine,
    'finiteOr((risk.scalpOverrides || {}).maxHoldingSeconds, 180), 1, 300',
    'finiteOr((risk.scalpOverrides || {}).maxHoldingSeconds, 300), 1, 300',
)

entry = "supabase/functions/_shared/lob/entry.ts"
replace_once(entry, "minObservationMs: 30_000,", "minObservationMs: 45_000,")
replace_once(
    entry,
    "// Ordinary 180-second LOB events remain capped at 60bp. The separately identified momentum",
    "// Ordinary 300-second LOB events remain capped at 60bp. The separately identified momentum",
)
replace_once(entry, "maxHoldingSeconds: 180,", "maxHoldingSeconds: 300,")
replace_once(
    entry,
    "Math.max(1, isMomentum ? Math.min(90, cfg.maxHoldingSeconds) : cfg.maxHoldingSeconds),",
    "Math.max(1, isMomentum ? Math.min(180, cfg.maxHoldingSeconds) : cfg.maxHoldingSeconds),",
)

autotrader = "supabase/functions/market-autotrader/index.ts"
replace_once(
    autotrader,
    "// Trading-booooo v7.0.7-LOB-SCAN-PLAN-LOCK — autonomous spot orchestrator.",
    f"// Trading-booooo v{RELEASE} — autonomous spot orchestrator.",
)
replace_once(
    autotrader,
    'const VERSION = "7.0.7-LOB-SCAN-PLAN-LOCK";',
    f'const VERSION = "{RELEASE}";',
)
replace_once(
    autotrader,
    'scalp_daily_loss_pct: clamp(finite(env("SCALP_DAILY_LOSS_PCT"), 30), 0.1, 100),',
    'scalp_daily_loss_pct: clamp(finite(env("SCALP_DAILY_LOSS_PCT"), 20), 0.1, 100),',
)
replace_once(
    autotrader,
    'max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 30),',
    'max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 20),',
)
replace_all(
    autotrader,
    'finite((settings as any).lob_max_holding_seconds, 180)',
    'finite((settings as any).lob_max_holding_seconds, 300)',
    2,
)
replace_once(
    autotrader,
    'finite(position.metadata?.lob_signal?.max_holding_seconds, 180)',
    'finite(position.metadata?.lob_signal?.max_holding_seconds, 300)',
)

core = "supabase/functions/market-autotrader/core.ts"
replace_once(
    core,
    "// v5.8: SCALP passes false. Holding time no longer closes anything — a position is sold\n"
    "  // when the market says so (stop, target, trail, live edge, flow reversal, liquidity\n"
    "  // event), never because a clock ran out.",
    "// v7.1: the approved holding deadline is always a hard exit boundary, including SCALP.\n"
    "  // Losses may not be extended beyond the signal's 180/300-second lifetime.",
)

migration = Path("supabase/migrations/20260731033000_scalp_v7_1_0_risk_and_holding.sql")
if not migration.exists():
    migration.write_text("""do $$
declare
  has_table boolean := to_regclass('public.trading_settings') is not null;
begin
  if not has_table then
    return;
  end if;

  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='scalp_daily_loss_pct') then
    execute 'update public.trading_settings set scalp_daily_loss_pct = 20 where id = 1';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='scalp_max_single_loss_pct') then
    execute 'update public.trading_settings set scalp_max_single_loss_pct = 5 where id = 1';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='lob_max_holding_seconds') then
    execute 'update public.trading_settings set lob_max_holding_seconds = 300 where id = 1';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='lob_absolute_max_holding_seconds') then
    execute 'update public.trading_settings set lob_absolute_max_holding_seconds = 300 where id = 1';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='version') then
    execute 'update public.trading_settings set version = coalesce(version, 0) + 1 where id = 1';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trading_settings' and column_name='updated_at') then
    execute 'update public.trading_settings set updated_at = now() where id = 1';
  end if;
end $$;
""")

checks = {
    scanner: [
        f"Market Scanner v{RELEASE}",
        "REQUIRED_PER_MARKET_OBSERVATION_MS = 45_000",
        "DEFAULT_DYNAMIC_OBSERVATION_MS = 47_000",
    ],
    engine: [
        f'ENGINE_VERSION = "{RELEASE}"',
        "DYNAMIC_MIN_OBSERVATION_MS = 45_000",
        "DYNAMIC_MIN_BOOK_UPDATES = 25",
        "DYNAMIC_MIN_TRADES = 20",
    ],
    entry: [
        "minObservationMs: 45_000",
        "maxHoldingSeconds: 300",
        "Math.min(180, cfg.maxHoldingSeconds)",
    ],
    autotrader: [
        'SCALP_DAILY_LOSS_PCT"), 20',
        "lob_max_holding_seconds, 300",
        f'const VERSION = "{RELEASE}"',
    ],
    "supabase/functions/_shared/lob/exit.ts": [
        'return hard("TIMEOUT", 70)',
        'return hard(softReason, severe ? 82 : 78)',
    ],
}
for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"{path}: missing verification marker {needle!r}")
