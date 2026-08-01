from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "supabase/functions/market-autotrader/index.ts"
EXIT = ROOT / "supabase/functions/_shared/lob/exit.ts"
MIGRATION = ROOT / "supabase/migrations/20260801023000_enforce_v714_volatility_aware_exit_policy.sql"

text = INDEX.read_text(encoding="utf-8")

text = text.replace(
    "// Trading-booooo v7.1.1-LOB-45S-PROFIT-OR-5PCT — autonomous spot orchestrator.",
    "// Trading-booooo v7.1.4-VOLATILITY-AWARE-EXIT — autonomous spot orchestrator.",
    1,
)
text = text.replace(
    'const VERSION = "7.1.3-180S-NET1-OR-MINUS3";',
    'const VERSION = "7.1.4-VOLATILITY-AWARE-EXIT";',
    1,
)

old_hard_stop = '''      const lobHardStopHit = lobEntryPrice > 0 && current <= lobEntryPrice * 0.95;
      const lobPost180ProfitReady = heldSeconds >= 180 &&
        (exchange === "upbit" ? lobNetProfitQuote >= 1 : lobNetProfitQuote > 0);'''
new_hard_stop = '''      const lobHardStopHit = heldSeconds >= 180 &&
        lobEntryPrice > 0 && current <= lobEntryPrice * 0.97;
      const lobPost180ProfitReady = heldSeconds >= 180 && lobNetProfitQuote > 0;'''
if old_hard_stop not in text:
    raise SystemExit("hard-stop patch point missing")
text = text.replace(old_hard_stop, new_hard_stop, 1)
text = text.replace('reason: "lob:-5pct-hard-stop"', 'reason: "lob:post-180-minus-3pct-stop"', 1)
text = text.replace(
    'reason: "lob:post-180-hold-until-net-profit-or--5pct"',
    'reason: "lob:post-180-hold-until-net-positive-or-minus3pct"',
    1,
)

soft_meta_pattern = re.compile(
    r'''        if \(\n          exit\.nextSoftReason !== \(position\.metadata\?\.lob_soft_exit_reason \|\| null\) \|\|\n          exit\.nextSoftSignalStreak !== finite\(position\.metadata\?\.lob_soft_exit_streak\)\n        \) \{.*?\n        \}\n        const lobExitSafetyReason''',
    re.S,
)
soft_meta_replacement = '''        const softReason = exit.nextSoftReason;
        const priorSoftReason = position.metadata?.lob_soft_exit_reason || null;
        const priorSoftStartedAt = Date.parse(
          String(position.metadata?.lob_soft_exit_started_at || ""),
        );
        // The first minute never contributes to a reversal timer. A signal must remain
        // continuously adverse after second 60 before it can authorize a losing exit.
        const softWindowEligible = heldSeconds >= 60 && heldSeconds < 180 && softReason !== null;
        const earliestSoftStart = Number.isFinite(openedAt) ? openedAt + 60_000 : Date.now();
        const canReuseSoftStart = softWindowEligible && priorSoftReason === softReason &&
          Number.isFinite(priorSoftStartedAt) && priorSoftStartedAt >= earliestSoftStart;
        const softStartedAtMs = softWindowEligible
          ? (canReuseSoftStart ? priorSoftStartedAt : Date.now())
          : Number.NaN;
        const softRequiredSeconds = softReason === "SIGNAL_REVERSAL"
          ? 30
          : softReason === "LOB_INVALIDATION"
          ? 50
          : 0;
        const softSignalAgeSeconds = softWindowEligible && Number.isFinite(softStartedAtMs)
          ? Math.max(0, (Date.now() - softStartedAtMs) / 1000)
          : 0;
        const softExitQualified = softWindowEligible && softRequiredSeconds > 0 &&
          softSignalAgeSeconds >= softRequiredSeconds;
        const softStartedAtIso = Number.isFinite(softStartedAtMs)
          ? new Date(softStartedAtMs).toISOString()
          : null;
        const softMetadataChanged =
          softReason !== priorSoftReason ||
          exit.nextSoftSignalStreak !== finite(position.metadata?.lob_soft_exit_streak) ||
          String(position.metadata?.lob_soft_exit_started_at || "") !==
            String(softStartedAtIso || "") ||
          finite(position.metadata?.lob_soft_exit_required_seconds) !== softRequiredSeconds ||
          Boolean(position.metadata?.lob_soft_exit_qualified) !== softExitQualified;
        if (softMetadataChanged) {
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                lob_soft_exit_reason: softReason,
                lob_soft_exit_streak: exit.nextSoftSignalStreak,
                lob_soft_exit_started_at: softStartedAtIso,
                lob_soft_exit_required_seconds: softRequiredSeconds,
                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_profile_version: finite(
                  pinnedCoinPolicy.profile_version,
                  fallbackOnlinePolicy.profileVersion,
                ),
                lob_soft_exit_policy_version: entryPolicyVersion >= 0
                  ? entryPolicyVersion
                  : championPolicy?.version ?? 0,
                lob_soft_exit_last_checked_at: new Date().toISOString(),
              },
            }))[0],
          };
        }
        const lobExitSafetyReason'''
