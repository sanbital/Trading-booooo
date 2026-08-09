from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
MIGRATION = Path("supabase/migrations/20260809120000_recovery_net_positive_exit_v753.sql")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


text = INDEX.read_text()

if 'const VERSION = "7.5.3-RECOVERY-NET-POSITIVE";' not in text:
    text = replace_once(
        text,
        'const VERSION = "7.5.2-RESIDUAL-TP10-SL4";',
        'const VERSION = "7.5.3-RECOVERY-NET-POSITIVE";',
        "version",
    )

if 'from "./recovery-exit-policy.ts";' not in text:
    text = replace_once(
        text,
        '} from "./executable-exit.ts";\nimport { buildTradingHeartbeatPatch, type TradingHeartbeatPatch } from "./heartbeat.ts";',
        '} from "./executable-exit.ts";\nimport { halfHoldRecoveryExitDecision } from "./recovery-exit-policy.ts";\nimport { buildTradingHeartbeatPatch, type TradingHeartbeatPatch } from "./heartbeat.ts";',
        "recovery policy import",
    )

if 'blockedEvent = "POSITIVE_NET_AFTER_180S_BLOCKED"' not in text:
    text = replace_once(
        text,
        '''async function preparePositiveNetAfter180Exit(\n  position: Position,\n  requestedQuantity: number,\n  settings: TradingSettings & JsonRecord,\n  cycleId: string,\n): Promise<ProtectedPositiveNetQuote | null> {''',
        '''async function preparePositiveNetAfter180Exit(\n  position: Position,\n  requestedQuantity: number,\n  settings: TradingSettings & JsonRecord,\n  cycleId: string,\n  blockedEvent = "POSITIVE_NET_AFTER_180S_BLOCKED",\n): Promise<ProtectedPositiveNetQuote | null> {''',
        "protected positive helper signature",
    )
    text = replace_once(
        text,
        '      "POSITIVE_NET_AFTER_180S_BLOCKED",',
        '      blockedEvent,',
        "protected positive block event",
    )

old_apply_flags = '''  const targetAction = action === "TARGET_1" || action === "TARGET_2";\n  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";\n  const residualThresholdExit = decisionReason === "RESIDUAL_TAKE_PROFIT_10" ||\n    decisionReason === "RESIDUAL_STOP_LOSS_4";'''
new_apply_flags = '''  const targetAction = action === "TARGET_1" || action === "TARGET_2";\n  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";\n  const recoveryNetPositive = decisionReason === "RECOVERY_NET_POSITIVE_EXIT";\n  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive;\n  const residualThresholdExit = decisionReason === "RESIDUAL_TAKE_PROFIT_10" ||\n    decisionReason === "RESIDUAL_STOP_LOSS_4" || recoveryNetPositive;'''
if "const recoveryNetPositive =" not in text:
    text = replace_once(text, old_apply_flags, new_apply_flags, "applyExit recovery flags")

old_positive_guard = '''  const protectedPositiveNet = !position.is_paper && positiveNetAfter180 && settings\n    ? await preparePositiveNetAfter180Exit(position, quantity, settings, cycleId)\n    : null;\n  if (!position.is_paper && positiveNetAfter180 && !protectedPositiveNet) {\n    return {\n      action: "NONE",\n      reason: "positive-net order-time recheck blocked; position retained",\n    };\n  }'''
new_positive_guard = '''  const protectedPositiveNet = !position.is_paper && positiveNetGuardedExit && settings\n    ? await preparePositiveNetAfter180Exit(\n      position,\n      quantity,\n      settings,\n      cycleId,\n      recoveryNetPositive ? "RECOVERY_NET_POSITIVE_BLOCKED" : "POSITIVE_NET_AFTER_180S_BLOCKED",\n    )\n    : null;\n  if (!position.is_paper && positiveNetGuardedExit && !protectedPositiveNet) {\n    return {\n      action: "NONE",\n      reason: recoveryNetPositive\n        ? "recovery net-positive order-time recheck blocked; position retained"\n        : "positive-net order-time recheck blocked; position retained",\n    };\n  }'''
if "recovery net-positive order-time recheck blocked" not in text:
    text = replace_once(text, old_positive_guard, new_positive_guard, "order-time recovery guard")

