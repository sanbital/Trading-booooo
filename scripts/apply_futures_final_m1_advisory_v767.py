from pathlib import Path


def replace_once_or_already(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text and old not in text:
        print(f"already patched: {path}")
        return
    if text.count(old) != 1:
        raise SystemExit(
            f"expected unique source fragment missing or duplicated: {path}: count={text.count(old)}"
        )
    p.write_text(text.replace(old, new, 1))


index = "supabase/functions/market-autotrader/index.ts"

replace_once_or_already(
    index,
    'import { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";\n',
    'import { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";\n'
    'import { resolveFinalLobAdmission } from "./final-entry-gate.ts";\n',
)

replace_once_or_already(
    index,
    '''    const finalReasons = [
      ...new Set([
        ...secondLobPreOrderRecheck.reasons,
        ...finalMinuteEntryGate.reasons,
      ]),
    ];
    const finalPassed = secondLobPreOrderRecheck.passed && finalMinuteEntryGate.passed;
    const finalAudit = {''',
    '''    // Live futures data showed the second M1 snapshot was re-vetoing opportunities that
    // had already passed the setup gate, while the current executable LOB remained safe.
    // Keep the fresh futures M1 read for audit only; current executable LOB safety owns the
    // final futures veto. Spot/Upbit retain their existing hard final M1 behavior.
    const finalAdmission = resolveFinalLobAdmission(
      exchange,
      secondLobPreOrderRecheck.passed,
      secondLobPreOrderRecheck.reasons,
      finalMinuteEntryGate.passed,
      finalMinuteEntryGate.reasons,
    );
    const finalReasons = finalAdmission.blockingReasons;
    const finalPassed = finalAdmission.passed;
    const finalAudit = {''',
)

replace_once_or_already(
    index,
    '''      reasons: finalReasons,
      minute_entry_gate: finalMinuteEntryGate,
      best_bid: secondLobPreOrderRecheck.bestBid,''',
    '''      reasons: finalReasons,
      minute_entry_gate: finalMinuteEntryGate,
      minute_entry_gate_advisory: {
        enabled: finalAdmission.minuteGateAdvisory,
        passed: finalMinuteEntryGate.passed,
        reasons: finalAdmission.minuteGateAdvisoryReasons,
        rationale: finalAdmission.minuteGateAdvisory
          ? "FUTURES_SETUP_M1_ALREADY_CONFIRMED_FINAL_EXECUTABLE_LOB_AUTHORITATIVE"
          : null,
      },
      best_bid: secondLobPreOrderRecheck.bestBid,''',
)

print("futures final M1 advisory patch applied")
