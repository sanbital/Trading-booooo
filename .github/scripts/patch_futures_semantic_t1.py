from pathlib import Path

p = Path("supabase/functions/market-autotrader/index.ts")
text = p.read_text()
old = '''        const hasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >
          residualTolerance;
'''
new = '''        const quantityHasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >
          residualTolerance;
        // Futures residual stage is semantic, not inferred from quantity. Only an applied
        // TARGET_1 fill may set t1_completed; timeout/stop/other partial fills must never
        // fabricate a winning residual. Spot keeps its legacy quantity geometry.
        const hasTradableHalf = futuresLane
          ? position.t1_completed !== true
          : quantityHasTradableHalf;
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one hasTradableHalf block, got {count}")
p.write_text(text.replace(old, new))
print("patched runtime Futures residual stage to semantic T1")