old_nofill = '''      positiveNetAfter180\n        ? "POSITIVE_NET_AFTER_180S_FOK_NOT_FILLED"\n        : "TARGET_PROTECTED_ORDER_NOT_FILLED",'''
new_nofill = '''      recoveryNetPositive\n        ? "RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"\n        : positiveNetAfter180\n        ? "POSITIVE_NET_AFTER_180S_FOK_NOT_FILLED"\n        : "TARGET_PROTECTED_ORDER_NOT_FILLED",'''
if "RECOVERY_NET_POSITIVE_FOK_NOT_FILLED" not in text:
    text = replace_once(text, old_nofill, new_nofill, "recovery FOK event")

finalize_anchor = '''  let finalized = await finalizeExitFill(\n    position,\n    result,\n    action,\n    protectedLimit?.limitPrice || price,\n    cycleId,\n    breakevenAfterT1,\n  );\n  if (\n    (targetAction || positiveNetAfter180) && finalized?.closed &&'''
finalize_replacement = '''  let finalized = await finalizeExitFill(\n    position,\n    result,\n    action,\n    protectedLimit?.limitPrice || price,\n    cycleId,\n    breakevenAfterT1,\n  );\n  if (\n    decisionReason === "HALF_HOLD_STOP_LOSS_4" &&\n    !finalized?.closed &&\n    finite(finalized?.position?.remaining_quantity) > 0\n  ) {\n    const enteredAt = new Date().toISOString();\n    const priorMetadata = finalized.position?.metadata || position.metadata || {};\n    const recoveryMetadata = {\n      ...priorMetadata,\n      recovery_exit: {\n        ...(priorMetadata.recovery_exit || {}),\n        enabled: true,\n        revision: VERSION,\n        entered_at: enteredAt,\n        trigger_reason: "HALF_HOLD_STOP_LOSS_4",\n        first_exit_price: finite(result?.fill?.averagePrice, price),\n        first_exit_quantity: finite(result?.fill?.executedVolume),\n        realized_pnl_quote_after_first_exit: finite(finalized.position?.realized_pnl_quote),\n        exit_rule: "TOTAL_NET_PNL_GT_0",\n        percentage_residual_thresholds_disabled: true,\n      },\n    };\n    const recoveryPosition = (await patch("trading_positions", `id=eq.${position.id}`, {\n      metadata: recoveryMetadata,\n    }))[0] || { ...finalized.position, metadata: recoveryMetadata };\n    await event(\n      "RECOVERY_MODE_ENTERED",\n      `${position.exchange}:${position.market} first -4% tranche filled; residual waits for positive total net`,\n      {\n        first_exit_price: recoveryMetadata.recovery_exit.first_exit_price,\n        first_exit_quantity: recoveryMetadata.recovery_exit.first_exit_quantity,\n        realized_pnl_quote_after_first_exit:\n          recoveryMetadata.recovery_exit.realized_pnl_quote_after_first_exit,\n        exit_rule: recoveryMetadata.recovery_exit.exit_rule,\n      },\n      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "INFO" },\n    );\n    finalized = { ...finalized, position: recoveryPosition };\n    position = { ...position, ...recoveryPosition };\n  }\n  if (\n    (targetAction || positiveNetGuardedExit) && finalized?.closed &&'''
if "RECOVERY_MODE_ENTERED" not in text:
    text = replace_once(text, finalize_anchor, finalize_replacement, "recovery mode persistence")
else:
    text = text.replace(
        "    (targetAction || positiveNetAfter180) && finalized?.closed &&",
        "    (targetAction || positiveNetGuardedExit) && finalized?.closed &&",
        1,
    )