text, count = soft_meta_pattern.subn(soft_meta_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"soft metadata patch count={count}")

old_soft_decision = '''        const lobExitProfitReady = exchange === "upbit"
          ? lobNetProfitQuote >= 1
          : lobNetProfitQuote > 0;
        if (exit.exit && (lobExitSafetyReason || lobExitProfitReady)) {
          decision = {
            action: exit.reason === "TARGET_HIT" ? "TARGET_1" : "STOP",
            fraction: 1,
            reason: `lob:${exit.reason}`,
          } as any;'''
new_soft_decision = '''        const lobSoftExitReady = softExitQualified && softReason !== null;
        if (exit.reason === "TARGET_HIT" || lobSoftExitReady || lobExitSafetyReason) {
          const approvedReason = lobSoftExitReady ? softReason : exit.reason;
          decision = {
            action: approvedReason === "TARGET_HIT" ? "TARGET_1" : "STOP",
            fraction: 1,
            reason: `lob:${approvedReason}`,
          } as any;'''
if old_soft_decision not in text:
    raise SystemExit("soft decision patch point missing")
text = text.replace(old_soft_decision, new_soft_decision, 1)
text = text.replace(
    'await event("LOB_EXIT", `${exchange}:${position.market} ${exit.reason}`, {\n            ...exit,',
    'await event("LOB_EXIT", `${exchange}:${position.market} ${approvedReason}`, {\n            ...exit,\n            reason: approvedReason,',
    1,
)

