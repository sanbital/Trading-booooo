from pathlib import Path

path = Path("supabase/functions/market-autotrader/index.ts")
source = path.read_text(encoding="utf-8")

old_1 = '''        // The one price-based floor spans both regimes. The scanner's planned stop used to
        // terminate positions on touch at any age — a 29s exit at -38bp — which is neither
        // regime's rule. It is gone; -2% of executable net is the only price that forces a
        // sell, and it is measured the same way in both.
        if (guardedNetReturnPct <= -2) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "HARD_STOP_MINUS_2",
          };
        } else if (heldSeconds < 180) {'''

new_1 = '''        // The one price-based floor spans both regimes. The scanner's planned stop used to
        // terminate positions on touch at any age — a 29s exit at -38bp — which is neither
        // regime's rule. It is gone; -2% of executable net is the absolute backstop.
        //
        // EXP-1 (2026-08-02): -2% was the ONLY force-sell, so every LOB loser rode to it and
        // the realised stop averaged -239bp against a +42bp target. A counterfactual sweep on
        // 239 closed positions put the operating point at 30-70bp under every execution
        // slippage assumption tested, so the randomised arm width is now the operative stop
        // and -2% sits below it as the backstop. Widths and hash must stay byte-identical to
        // public.exp_stop_arm_bps(uuid) and to the market-autotrader core.ts override, or
        // runtime and database judge different positions. The database guard tests price
        // drawdown, so this test does too.
        const exp1ArmWidthsBps = [30, 50, 90];
        const exp1ArmHash =
          parseInt(String(position.id ?? "").replace(/-/g, "").slice(-8), 16);
        const exp1ArmBps = exp1ArmWidthsBps[
          (Number.isFinite(exp1ArmHash) ? exp1ArmHash : 0) % exp1ArmWidthsBps.length
        ];
        if (guardedNetReturnPct <= -2) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "HARD_STOP_MINUS_2",
          };
        } else if (drawdownPct <= -(exp1ArmBps / 100)) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: `EXP1_ARM_STOP_${exp1ArmBps}`,
          };
        } else if (heldSeconds < 180) {'''

old_2 = '''        const approvedPre180PlannedStop = decision.action === "STOP" &&
          (decision as any).reason === "lob:STOP_HIT" &&
          current <= finite(position.stop_price);
        if (
          !approvedPre180Target && !approvedPre180Reversal &&
          !approvedPre180PlannedStop
        ) {'''

new_2 = '''        const approvedPre180PlannedStop = decision.action === "STOP" &&
          (decision as any).reason === "lob:STOP_HIT" &&
          current <= finite(position.stop_price);
        // The two price floors are age-independent by design and the database guard already
        // clears both ahead of its own 180s branch. This list did not carry them, so a
        // position that breached -2% inside 180 seconds was held anyway and kept falling —
        // realised stops reached -245bp (binance) and -319bp (upbit) against a -200bp policy.
        // EXP-1 arm stops fire mostly inside 180s, so without this they never execute.
        const approvedPre180PriceFloor = decision.action === "STOP" &&
          ((decision as any).reason === "HARD_STOP_MINUS_2" ||
            String((decision as any).reason || "").startsWith("EXP1_ARM_STOP_"));
        if (
          !approvedPre180Target && !approvedPre180Reversal &&
          !approvedPre180PlannedStop && !approvedPre180PriceFloor
        ) {'''

already_patched = (
    source.count("const exp1ArmWidthsBps = [30, 50, 90];") == 1
    and source.count("approvedPre180PriceFloor") == 2
)

if not already_patched:
    count_1 = source.count(old_1)
    count_2 = source.count(old_2)
    if count_1 != 1:
        raise SystemExit(f"first replacement anchor count={count_1}, expected=1")
    if count_2 != 1:
        raise SystemExit(f"second replacement anchor count={count_2}, expected=1")
    source = source.replace(old_1, new_1, 1)
    source = source.replace(old_2, new_2, 1)
    path.write_text(source, encoding="utf-8")

final = path.read_text(encoding="utf-8")
checks = {
    "hard stop anchor": final.count('if (guardedNetReturnPct <= -2) {'),
    "EXP-1 arm widths": final.count("const exp1ArmWidthsBps = [30, 50, 90];"),
    "pre-180 price-floor references": final.count("approvedPre180PriceFloor"),
}
expected = {
    "hard stop anchor": 1,
    "EXP-1 arm widths": 1,
    "pre-180 price-floor references": 2,
}
for name, value in checks.items():
    if value != expected[name]:
        raise SystemExit(f"{name} count={value}, expected={expected[name]}")

print("EXP-1 index arm stop replacements verified")
