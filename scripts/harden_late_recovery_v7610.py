from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
POLICY = Path("supabase/functions/market-autotrader/late-recovery-policy.ts")
TEST = Path("supabase/functions/market-autotrader/late-recovery-policy.test.ts")
MIGRATION = Path("supabase/migrations/20260818120000_late_recovery_v7610_guard.sql")

source = INDEX.read_text()
policy = POLICY.read_text()
test = TEST.read_text()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source match, found {count}")
    return text.replace(old, new, 1)


# The first rollout draft incorrectly moved the Futures 600-second timeout into the
# generic LOB owner. Restore the canonical invariant exactly: Futures termination remains
# exclusively owned by its dedicated state machine.
source = replace_once(
    source,
    '''        if ((lobMode || futuresLane) && heldSeconds >= absoluteMaxHoldingSeconds) {
          const absoluteTimeoutReason = futuresLane
            ? "POST180_MAX_HOLD_TIMEOUT"
            : "HALF_HOLD_ABSOLUTE_TIMEOUT";
          decision = {
            action: "STOP",
            fraction: 1,
            reason: absoluteTimeoutReason,
            signalValid: false,
          } as any;
          console.error(
            `[HARD_EXIT_INVARIANT] ${exchange}:${position.market} held=${heldSeconds}s ` +
              `limit=${absoluteMaxHoldingSeconds}s reason=${absoluteTimeoutReason} -> full exit`,
          );
        }
''',
    '''        if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "HALF_HOLD_ABSOLUTE_TIMEOUT",
            signalValid: false,
          } as any;
          console.error(
            `[HARD_EXIT_INVARIANT] ${exchange}:${position.market} held=${heldSeconds}s ` +
              `limit=${absoluteMaxHoldingSeconds}s -> full exit`,
          );
        }
''',
    "restore futures timeout ownership",
)

# Exact breakeven (0 after fees/slippage) is a valid Late Recovery decision. The generic
# executable-net helper intentionally requires strictly-positive net for other policies,
# so Late Recovery uses its own order-time FOK recheck below instead of weakening that
# shared invariant.
policy = replace_once(
    policy,
    '''  if (input.executableNetAllowed && expectedNetProfitQuote >= 0) {
''',
    '''  if (input.executableDepthSufficient && expectedNetProfitQuote >= 0) {
''',
    "allow exact late-recovery breakeven without weakening shared positive-net guard",
)
test = replace_once(
    test,
    '''    executableNetAllowed: true,
    expectedNetProfitQuote: 0,
''',
    '''    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
''',
    "prove exact breakeven is late-recovery eligible",
)

# Late Recovery has a dedicated protected FOK preflight. Do not route it through the
# shared strictly-positive policy (which has different economics and telemetry).
source = replace_once(
    source,
    '''  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||
    lateRecoveryNetPositive || staleRecoveryNetPositive;
''',
    '''  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||
    staleRecoveryNetPositive;
''',
    "separate late-recovery FOK owner",
)