old_breach = '''    const breachReason = positiveNetAfter180\n      ? "POSITIVE_NET_AFTER_180S_GUARD_BREACH"\n      : "TARGET_NET_GUARD_BREACH";'''
new_breach = '''    const breachReason = recoveryNetPositive\n      ? "RECOVERY_NET_POSITIVE_GUARD_BREACH"\n      : positiveNetAfter180\n      ? "POSITIVE_NET_AFTER_180S_GUARD_BREACH"\n      : "TARGET_NET_GUARD_BREACH";'''
if "RECOVERY_NET_POSITIVE_GUARD_BREACH" not in text:
    text = replace_once(text, old_breach, new_breach, "recovery accounting guard")

old_close_reason = '''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||\n      decisionReason === "HARD_STOP_MINUS_2_AFTER_180S") &&\n    !(decisionReason === "POSITIVE_NET_AFTER_180S" &&\n      finite(finalized?.position?.realized_pnl_quote) <= 0)'''
new_close_reason = '''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||\n      decisionReason === "RECOVERY_NET_POSITIVE_EXIT" ||\n      decisionReason === "HARD_STOP_MINUS_2_AFTER_180S") &&\n    !(positiveNetGuardedExit && finite(finalized?.position?.realized_pnl_quote) <= 0)'''
if 'decisionReason === "RECOVERY_NET_POSITIVE_EXIT" ||\n      decisionReason === "HARD_STOP_MINUS_2_AFTER_180S"' not in text:
    text = replace_once(text, old_close_reason, new_close_reason, "terminal recovery reason")

old_policy_block = '''      // HALF-HOLD-RESIDUAL-TP10-SL4-V3: the first 50% exits at +5% or -4%.\n      // Once that tranche is gone, the remaining inventory exits in full when its\n      // executable return reaches +10% or -4%. Time and signal exits remain disabled.\n      if (lobMode && !settings.emergency_liquidation) {\n        const BURST_POLICY_VERSION = "HALF-HOLD-RESIDUAL-TP10-SL4-V3";'''
new_policy_block = '''      // HALF-HOLD-RECOVERY-NET-POSITIVE-V4: the first 50% exits at +5% or -4%.\n      // A +5% first exit keeps the normal +10%/-4% residual thresholds. A -4% first\n      // exit enters recovery mode and the residual exits at the first strictly positive\n      // executable TOTAL position net PnL after fees and slippage safety.\n      if (lobMode && !settings.emergency_liquidation) {\n        const BURST_POLICY_VERSION = "HALF-HOLD-RECOVERY-NET-POSITIVE-V4";'''
if "HALF-HOLD-RECOVERY-NET-POSITIVE-V4" not in text:
    text = replace_once(text, old_policy_block, new_policy_block, "policy revision")

old_decision_chain = '''        if (!hasTradableHalf) {\n          if (residualNetReturnPct >= 10) {\n            decision = {\n              action: "STOP",\n              fraction: 1,\n              reason: "RESIDUAL_TAKE_PROFIT_10",\n            } as any;\n          } else if (residualNetReturnPct <= -4) {\n            decision = {\n              action: "STOP",\n              fraction: 1,\n              reason: "RESIDUAL_STOP_LOSS_4",\n            } as any;\n          } else {\n            decision = {\n              action: "NONE",\n              fraction: 0,\n              reason: "RESIDUAL_AWAITING_TP10_OR_SL4",\n            } as any;\n          }\n        } else if (grossReturnPct >= 5) {\n          decision = {\n            action: "STOP",\n            fraction: 0.5,\n            reason: "HALF_HOLD_TAKE_PROFIT_5",\n          } as any;\n        } else if (grossReturnPct <= -4) {\n          decision = {\n            action: "STOP",\n            fraction: 0.5,\n            reason: "HALF_HOLD_STOP_LOSS_4",\n          } as any;\n        } else {\n          decision = {\n            action: "NONE",\n            fraction: 0,\n            reason: safetyRequested\n              ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"\n              : "HALF_HOLD_AWAITING_TP5_OR_SL4",\n          } as any;\n        }'''
new_decision_chain = '''        const recoveryMode = position.metadata?.recovery_exit?.enabled === true;\n        decision = halfHoldRecoveryExitDecision({\n          residualStage: !hasTradableHalf,\n          recoveryMode,\n          grossReturnPct,\n          residualNetReturnPct,\n          executableNetAllowed: executableQuote.allowed,\n          expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),\n          safetyRequested,\n        }) as any;'''
if "decision = halfHoldRecoveryExitDecision({" not in text:
    text = replace_once(text, old_decision_chain, new_decision_chain, "canonical recovery decision")