final_pattern = re.compile(
    r'''\n      // v7\.1\.3 canonical LOB exit policy\..*?\n      if \(decision\.action === "NONE"\) continue;''',
    re.S,
)
final_replacement = '''
      // v7.1.4 volatility-aware LOB exit policy. This final override is the only
      // non-emergency authority allowed to approve an executable sell.
      if (lobMode && !settings.emergency_liquidation) {
        const policyFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);
        const policyQuantity = Math.max(0, finite(position.remaining_quantity));
        const policyShortfallBps = exchange === "upbit" ? 20 : 50;
        const guardedExitPrice = current * (1 - policyShortfallBps / 10000);
        const policyEntryCost = lobEntryPrice * policyQuantity * (1 + policyFeeRate);
        const guardedNetProfitQuote = guardedExitPrice * policyQuantity * (1 - policyFeeRate) -
          policyEntryCost;
        const drawdownPct = lobEntryPrice > 0 ? (current / lobEntryPrice - 1) * 100 : 0;
        const requestedAction = decision.action;
        const requestedReason = String((decision as any).reason || "");
        const targetRequested = requestedAction === "TARGET_1" || requestedAction === "TARGET_2";
        const reversalRequested = requestedAction === "STOP" &&
          (requestedReason === "lob:SIGNAL_REVERSAL" ||
            requestedReason === "lob:LOB_INVALIDATION");
        const reversalQualified = Boolean(position.metadata?.lob_soft_exit_qualified);

        if (heldSeconds < 60) {
          decision = targetRequested
            ? {
              action: "TARGET_1",
              fraction: 1,
              reason: "lob:pre-60-target-only",
            }
            : {
              action: "NONE",
              fraction: 0,
              reason: "lob:pre-60-sell-lock-except-target",
            };
        } else if (heldSeconds < 180) {
          if (targetRequested) {
            decision = {
              action: "TARGET_1",
              fraction: 1,
              reason: "lob:60-180-target",
            };
          } else if (reversalRequested && reversalQualified) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: requestedReason,
            };
          } else {
            decision = {
              action: "NONE",
              fraction: 0,
              reason: "lob:60-180-hold-unless-target-or-qualified-reversal",
            };
          }
        } else if (guardedNetProfitQuote > 0) {
          decision = {
            action: "TARGET_1",
            fraction: 1,
            reason: "lob:post-180-guarded-net-positive",
          };
        } else if (drawdownPct <= -3) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "lob:post-180-minus-3pct-stop",
          };
        } else {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "lob:post-180-hold-until-net-positive-or-minus3pct",
          };
        }

        if (decision.action !== "NONE") {
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                exit_policy_quote: {
                  revision: "7.1.4-VOLATILITY-AWARE-EXIT",
                  price: current,
                  measured_at: new Date().toISOString(),
                  held_seconds: heldSeconds,
                  guarded_net_profit_quote: guardedNetProfitQuote,
                  drawdown_pct: drawdownPct,
                  requested_action: requestedAction,
                  requested_reason: requestedReason,
                  reversal_qualified: reversalQualified,
                  soft_signal_age_seconds: finite(
                    position.metadata?.lob_soft_exit_started_at
                      ? (Date.now() - Date.parse(String(position.metadata.lob_soft_exit_started_at))) /
                        1000
                      : 0,
                  ),
                  soft_signal_required_seconds: finite(
                    position.metadata?.lob_soft_exit_required_seconds,
                  ),
                  approved_action: decision.action,
                  approved_reason: (decision as any).reason,
                },
              },
            }))[0],
          };
        }
      }

      if (decision.action === "NONE") continue;'''
text, count = final_pattern.subn(final_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"canonical policy patch count={count}")

INDEX.write_text(text, encoding="utf-8")