late_helper = r'''
async function prepareLateRecoveryProtectedExit(
  position: Position,
  requestedQuantity: number,
  settings: TradingSettings & JsonRecord,
  cycleId: string,
  decisionReason: "LATE_RECOVERY_NET_POSITIVE_EXIT" | "LATE_RECOVERY_DRAWDOWN_33_EXIT",
): Promise<ProtectedPositiveNetQuote | null> {
  // Re-read the position before the order-time quote. This picks up the trough persisted
  // by the current monitor decision and prevents a stale in-memory object from authorizing
  // a loss exit.
  const rows = await db(
    `trading_positions?id=eq.${position.id}&state=eq.OPEN&select=*&limit=1`,
  ) as Position[];
  const freshPosition = rows[0];
  const block = async (reason: string, audit: JsonRecord = {}) => {
    await event(
      "LATE_RECOVERY_ORDER_TIME_BLOCKED",
      `${position.exchange}:${position.market} ${reason}`,
      { decision_reason: decisionReason, ...audit },
      { cycleId, positionId: position.id, level: "INFO" },
    );
    return null;
  };
  if (!freshPosition) return await block("position is no longer OPEN");

  const openedAt = Date.parse(String(freshPosition.opened_at || freshPosition.created_at || ""));
  const heldSeconds = Number.isFinite(openedAt) ? Math.max(0, (Date.now() - openedAt) / 1000) : 0;
  const absoluteMaxHoldingSeconds = Math.max(
    1,
    finite(
      freshPosition.metadata?.absolute_max_holding_seconds,
      finite((settings as any).lob_absolute_max_holding_seconds, 600),
    ),
  );
  if (
    heldSeconds < LATE_RECOVERY_THRESHOLDS.startSeconds ||
    heldSeconds >= absoluteMaxHoldingSeconds
  ) {
    return await block("outside 460s-to-absolute-max ownership window", {
      held_seconds: heldSeconds,
      absolute_max_holding_seconds: absoluteMaxHoldingSeconds,
    });
  }

  const step = Math.max(0, finite(freshPosition.quantity_step, 0.00000001));
  const tolerance = Math.max(step * 1.001, finite(freshPosition.initial_quantity) * 1e-8, 1e-12);
  const residualStage = freshPosition.exchange === "binance_futures"
    ? freshPosition.t1_completed === true
    : finite(freshPosition.remaining_quantity) <=
      finite(freshPosition.initial_quantity) * 0.5 + tolerance;
  if (residualStage) {
    return await block("earned residual winner remains owned by residual policy");
  }

  const priorLateRecovery = freshPosition.metadata?.late_recovery || {};
  const entryPrice = Math.max(
    0,
    finite(freshPosition.average_entry_price, freshPosition.planned_entry_price),
  );
  const runningTroughPrice = Math.max(
    0,
    finite(priorLateRecovery.post180_running_trough_price),
  );
  if (!(entryPrice > 0 && runningTroughPrice > 0)) {
    return await block("persistent post-180 trough is unavailable", {
      entry_price: entryPrice,
      running_trough_price: runningTroughPrice,
    });
  }

  const [portfolio, market, buyFeeQuote] = await Promise.all([
    gateway(freshPosition.exchange, { action: "portfolio" }),
    marketQuote(freshPosition.exchange, freshPosition.market),
    paidBuyFeeQuote(freshPosition),
  ]);
  const availableQuantity = accountQuantity(portfolio, freshPosition.base_asset, true);
  const quote = quoteExecutableNetExit({
    bids: (market?.bids || []).map((row: any) => ({
      price: finite(row?.price ?? row?.[0]),
      size: finite(row?.size ?? row?.[1]),
    })),
    requestedQuantity,
    availableQuantity,
    quantityStep: finite(freshPosition.quantity_step, 0.00000001),
    buyPrincipalQuote: positionEntryCostBasis(freshPosition),
    alreadyPaidFeesQuote: finite(freshPosition.paid_fees_quote),
    priorSellProceedsQuote: finite(freshPosition.realized_proceeds_quote),
    sellFeeRate: clamp(FEE_PCT[freshPosition.exchange] / 100, 0, 0.01),
    slippageSafetyRate: post180SlippageSafetyRate(settings),
  });
  const measuredAt = new Date().toISOString();
  const expectedQuantity = floorToStep(
    Math.min(finite(freshPosition.remaining_quantity), requestedQuantity),
    Math.max(1e-12, step),
  );
  const fullDepth = quote.sellQuantity > 0 && quote.limitPrice > 0 &&
    Math.abs(quote.sellQuantity - expectedQuantity) <= tolerance &&
    quote.visibleExecutableQuantity + tolerance >= quote.sellQuantity;
  if (!fullDepth) {
    return await block("full executable depth is unavailable", {
      requested_quantity: requestedQuantity,
      expected_quantity: expectedQuantity,
      sell_quantity: quote.sellQuantity,
      visible_executable_quantity: quote.visibleExecutableQuantity,
    });
  }

  // Use the protected FOK LIMIT floor, not the optimistic book VWAP, for the reclaim test.
  // If the price moves before submission, the order cannot fill below this floor.
  const drawdown = entryPrice - runningTroughPrice;
  const recoveryRatio = drawdown > 0
    ? (quote.limitPrice - runningTroughPrice) / drawdown
    : Number.NEGATIVE_INFINITY;
  const expectedNetProfitQuote = quote.expectedNetProfitQuote;
  const eligible = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT"
    ? Number.isFinite(expectedNetProfitQuote) && expectedNetProfitQuote >= 0
    : Number.isFinite(expectedNetProfitQuote) && expectedNetProfitQuote < 0 &&
      drawdown > 0 && recoveryRatio >= LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio;
  if (!eligible) {
    return await block("fresh FOK quote no longer satisfies late-recovery economics", {
      expected_net_profit_quote: Number.isFinite(expectedNetProfitQuote)
        ? expectedNetProfitQuote
        : null,
      entry_price: entryPrice,
      running_trough_price: runningTroughPrice,
      protected_limit_price: quote.limitPrice,
      recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
    });
  }

  const status = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT"
    ? "LATE_RECOVERY_NET_POSITIVE"
    : "LATE_RECOVERY_DRAWDOWN_33";
  const baseAudit = executableNetExitAudit(freshPosition, quote, buyFeeQuote, measuredAt);
  const audit: JsonRecord = {
    ...(freshPosition.metadata?.exit_policy_quote || {}),
    ...baseAudit,
    revision: "7.6.10-LATE-RECOVERY-460-R33",
    late_recovery_revision: "7.6.10-LATE-RECOVERY-460-R33",
    status,
    approval_scope: "SINGLE_FOK_ORDER",
    approved_reason: decisionReason,
    allowed: decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT",
    executable_net_allowed: decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT",
    full_depth: true,
    held_seconds: heldSeconds,
    absolute_max_holding_seconds: absoluteMaxHoldingSeconds,
    entry_price: entryPrice,
    running_trough_price: runningTroughPrice,
    recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
    recovery_ratio_threshold: LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
    sell_price: quote.limitPrice,
    limit_price: quote.limitPrice,
    sell_quantity: quote.sellQuantity,
    expected_net_profit_quote: expectedNetProfitQuote,
    measured_at: measuredAt,
  };
  await patch("trading_positions", `id=eq.${freshPosition.id}`, {
    metadata: {
      ...(freshPosition.metadata || {}),
      exit_policy_quote: audit,
      late_recovery: {
        ...(priorLateRecovery || {}),
        last_order_time_recheck_at: measuredAt,
        last_order_time_limit_price: quote.limitPrice,
        last_order_time_expected_net_profit_quote: expectedNetProfitQuote,
        last_order_time_recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
      },
    },
  });
  return {
    limitPrice: quote.limitPrice,
    expectedNetProfitQuote,
    availableQuantity: quote.visibleExecutableQuantity,
    measuredAt,
    sellQuantity: quote.sellQuantity,
    audit,
  };
}

'''
source = replace_once(
    source,
    '''async function prepareProtectedTarget(
''',
    late_helper + '''async function prepareProtectedTarget(
''',
    "insert dedicated late-recovery order-time FOK preflight",
)