old_quote_fields = '''              approved_reason: approvedReason,\n              requested_action: requestedAction,\n              requested_reason: requestedReason,\n              hard_stop_net_return_pct: guardedNetReturnPct,'''
new_quote_fields = '''              approved_reason: approvedReason,\n              requested_action: requestedAction,\n              requested_reason: requestedReason,\n              recovery_mode: recoveryMode,\n              executable_net_allowed: executableQuote.allowed,\n              expected_net_profit_quote: Number.isFinite(executableQuote.expectedNetProfitQuote)\n                ? executableQuote.expectedNetProfitQuote\n                : null,\n              hard_stop_net_return_pct: guardedNetReturnPct,'''
if "recovery_mode: recoveryMode" not in text:
    text = replace_once(text, old_quote_fields, new_quote_fields, "recovery decision audit")

old_confirmed = '''          decision.reason === "RESIDUAL_TAKE_PROFIT_10" ||\n          decision.reason === "RESIDUAL_STOP_LOSS_4" ||\n          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||'''
new_confirmed = '''          decision.reason === "RESIDUAL_TAKE_PROFIT_10" ||\n          decision.reason === "RESIDUAL_STOP_LOSS_4" ||\n          decision.reason === "RECOVERY_NET_POSITIVE_EXIT" ||\n          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||'''
if 'decision.reason === "RECOVERY_NET_POSITIVE_EXIT"' not in text:
    text = replace_once(text, old_confirmed, new_confirmed, "resting order recovery confirmation")

text = text.replace(
    "// to liquidate the formerly protected half.\n",
    "// to liquidate the formerly protected half; recovery mode is the other authorized route.\n",
    1,
)

INDEX.write_text(text)