EXIT.write_text('''// Trading-booooo v7.1.4 — LOB signal classification for volatility-aware exits.
// Hard target/stop detection is immediate, but soft LOB signals are only classified here.
// The monitor owns the 60-second sell lock and the 30/50-second persistence windows.

export type LobExitReason =
  | "RISK_EMERGENCY"
  | "RECONCILIATION_FAILURE"
  | "STOP_HIT"
  | "LOB_INVALIDATION"
  | "SIGNAL_REVERSAL"
  | "TARGET_HIT"
  | "TIMEOUT"
  | "HOLD";

export interface LobExitInput {
  emergency: boolean;
  reconciliationFailed: boolean;
  currentPrice: number;
  stopPrice: number;
  targetPrice: number;
  heldSeconds: number;
  maxHoldingSeconds: number;
  bookImbalance: number;
  tradePressure: number;
  micropriceDeviationBps: number;
  spreadBps: number;
  maxSpreadBps: number;
  bidDepthRatio: number;
  minBidDepthRatio: number;
  dynamicStatus?: string;
  previousSoftReason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  softSignalStreak?: number;
  softExitConfirmations?: number;
  softExitGraceSeconds?: number;
}

export interface LobExitDecision {
  exit: boolean;
  reason: LobExitReason;
  priority: number;
  nextSoftReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  nextSoftSignalStreak: number;
  severeSoftSignal: boolean;
}

function hold(input: {
  reason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  streak?: number;
  severe?: boolean;
} = {}): LobExitDecision {
  return {
    exit: false,
    reason: "HOLD",
    priority: 0,
    nextSoftReason: input.reason ?? null,
    nextSoftSignalStreak: Math.max(0, Math.floor(Number(input.streak) || 0)),
    severeSoftSignal: Boolean(input.severe),
  };
}

export function evaluateLobExit(input: LobExitInput): LobExitDecision {
  const hard = (reason: LobExitReason, priority: number): LobExitDecision => ({
    exit: true,
    reason,
    priority,
    nextSoftReason: null,
    nextSoftSignalStreak: 0,
    severeSoftSignal: false,
  });

  if (input.emergency) return hard("RISK_EMERGENCY", 100);
  if (input.reconciliationFailed) return hard("RECONCILIATION_FAILURE", 95);
  if (Number.isFinite(input.stopPrice) && input.stopPrice > 0 && input.currentPrice <= input.stopPrice) {
    return hard("STOP_HIT", 90);
  }
  if (Number.isFinite(input.targetPrice) && input.targetPrice > 0 && input.currentPrice >= input.targetPrice) {
    return hard("TARGET_HIT", 85);
  }

  const invalidStatus = new Set([
    "SUPPORT_BREAKDOWN_RISK",
    "SPOOF_LIKE_RISK",
    "ASK_ABSORPTION_RISK",
  ]);
  const invalidated = invalidStatus.has(String(input.dynamicStatus || "")) ||
    input.spreadBps > input.maxSpreadBps ||
    input.bidDepthRatio < input.minBidDepthRatio;
  const reversed = input.bookImbalance <= -0.20 &&
    input.tradePressure <= -0.20 &&
    input.micropriceDeviationBps < 0;
  const softReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null = invalidated
    ? "LOB_INVALIDATION"
    : reversed
    ? "SIGNAL_REVERSAL"
    : null;

  if (softReason) {
    const nextStreak = input.previousSoftReason === softReason
      ? Math.max(0, Math.floor(Number(input.softSignalStreak) || 0)) + 1
      : 1;
    const severe = input.spreadBps > input.maxSpreadBps * 2 ||
      input.bidDepthRatio < input.minBidDepthRatio * 0.25 ||
      (input.bookImbalance <= -0.65 && input.tradePressure <= -0.65 &&
        input.micropriceDeviationBps < 0);
    // Never convert a transient or even severe soft signal directly into a sell here.
    // Continuous elapsed time is enforced by market-autotrader after the first 60 seconds.
    return hold({ reason: softReason, streak: nextStreak, severe });
  }

  return hold();
}
''', encoding="utf-8")

