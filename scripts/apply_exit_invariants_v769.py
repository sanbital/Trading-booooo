from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
source = INDEX.read_text()

old = '''        const requestedAction = decision.action;
        const requestedReason = String((decision as any).reason || "");
        const safetyRequested = requestedAction === "STOP" &&
          (requestedReason.includes("RISK_EMERGENCY") ||
            requestedReason.includes("RECONCILIATION_FAILURE"));
'''
new = '''        // v7.6.9 exit hotfix: LOB safety exits are hard invariants. The split TP/SL
        // policy is a profit-management layer and must never override a planned STOP_HIT,
        // risk stop, reconciliation stop, or the configured absolute holding ceiling.
        const configuredAbsoluteMaxHoldingSeconds = finite(
          (settings as any).lob_absolute_max_holding_seconds,
          600,
        );
        const absoluteMaxHoldingSeconds = Math.max(1, configuredAbsoluteMaxHoldingSeconds);
        if (lobMode && heldSeconds >= absoluteMaxHoldingSeconds) {
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
        const requestedAction = decision.action;
        const requestedReason = String((decision as any).reason || "");
        const safetyRequested = requestedAction === "STOP";
'''

if old not in source:
    if "[HARD_EXIT_INVARIANT]" not in source:
        raise SystemExit("expected split-policy safety block not found")
else:
    source = source.replace(old, new, 1)

start = source.index("        const activeSplitPolicyVersion")
end = source.index("        const watchIso", start)
segment = source[start:end]
needle = "        if (futuresLane) {"
replacement = '''        if (requestedAction === "STOP") {
          // Preserve the upstream safety decision exactly. In particular, STOP_HIT and
          // HALF_HOLD_ABSOLUTE_TIMEOUT must reach the executable-exit layer unchanged.
          console.warn(
            `[HARD_EXIT_INVARIANT] preserving ${requestedReason || "STOP"} for ` +
              `${exchange}:${position.market}`,
          );
        } else if (futuresLane) {'''
if needle not in segment:
    if "preserving ${requestedReason" not in segment:
        raise SystemExit("expected futures split branch not found")
else:
    segment = segment.replace(needle, replacement, 1)
    source = source[:start] + segment + source[end:]

# Static regression assertions: fail before deployment if source layout drifts.
assert 'reason: "HALF_HOLD_ABSOLUTE_TIMEOUT"' in source
assert 'const safetyRequested = requestedAction === "STOP";' in source
assert 'if (requestedAction === "STOP") {' in source
assert '[HARD_EXIT_INVARIANT]' in source
assert 'const VERSION = "7.6.0-BINANCE-FUTURES";' in source

INDEX.write_text(source)
print("exit invariants applied with shared engine version preserved")