source = replace_once(
    source,
    '''  if (protectedPositiveNet) quantity = protectedPositiveNet.sellQuantity;
  const protectedLimit = protectedTarget || protectedPositiveNet;
''',
    '''  if (protectedPositiveNet) quantity = protectedPositiveNet.sellQuantity;
  const protectedLateRecovery = !position.is_paper &&
      (lateRecoveryNetPositive || lateRecoveryDrawdown) && settings
    ? await prepareLateRecoveryProtectedExit(
      position,
      quantity,
      settings,
      cycleId,
      lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_EXIT"
        : "LATE_RECOVERY_DRAWDOWN_33_EXIT",
    )
    : null;
  if (
    !position.is_paper && (lateRecoveryNetPositive || lateRecoveryDrawdown) &&
    !protectedLateRecovery
  ) {
    return {
      action: "NONE",
      reason: "late-recovery order-time FOK recheck blocked; position retained",
    };
  }
  if (protectedLateRecovery) quantity = protectedLateRecovery.sellQuantity;
  const protectedLimit = protectedTarget || protectedPositiveNet || protectedLateRecovery;
  const protectedExitAudit = protectedLateRecovery?.audit || protectedPositiveNet?.audit || null;
''',
    "route both late-recovery exits through fresh LIMIT FOK preflight",
)
source = replace_once(
    source,
    '''          ...(protectedPositiveNet ? { exit_policy_quote: protectedPositiveNet.audit } : {}),
''',
    '''          ...(protectedExitAudit ? { exit_policy_quote: protectedExitAudit } : {}),
''',
    "persist dedicated late-recovery order authorization",
)
source = replace_once(
    source,
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
''',
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : lateRecoveryDrawdown
        ? "LATE_RECOVERY_DRAWDOWN_33_FOK_NOT_FILLED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
''',
    "late-recovery no-fill telemetry",
)
source = replace_once(
    source,
    '''    (targetAction || positiveNetGuardedExit) && finalized?.closed &&
''',
    '''    (targetAction || positiveNetGuardedExit || lateRecoveryNetPositive) && finalized?.closed &&
''',
    "late-recovery nonnegative realized-net breach audit",
)
source = replace_once(
    source,
    '''    const breachReason = staleRecoveryNetPositive
      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : lateRecoveryNetPositive
      ? "LATE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
''',
    '''    const breachReason = staleRecoveryNetPositive
      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : lateRecoveryNetPositive
      ? "LATE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
''',
    "retain late-recovery positive breach telemetry",
)
source = replace_once(
    source,
    '''    !(positiveNetGuardedExit && finite(finalized?.position?.realized_pnl_quote) <= 0)
''',
    '''    !(
      (positiveNetGuardedExit || lateRecoveryNetPositive) &&
      finite(finalized?.position?.realized_pnl_quote) <= 0
    )
''',
    "do not overwrite late-recovery positive guard breach close reason",
)