MIGRATION.write_text(r'''begin;

-- Replace the v7.1.3 guards so the database enforces the same state machine as the engine.
drop trigger if exists zz_trading_positions_exit_policy_v713 on public.trading_positions;
drop trigger if exists zz_trading_orders_lob_exit_guard_v713 on public.trading_orders;
drop function if exists public.enforce_v713_net1_minus3_position_policy();
drop function if exists public.guard_lob_sell_order_v713();

create or replace function public.enforce_v714_volatility_aware_position_policy()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_shortfall_bps numeric;
  v_entry_cost numeric;
  v_min_target numeric;
begin
  if new.is_paper is distinct from false or new.state <> 'OPEN' then
    return new;
  end if;

  if upper(coalesce(new.metadata#>>'{lob_signal,strategy}', new.metadata#>>'{scalp_signal,strategy}', '')) <> 'LOB_SCALP' then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  v_qty := greatest(coalesce(nullif(new.remaining_quantity, 0), nullif(new.initial_quantity, 0), 0), 0);
  if coalesce(v_entry, 0) <= 0 then
    return new;
  end if;

  v_fee_rate := case when lower(new.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_shortfall_bps := case when lower(new.exchange) = 'upbit' then 20 else 50 end;

  new.stop_price := v_entry * 0.97;
  new.max_holding_at := 'infinity'::timestamptz;

  if v_qty > 0 then
    v_entry_cost := v_entry * v_qty * (1 + v_fee_rate);
    v_min_target := ((v_entry_cost + 1) / (v_qty * (1 - v_fee_rate)))
                    / (1 - v_shortfall_bps / 10000.0);
    new.target_1 := greatest(coalesce(nullif(new.target_1, 0), v_min_target), v_min_target);
    new.target_2 := greatest(coalesce(nullif(new.target_2, 0), new.target_1), new.target_1, v_min_target);
  end if;

  new.trailing_stop := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.1.4-VOLATILITY-AWARE-EXIT',
    'pre_60_exit_rule', 'TARGET_ONLY',
    'seconds_60_to_180_exit_rule', 'TARGET_OR_PERSISTENT_REVERSAL',
    'post_180_exit_rule', 'GUARDED_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_3PCT',
    'reversal_timer_starts_after_seconds', 60,
    'signal_reversal_required_seconds', 30,
    'lob_invalidation_required_seconds', 50,
    'hard_stop_return_pct', -3,
    'minimum_post_180_net_quote', 0,
    'target_shortfall_safety_bps', v_shortfall_bps,
    'timeout_loss_exit_enabled', false,
    'trail_exit_enabled', false,
    'lob_invalidation_exit_enabled', true,
    'policy_enforced_at', now()
  );
  return new;
end;
$function$;

create trigger zz_trading_positions_exit_policy_v714
before insert or update on public.trading_positions
for each row execute function public.enforce_v714_volatility_aware_position_policy();

create or replace function public.guard_lob_sell_order_v714()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_strategy text;
  v_held_seconds numeric;
  v_entry numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_shortfall_bps numeric;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_guarded_fill_price numeric;
  v_guarded_net numeric;
  v_drawdown_pct numeric;
  v_purpose text;
  v_requested_reason text;
  v_soft_qualified boolean;
  v_soft_age numeric;
  v_soft_required numeric;
  v_target numeric;
  v_target_reached boolean;
  v_is_resting_target boolean;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  v_purpose := upper(coalesce(new.purpose, ''));
  if v_purpose = 'EMERGENCY' then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then
    return new;
  end if;

  v_strategy := upper(coalesce(p.metadata#>>'{lob_signal,strategy}', p.metadata#>>'{scalp_signal,strategy}', ''));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_held_seconds := greatest(0, extract(epoch from (now() - coalesce(p.opened_at, p.created_at, now()))));
  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), greatest(coalesce(p.remaining_quantity, 0), 0));
  v_target := coalesce(nullif(p.target_1, 0), nullif(p.target_2, 0));

  -- A resting limit target may be placed at entry; it cannot fill below the approved target.
  v_is_resting_target := v_purpose in ('TARGET_1', 'TARGET_2')
    and upper(coalesce(new.order_type, '')) <> 'MARKET'
    and coalesce(new.requested_price, 0) >= coalesce(v_target, 0)
    and coalesce(v_target, 0) > 0;
  if v_is_resting_target then
    return new;
  end if;

  v_quote_price := nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric;
  v_quote_at := nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz;
  v_requested_reason := coalesce(p.metadata#>>'{exit_policy_quote,requested_reason}', '');
  v_soft_qualified := coalesce((p.metadata#>>'{exit_policy_quote,reversal_qualified}')::boolean, false);
  v_soft_age := coalesce(nullif(p.metadata#>>'{exit_policy_quote,soft_signal_age_seconds}', '')::numeric, 0);
  v_soft_required := coalesce(nullif(p.metadata#>>'{exit_policy_quote,soft_signal_required_seconds}', '')::numeric, 0);

  if coalesce(v_entry, 0) <= 0 or v_qty <= 0 or coalesce(v_quote_price, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'V714_EXIT_BLOCK_MISSING_ECONOMICS market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;
  if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'V714_EXIT_BLOCK_STALE_QUOTE market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_shortfall_bps := case when lower(p.exchange) = 'upbit' then 20 else 50 end;
  v_guarded_fill_price := v_quote_price * (1 - v_shortfall_bps / 10000.0);
  v_guarded_net := v_guarded_fill_price * v_qty * (1 - v_fee_rate)
                   - v_entry * v_qty * (1 + v_fee_rate);
  v_drawdown_pct := (v_quote_price / v_entry - 1) * 100;
  v_target_reached := coalesce(v_target, 0) > 0 and v_quote_price >= v_target;

  if v_held_seconds < 60 then
    if v_purpose in ('TARGET_1', 'TARGET_2') and v_target_reached then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V714_PRE60_SELL_LOCK market=%s purpose=%s held=%s',
      new.market, v_purpose, round(v_held_seconds, 3)
    );
  end if;

  if v_held_seconds < 180 then
    if v_purpose in ('TARGET_1', 'TARGET_2') and v_target_reached then
      return new;
    end if;
    if v_purpose = 'STOP'
       and v_requested_reason in ('lob:SIGNAL_REVERSAL', 'lob:LOB_INVALIDATION')
       and v_soft_qualified
       and v_soft_required in (30, 50)
       and v_soft_age >= v_soft_required then
      return new;
    end if;
    raise exception using errcode='23514', message=format(
      'V714_60_180_EXIT_BLOCKED market=%s purpose=%s held=%s reason=%s age=%s required=%s',
      new.market, v_purpose, round(v_held_seconds, 3), v_requested_reason,
      round(v_soft_age, 3), round(v_soft_required, 3)
    );
  end if;

  if v_guarded_net > 0 then
    if v_purpose not in ('TARGET_1', 'TARGET_2') then
      raise exception using errcode='23514', message=format(
        'V714_POST180_PROFIT_MUST_BE_TARGET market=%s purpose=%s guarded_net=%s',
        new.market, v_purpose, round(v_guarded_net, 8)
      );
    end if;
    return new;
  end if;

  if v_drawdown_pct <= -3 then
    if v_purpose <> 'STOP' then
      raise exception using errcode='23514', message=format(
        'V714_MINUS3_EXIT_MUST_BE_STOP market=%s purpose=%s drawdown_pct=%s',
        new.market, v_purpose, round(v_drawdown_pct, 6)
      );
    end if;
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'V714_POST180_HOLD market=%s purpose=%s held=%s guarded_net=%s drawdown_pct=%s',
    new.market, v_purpose, round(v_held_seconds, 3), round(v_guarded_net, 8), round(v_drawdown_pct, 6)
  );
end;
$function$;

drop trigger if exists trading_orders_target_fee_net_guard_v722 on public.trading_orders;
create trigger zz_trading_orders_lob_exit_guard_v714
before insert on public.trading_orders
for each row execute function public.guard_lob_sell_order_v714();

update public.trading_positions
set updated_at = now()
where is_paper is false and state = 'OPEN'
  and upper(coalesce(metadata#>>'{lob_signal,strategy}', metadata#>>'{scalp_signal,strategy}', '')) = 'LOB_SCALP';

update public.trading_settings
set lob_max_holding_seconds = 180,
    lob_absolute_max_holding_seconds = 180,
    lob_profit_protect_enabled = false,
    scalp_max_single_loss_pct = 3,
    version = version + 1,
    updated_at = now()
where id = 1;

commit;
''', encoding="utf-8")

final = INDEX.read_text(encoding="utf-8")
checks = {
    "engine version": 'const VERSION = "7.1.4-VOLATILITY-AWARE-EXIT";' in final,
    "pre-60 target-only state": "lob:pre-60-sell-lock-except-target" in final,
    "60-180 target-or-reversal state": "lob:60-180-hold-unless-target-or-qualified-reversal" in final,
    "30-second signal reversal": 'softReason === "SIGNAL_REVERSAL"\n          ? 30' in final,
    "50-second invalidation": 'softReason === "LOB_INVALIDATION"\n          ? 50' in final,
    "post-180 positive net": "guardedNetProfitQuote > 0" in final,
    "post-180 minus-three stop": "lob:post-180-minus-3pct-stop" in final,
    "requested reason audit": "requested_reason: requestedReason" in final,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit("policy checks failed: " + ", ".join(failed))
for name in checks:
    print("PASS:", name)
print("PASS: wrote", EXIT.relative_to(ROOT))
print("PASS: wrote", MIGRATION.relative_to(ROOT))
