from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")

old = (
    '        const plannedStopRequested = requestedAction === "STOP" &&\n'
    '          requestedReason === "lob:STOP_HIT" &&\n'
    '          current <= finite(position.stop_price);'
)
new = (
    '        const plannedStopRequested = requestedAction === "STOP" &&\n'
    '          finite(position.stop_price) > 0 &&\n'
    '          current <= finite(position.stop_price);'
)

count = text.count(old)
if count != 1:
    raise SystemExit(f"expected exactly one match, found {count}")
text = text.replace(old, new, 1)
PATH.write_text(text, encoding="utf-8")
print(f"patched {PATH}")