# DB authorization is fail-closed and source-drift guarded. The legacy burst guard merely
# delegates the two new reasons to the residual guard; the residual guard then independently
# rechecks timing, pre-T1 state, fresh LIMIT+FOK evidence, full depth, quantity/price binding,
# and the exact economic condition. Existing branches are left byte-for-byte intact.
MIGRATION.parent.mkdir(parents=True, exist_ok=True)
MIGRATION.write_text(r'''-- Trading-booooo v7.6.10 Late Recovery database order guard.
-- No table/schema changes. Existing residual/T1 protections remain authoritative.

DO $migration$
DECLARE
  v_def text;
  v_anchor text := $anchor$  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- LEGACY_BURST_GUARD_SCOPED_V761$anchor$;
  v_replacement text := $replacement$  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- Late Recovery is enforced by guard_residual_sell_order_v751 below. The legacy burst
  -- guard must not reinterpret these supplemental reasons as legacy burst exits.
  if v_approved_reason in ('LATE_RECOVERY_NET_POSITIVE_EXIT', 'LATE_RECOVERY_DRAWDOWN_33_EXIT') then
    return new;
  end if;

  -- LEGACY_BURST_GUARD_SCOPED_V761$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.guard_lob_sell_order_v714()'::regprocedure) INTO v_def;
  IF v_def IS NULL OR (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_RECOVERY_V7610_BURST_GUARD_SOURCE_DRIFT';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_replacement);
END
$migration$;

DO $migration$
DECLARE
  v_def text;
  v_anchor text := $anchor$  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'$anchor$;
  v_replacement text := $replacement$  if upper(coalesce(new.purpose, '')) = 'EMERGENCY' then
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif not v_residual_stage
        and upper(coalesce(new.purpose, '')) = 'STOP'
        and v_approved_reason in ('LATE_RECOVERY_NET_POSITIVE_EXIT', 'LATE_RECOVERY_DRAWDOWN_33_EXIT') then
    if v_held_seconds < 460
       or v_held_seconds >= greatest(
         1,
         coalesce(public.safe_numeric_v6112(p.metadata->>'absolute_max_holding_seconds'), 600)
       ) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_OUTSIDE_OWNER_WINDOW market=%s held_seconds=%s',
        p.market, round(v_held_seconds, 3)
      );
    end if;
    if upper(coalesce(new.order_type, '')) <> 'LIMIT'
       or upper(coalesce(new.time_in_force, '')) <> 'FOK' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_REQUIRES_LIMIT_FOK market=%s type=%s tif=%s',
        p.market, new.order_type, new.time_in_force
      );
    end if;
    if coalesce(p.metadata#>>'{exit_policy_quote,approval_scope}', '') <> 'SINGLE_FOK_ORDER'
       or coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '') <> v_approved_reason
       or coalesce(p.metadata#>>'{exit_policy_quote,late_recovery_revision}', '') <> '7.6.10-LATE-RECOVERY-460-R33'
       or lower(coalesce(p.metadata#>>'{exit_policy_quote,full_depth}', 'false')) <> 'true' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_MISSING_ORDER_AUTHORITY market=%s reason=%s', p.market, v_approved_reason
      );
    end if;
    if v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_STALE_EXECUTABLE_QUOTE market=%s reason=%s', p.market, v_approved_reason
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,sell_quantity}' is null
       or abs(
         coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_quantity}'), 0)
         - v_requested_qty
       ) > greatest(v_tolerance, v_requested_qty * 0.00000001) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_QUANTITY_MISMATCH market=%s requested=%s approved=%s',
        p.market, v_requested_qty,
        coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_quantity}'), 0)
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,sell_price}' is null
       or abs(
         coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_price}'), 0)
         - v_price
       ) > greatest(0.000000000001, abs(v_price) * 0.00000001) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_PRICE_MISMATCH market=%s requested=%s approved=%s',
        p.market, v_price,
        coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,sell_price}'), 0)
      );
    end if;
    if v_requested_qty + v_tolerance < greatest(0, p.remaining_quantity) then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_REQUIRES_FULL_POSITION market=%s requested=%s remaining=%s',
        p.market, v_requested_qty, p.remaining_quantity
      );
    end if;
    if p.metadata#>>'{exit_policy_quote,expected_net_profit_quote}' is null then
      raise exception using errcode='23514', message=format(
        'LATE_RECOVERY_NET_EVIDENCE_MISSING market=%s reason=%s', p.market, v_approved_reason
      );
    end if;

    if v_approved_reason = 'LATE_RECOVERY_NET_POSITIVE_EXIT' then
      if coalesce(p.metadata#>>'{exit_policy_quote,status}', '') <> 'LATE_RECOVERY_NET_POSITIVE'
         or v_expected_net_profit_quote < 0 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_NET_POSITIVE_NOT_PROVEN market=%s expected_net=%s',
          p.market, round(v_expected_net_profit_quote, 8)
        );
      end if;
    else
      if coalesce(p.metadata#>>'{exit_policy_quote,status}', '') <> 'LATE_RECOVERY_DRAWDOWN_33'
         or v_expected_net_profit_quote >= 0 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_NEGATIVE_NET_REQUIRED market=%s expected_net=%s',
          p.market, round(v_expected_net_profit_quote, 8)
        );
      end if;
      if coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0) <= 0
         or coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0) >= v_entry then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_TROUGH_INVALID market=%s entry=%s trough=%s',
          p.market, v_entry,
          coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0)
        );
      end if;
      if (
        (v_price - coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0))
        / nullif(
          v_entry - coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0),
          0
        )
      ) + 0.000000001 < 0.33 then
        raise exception using errcode='23514', message=format(
          'LATE_RECOVERY_DRAWDOWN_33_NOT_REACHED market=%s entry=%s trough=%s limit=%s',
          p.market, v_entry,
          coalesce(public.safe_numeric_v6112(p.metadata#>>'{exit_policy_quote,running_trough_price}'), 0),
          v_price
        );
      end if;
    end if;
    v_sellable_qty := greatest(0, p.remaining_quantity);
  elsif upper(coalesce(new.purpose, '')) = 'STOP'$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.guard_residual_sell_order_v751()'::regprocedure) INTO v_def;
  IF v_def IS NULL OR (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_RECOVERY_V7610_RESIDUAL_GUARD_SOURCE_DRIFT';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_replacement);
END
$migration$;

COMMENT ON FUNCTION public.guard_residual_sell_order_v751() IS
  'Split/residual exit authority plus fail-closed Late Recovery 460s/FOK guard (v7.6.10).';
''')

