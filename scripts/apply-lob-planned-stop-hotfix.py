from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")

replacements = [
    (
        '// Trading-booooo v7.2.3-EXECUTABLE-NET-INTEGRITY — autonomous spot orchestrator.',
        '// Trading-booooo v7.2.4-LOB-PLANNED-STOP — autonomous spot orchestrator.',
    ),
    (
        'const VERSION = "7.2.3-EXECUTABLE-NET-INTEGRITY";',
        'const VERSION = "7.2.4-LOB-PLANNED-STOP";',
    ),
    (
        '    const stopPct = 0.03;\n'
        '    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, "down");',
        '    const stopPct = clamp(finite(decision.stopBps, 0) / 10_000, 0.0006, 0.02);\n'
        '    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, "down");',
    ),
    (
        '        const targetRequested = requestedAction === "TARGET_1" || requestedAction === "TARGET_2";\n'
        '        const reversalRequested = requestedAction === "STOP" &&\n'
        '          (requestedReason === "lob:SIGNAL_REVERSAL" ||\n'
        '            requestedReason === "lob:LOB_INVALIDATION");',
        '        const targetRequested = requestedAction === "TARGET_1" || requestedAction === "TARGET_2";\n'
        '        const plannedStopRequested = requestedAction === "STOP" &&\n'
        '          requestedReason === "lob:STOP_HIT" &&\n'
        '          current <= finite(position.stop_price);\n'
        '        const reversalRequested = requestedAction === "STOP" &&\n'
        '          (requestedReason === "lob:SIGNAL_REVERSAL" ||\n'
        '            requestedReason === "lob:LOB_INVALIDATION");',
    ),
    (
        '        if (heldSeconds < 180) {\n'
        '          if (targetRequested) {',
        '        if (heldSeconds < 180) {\n'
        '          if (plannedStopRequested) {\n'
        '            decision = {\n'
        '              action: "STOP",\n'
        '              fraction: 1,\n'
        '              reason: "lob:STOP_HIT",\n'
        '            };\n'
        '          } else if (targetRequested) {',
    ),
    (
        '        const approvedPre180Reversal = decision.action === "STOP" &&\n'
        '          ((decision as any).reason === "lob:SIGNAL_REVERSAL" ||\n'
        '            (decision as any).reason === "lob:LOB_INVALIDATION") &&\n'
        '          Boolean(position.metadata?.lob_soft_exit_qualified);\n'
        '        if (!approvedPre180Target && !approvedPre180Reversal) {',
        '        const approvedPre180Reversal = decision.action === "STOP" &&\n'
        '          ((decision as any).reason === "lob:SIGNAL_REVERSAL" ||\n'
        '            (decision as any).reason === "lob:LOB_INVALIDATION") &&\n'
        '          Boolean(position.metadata?.lob_soft_exit_qualified);\n'
        '        const approvedPre180PlannedStop = decision.action === "STOP" &&\n'
        '          (decision as any).reason === "lob:STOP_HIT" &&\n'
        '          current <= finite(position.stop_price);\n'
        '        if (\n'
        '          !approvedPre180Target && !approvedPre180Reversal &&\n'
        '          !approvedPre180PlannedStop\n'
        '        ) {',
    ),
    (
        '`${exchange}:${position.market} exit was not an approved target or qualified reversal`,',
        '`${exchange}:${position.market} exit was not an approved target, planned stop, or qualified reversal`,',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print(f"patched {PATH}")
