from pathlib import Path

AUTOTRADER = Path("supabase/functions/market-autotrader/index.ts")
MIGRATION = Path("supabase/migrations/20260731033000_scalp_v7_1_0_risk_and_holding.sql")
POLICY_MARKER = "POST_180_FEE_NET_PROFIT_EXIT_V712"


def replace_once(path: Path, old: str, new: str, marker: str | None = None) -> None:
    text = path.read_text()
    count = text.count(old)
    if count == 1:
        path.write_text(text.replace(old, new))
        return
    if count == 0 and (marker or new) in text:
        return
    raise SystemExit(
        f"{path}: expected one old block or an already-applied marker; count={count}"
    )


old_monitor = '''      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
      const lobEntryPrice = finite(position.average_entry_price);
      // Fee-aware positive exit floor: round-trip fees plus a 2bp execution buffer.
      const lobProfitFloorPrice = lobEntryPrice > 0
        ? lobEntryPrice * (1 + (FEE_PCT[exchange] * 2 + 0.02) / 100)
        : Number.POSITIVE_INFINITY;
      // The 180-second LOB horizon is a review point, not a timeout.
      let decision = decideExit(
        position,
        current,
        Date.now(),
        settings.emergency_liquidation,
        !lobMode,
      );
      // LOB losses may only close at the explicit -5% boundary. Target/trail/other
      // ordinary exits are accepted only after estimated round-trip costs are recovered.
      if (lobMode && decision.action !== "NONE" && !settings.emergency_liquidation) {
        const hardStopHit = lobEntryPrice > 0 && current <= lobEntryPrice * 0.95;
        const profitReady = current >= lobProfitFloorPrice;
        if (!hardStopHit && !profitReady) {
          decision = { action: "NONE", fraction: 0, reason: "lob hold until profit or -5%" };
        }
      }'''

new_monitor = f'''      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
      const lobEntryPrice = finite(position.average_entry_price);
      const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
      const heldSeconds = Number.isFinite(openedAt)
        ? Math.max(0, (Date.now() - openedAt) / 1000)
        : 0;
      // {POLICY_MARKER}: after 180 seconds, the clock never forces a losing exit.
      // Estimated fee-net PnL is calculated on the remaining quantity. Upbit requires at
      // least KRW 1 net; Binance exits on any strictly positive USDT estimate.
      const lobFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);
      const lobRemainingQuantity = Math.max(0, finite(position.remaining_quantity));
      const lobEntryNotional = lobEntryPrice * lobRemainingQuantity;
      const lobExitNotional = current * lobRemainingQuantity;
      const lobNetProfitQuote = lobExitNotional * (1 - lobFeeRate) -
        lobEntryNotional * (1 + lobFeeRate);
      const lobHardStopHit = lobEntryPrice > 0 && current <= lobEntryPrice * 0.95;
      const lobPost180ProfitReady = heldSeconds >= 180 &&
        (exchange === "upbit" ? lobNetProfitQuote >= 1 : lobNetProfitQuote > 0);
      let decision = decideExit(
        position,
        current,
        Date.now(),
        settings.emergency_liquidation,
        !lobMode,
      );
      if (lobMode && !settings.emergency_liquidation) {
        if (lobHardStopHit) {
          decision = {{ action: "STOP", fraction: 1, reason: "lob:-5pct-hard-stop" }};
        }} else if (heldSeconds >= 180) {{
          decision = lobPost180ProfitReady
            ? {{ action: "TARGET_1", fraction: 1, reason: "lob:post-180-fee-net-profit" }}
            : {{ action: "NONE", fraction: 0, reason: "lob:post-180-hold-until-net-profit-or--5pct" }};
        }}
      }}'''

replace_once(AUTOTRADER, old_monitor, new_monitor, POLICY_MARKER)

old_held_seconds = '''        const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
        const heldSeconds = Number.isFinite(openedAt)
          ? Math.max(0, (Date.now() - openedAt) / 1000)
          : 0;'''
new_held_seconds = '''        // heldSeconds is computed before the primary LOB exit decision.'''
replace_once(AUTOTRADER, old_held_seconds, new_held_seconds, new_held_seconds)

replace_once(
    AUTOTRADER,
    '        const lobExitProfitReady = current >= lobProfitFloorPrice;',
    '        const lobExitProfitReady = exchange === "upbit"\n'
    '          ? lobNetProfitQuote >= 1\n'
    '          : lobNetProfitQuote > 0;',
    'lobNetProfitQuote >= 1',
)

MIGRATION.write_text("""do $$
begin
  if to_regclass('public.trading_settings') is null then return; end if;
  update public.trading_settings
  set max_daily_loss_pct = null,
      max_weekly_loss_pct = null,
      scalp_daily_loss_pct = 20,
      scalp_max_single_loss_pct = 5,
      lob_observation_window_ms = 45000,
      lob_max_holding_seconds = 180,
      lob_absolute_max_holding_seconds = null,
      lob_momentum_max_holding_seconds = 180,
      lob_rotation_enabled = false,
      residual_sweep_enabled = false,
      version = coalesce(version, 0) + 1,
      updated_at = now()
  where id = 1;
end $$;
""")

source = AUTOTRADER.read_text()
required = [
    POLICY_MARKER,
    'heldSeconds >= 180',
    'lobNetProfitQuote >= 1',
    'lobNetProfitQuote > 0',
    'lob:post-180-fee-net-profit',
    'lob:post-180-hold-until-net-profit-or--5pct',
    'lob:-5pct-hard-stop',
    '!lobMode,',
]
for needle in required:
    if needle not in source:
        raise SystemExit(f"{AUTOTRADER}: missing verification marker {needle!r}")

if 'lobProfitFloorPrice' in source:
    raise SystemExit(f"{AUTOTRADER}: obsolete buffered profit floor remains")

migration_source = MIGRATION.read_text()
for needle in [
    'max_daily_loss_pct = null',
    'max_weekly_loss_pct = null',
    'scalp_daily_loss_pct = 20',
    'scalp_max_single_loss_pct = 5',
    'lob_absolute_max_holding_seconds = null',
    'residual_sweep_enabled = false',
]:
    if needle not in migration_source:
        raise SystemExit(f"{MIGRATION}: missing verification marker {needle!r}")