# Integration assertions: if any source shape drifts, stop before tests, migration, or deploy.
assert 'if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds)' in source
assert 'if ((lobMode || futuresLane) && heldSeconds >= absoluteMaxHoldingSeconds)' not in source
assert 'async function prepareLateRecoveryProtectedExit(' in source
assert 'heldSeconds >= absoluteMaxHoldingSeconds' in source
assert 'freshPosition.t1_completed === true' in source
assert 'quote.visibleExecutableQuantity + tolerance >= quote.sellQuantity' in source
assert 'recoveryRatio >= LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio' in source
assert 'const protectedLimit = protectedTarget || protectedPositiveNet || protectedLateRecovery;' in source
assert 'protectedExitAudit ? { exit_policy_quote: protectedExitAudit }' in source
assert 'LATE_RECOVERY_DRAWDOWN_33_FOK_NOT_FILLED' in source
assert 'input.executableDepthSufficient && expectedNetProfitQuote >= 0' in policy
assert 'executableNetAllowed: false' in test
assert 'const VERSION = "7.6.0-BINANCE-FUTURES";' in source

INDEX.write_text(source)
POLICY.write_text(policy)
TEST.write_text(test)
print("late recovery rollout hardened: futures owner preserved; both exits require fresh LIMIT FOK; DB guard migration emitted")