migration = r'''begin;

-- v7.5.3 keeps the user-selected percentage thresholds unchanged for normal trades:
--   first 50% at +5% or -4%; a +5% winner keeps residual +10% / -4%.
-- When the first tranche is instead stopped at -4%, that position enters recovery mode.
-- Its residual is authorized only when selling the whole remainder produces strictly
-- positive TOTAL position net PnL after all already-paid fees plus the new sell fee.

create or replace function public.enforce_residual_exit_position_policy_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_entry numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
begin
  if new.state not in ('OPEN','EXITING') then
    return new;
  end if;

  v_entry := coalesce(nullif(new.average_entry_price, 0), nullif(new.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(new.initial_quantity, 0) <= 0 then
    return new;
  end if;

  v_step := greatest(0, coalesce(new.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, new.initial_quantity * 0.00000001);
  v_residual_stage := coalesce(new.remaining_quantity, new.initial_quantity) <=
    new.initial_quantity * 0.5 + v_tolerance;

  new.stop_price := v_entry * 0.96;
  new.target_1 := v_entry * 1.05;
  new.target_2 := v_entry * 1.10;
  new.t1_allocation_pct := 50;
  new.t1_completed := v_residual_stage;
  new.exit_policy := 'SCALE_OUT';
  new.trailing_stop := null;
  new.trailing_distance_pct := null;
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'exit_policy_revision', '7.5.3-RECOVERY-NET-POSITIVE',
    'half_hold_policy', jsonb_build_object(
      'enabled', true,
      'first_tranche_ratio', 0.5,
      'residual_ratio', 0.5,
      'first_take_profit_pct', 5,
      'first_stop_loss_pct', -4,
      'residual_take_profit_pct', 10,
      'residual_stop_loss_pct', -4,
      'winner_residual_mode', 'TP10_OR_SL4',
      'loss_residual_mode', 'TOTAL_NET_POSITIVE',
      'recovery_trigger_reason', 'HALF_HOLD_STOP_LOSS_4',
      'recovery_exit_reason', 'RECOVERY_NET_POSITIVE_EXIT',
      'recovery_percentage_thresholds_enabled', false,
      'residual_exit_enabled', true,
      'protected_stop_loss_enabled', true,
      'non_threshold_exit_enabled', false,
      'return_basis', 'EXECUTABLE_TOTAL_NET_PNL_AFTER_FEES_AND_SLIPPAGE_SAFETY',
      'stage', case when v_residual_stage then 'RESIDUAL' else 'FIRST_TRANCHE' end,
      'enforced_at', now()
    )
  );
  return new;
end;
$function$;

create or replace function public.guard_residual_sell_order_v751()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_entry numeric;
  v_price numeric;
  v_quote_at timestamptz;
  v_gross_return_pct numeric;
  v_net_return_pct numeric;
  v_fee_rate numeric;
  v_protected_qty numeric;
  v_sellable_qty numeric;
  v_requested_qty numeric;
  v_step numeric;
  v_tolerance numeric;
  v_residual_stage boolean;
  v_recovery_mode boolean;
  v_approved_reason text;
  v_projected_net_pnl_quote numeric;
  v_min_exit_notional numeric;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p
  from public.trading_positions
  where id = new.position_id
  for update;

  if not found then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_POSITION_NOT_FOUND';
  end if;
  if p.state not in ('OPEN','EXITING') then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_POSITION_NOT_SELLABLE state=%s market=%s', p.state, p.market
    );
  end if;

  v_entry := coalesce(nullif(p.average_entry_price, 0), nullif(p.planned_entry_price, 0));
  if coalesce(v_entry, 0) <= 0 or coalesce(p.initial_quantity, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_INVALID_POSITION_BASIS';
  end if;

  v_price := coalesce(
    nullif(new.requested_price, 0),
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );

  if coalesce(v_price, 0) <= 0 then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_MISSING_EXECUTABLE_PRICE';
  end if;
  if new.requested_price is null and (v_quote_at is null or now() - v_quote_at > interval '30 seconds') then
    raise exception using errcode='23514', message='RESIDUAL_POLICY_STALE_EXECUTABLE_PRICE';
  end if;

  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_gross_return_pct := (v_price / v_entry - 1) * 100;
  v_net_return_pct := (v_price * (1 - v_fee_rate) / v_entry - 1) * 100;
  v_step := greatest(0, coalesce(p.quantity_step, 0));
  v_tolerance := greatest(v_step * 1.001, p.initial_quantity * 0.00000001);
  v_protected_qty := greatest(0, p.initial_quantity * 0.5);
  v_residual_stage := p.remaining_quantity <= v_protected_qty + v_tolerance;
  v_recovery_mode := lower(coalesce(p.metadata#>>'{recovery_exit,enabled}', 'false')) = 'true';
  v_approved_reason := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,approved_reason}', ''),
    nullif(p.metadata->>'pending_exit_reason', ''),
    ''
  );
  v_requested_qty := greatest(0, coalesce(new.requested_volume, 0));

  if v_residual_stage then
    if v_recovery_mode then
      if v_approved_reason <> 'RECOVERY_NET_POSITIVE_EXIT' then
        raise exception using errcode='23514', message=format(
          'RECOVERY_EXIT_REASON_REQUIRED market=%s approved_reason=%s',
          p.market, v_approved_reason
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    else
      if v_net_return_pct < 9.999 and v_net_return_pct > -3.999 then
        raise exception using errcode='23514', message=format(
          'RESIDUAL_THRESHOLD_NOT_REACHED market=%s net_return_pct=%s',
          p.market, round(v_net_return_pct, 6)
        );
      end if;
      v_sellable_qty := greatest(0, p.remaining_quantity);
    end if;
  else
    if v_gross_return_pct < 4.999 and v_gross_return_pct > -3.999 then
      raise exception using errcode='23514', message=format(
        'FIRST_TRANCHE_THRESHOLD_NOT_REACHED market=%s gross_return_pct=%s',
        p.market, round(v_gross_return_pct, 6)
      );
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity - v_protected_qty);
  end if;

  if v_step > 0 then
    v_sellable_qty := floor((v_sellable_qty + v_step * 0.000000001) / v_step) * v_step;
  end if;
  new.requested_volume := least(v_requested_qty, v_sellable_qty);

  if coalesce(new.requested_volume, 0) <= 0 then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_NO_AUTHORIZED_QUANTITY market=%s residual_stage=%s remaining_qty=%s',
      p.market, v_residual_stage, p.remaining_quantity
    );
  end if;

  if v_residual_stage and v_recovery_mode then
    v_projected_net_pnl_quote :=
      coalesce(p.realized_proceeds_quote, 0)
      + new.requested_volume * v_price * (1 - v_fee_rate)
      - coalesce(p.realized_cost_quote, 0)
      - coalesce(p.paid_fees_quote, 0);
    if v_projected_net_pnl_quote <= 0 then
      raise exception using errcode='23514', message=format(
        'RECOVERY_TOTAL_NET_NOT_POSITIVE market=%s projected_net_pnl_quote=%s',
        p.market, round(v_projected_net_pnl_quote, 8)
      );
    end if;
  end if;

  v_min_exit_notional := case when lower(p.exchange) = 'upbit' then 5000 else 5 end;
  if new.requested_volume * v_price < v_min_exit_notional then
    raise exception using errcode='23514', message=format(
      'RESIDUAL_POLICY_EXIT_BELOW_EXCHANGE_MINIMUM market=%s notional=%s minimum=%s',
      p.market, round(new.requested_volume * v_price, 8), v_min_exit_notional
    );
  end if;

  new.requested_notional_quote := new.requested_volume * v_price;
  return new;
end;
$function$;

comment on function public.enforce_residual_exit_position_policy_v751() is
  'v7.5.3: first 50% TP5/SL4; +5 winner residual TP10/SL4; -4 loser residual exits at strictly positive total net PnL';
comment on function public.guard_residual_sell_order_v751() is
  'v7.5.3 guard: recovery residual requires RECOVERY_NET_POSITIVE_EXIT and projected total net PnL > 0';

update public.trading_positions
set updated_at = now()
where state in ('OPEN','EXITING')
  and coalesce(initial_quantity, 0) > 0;

do $verify$
declare
  v_guard text := pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure);
  v_policy text := pg_get_functiondef('public.enforce_residual_exit_position_policy_v751()'::regprocedure);
begin
  if position('RECOVERY_EXIT_REASON_REQUIRED' in v_guard) = 0 then
    raise exception 'RECOVERY_EXIT_REASON_GUARD_MISSING';
  end if;
  if position('RECOVERY_TOTAL_NET_NOT_POSITIVE' in v_guard) = 0 then
    raise exception 'RECOVERY_TOTAL_NET_GUARD_MISSING';
  end if;
  if position('v_projected_net_pnl_quote <= 0' in v_guard) = 0 then
    raise exception 'RECOVERY_PROJECTED_NET_CHECK_MISSING';
  end if;
  if position('loss_residual_mode' in v_policy) = 0 or
     position('TOTAL_NET_POSITIVE' in v_policy) = 0 then
    raise exception 'RECOVERY_POSITION_POLICY_METADATA_MISSING';
  end if;
end;
$verify$;

commit;
'''

if MIGRATION.exists():
    if MIGRATION.read_text() != migration:
        raise SystemExit(f"{MIGRATION}: existing migration differs from canonical v7.5.3 text")
else:
    MIGRATION.write_text(migration)

print("Applied v7.5.3 recovery-net-positive engine patch and canonical migration")
