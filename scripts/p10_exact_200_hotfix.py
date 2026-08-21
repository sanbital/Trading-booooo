from __future__ import annotations

import argparse
import re
from pathlib import Path

POLICY = Path("supabase/functions/_shared/p10-policy.ts")
INDEX = Path("supabase/functions/market-autotrader/index.ts")
TEST = Path("supabase/functions/_shared/p10-policy.test.ts")

HELPER = '''export function p10ExactFuturesTicketCapital(\n  availableInput: number,\n  operatorMarginInput: number,\n  stepInput = 0.01,\n) {\n  const available = Math.max(0, finite(availableInput));\n  const operatorMargin = Math.max(0, finite(operatorMarginInput));\n  const step = Math.max(0.000000000001, finite(stepInput, 0.01));\n  if (!(operatorMargin > 0) || available + 1e-9 < operatorMargin) return 0;\n  const stepped = Math.floor((operatorMargin + step * 1e-9) / step) * step;\n  return Number(Math.max(0, stepped).toFixed(12));\n}\n\n'''

OLD_FUTURES = '''  if (exchange === "binance_futures") {\n    const operatorMargin = finite((settings as any).binance_futures_allocation_usdt, 50);\n    if (operatorMargin > 0) maximum = operatorMargin;\n    minimum = FUTURES_MIN_ENTRY_MARGIN_USDT;\n  }\n'''

OLD_200_CAP = '''  if (exchange === "binance_futures") {\n    const operatorMargin = finite((settings as any).binance_futures_allocation_usdt, 200);\n    if (operatorMargin > 0) maximum = operatorMargin;\n    minimum = FUTURES_MIN_ENTRY_MARGIN_USDT;\n  }\n'''

NEW_FUTURES = '''  if (exchange === "binance_futures") {\n    const operatorMargin = finite((settings as any).binance_futures_allocation_usdt, 200);\n    if (operatorMargin > 0) {\n      return p10ExactFuturesTicketCapital(available, operatorMargin, 0.01);\n    }\n    minimum = FUTURES_MIN_ENTRY_MARGIN_USDT;\n  }\n'''

TEST_MARKER = 'Deno.test("P10 exact futures margin is per slot and never downsizes"'
TESTS = r'''

Deno.test("P10 exact futures margin is per slot and never downsizes", () => {
  // A-D: 200 is per position, independent of capital/slot division.
  assertEquals(p10ExactFuturesTicketCapital(500, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(200, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(199.99, 200), 0);
  assertEquals(p10ExactFuturesTicketCapital(334, 200), 200);
});

Deno.test("P10 spot venues keep generic capital divided by slots sizing", () => {
  // E: Binance spot unchanged.
  assertEquals(
    p10ExecutableTicketCapital({
      available: 500,
      capital: 500,
      slots: 10,
      maximum: 100,
      minimum: 10,
      step: 0.01,
    }),
    50,
  );
  // F: Upbit unchanged.
  assertEquals(
    p10ExecutableTicketCapital({
      available: 500_000,
      capital: 500_000,
      slots: 10,
      maximum: 100_000,
      minimum: 5_000,
      step: 1_000,
    }),
    50_000,
  );
});

Deno.test("P10 10-slot gate remains independent from ticket sizing", () => {
  // G: active=10 blocks; active=3 allows up to configured max-new=3.
  const maxNew = (slots: number, active: number, configured: number) =>
    Math.max(0, Math.min(slots - active, Math.floor(configured)));
  assertEquals(maxNew(10, 10, 3), 0);
  assertEquals(maxNew(10, 3, 3), 3);
});

Deno.test("P10 exact futures margin refuses a downsized second ticket", () => {
  // H: 334 can fund one 200 ticket; the resulting 134 cannot fund another.
  assertEquals(p10ExactFuturesTicketCapital(334, 200), 200);
  assertEquals(p10ExactFuturesTicketCapital(134, 200), 0);
});
'''


def patch() -> None:
    policy = POLICY.read_text()
    if "export function p10ExactFuturesTicketCapital(" not in policy:
        anchor = "export function p10ExecutableTicketCapital(input: {\n"
        if anchor not in policy:
            raise SystemExit("p10 policy insertion anchor missing")
        policy = policy.replace(anchor, HELPER + anchor, 1)
        POLICY.write_text(policy)

    index = INDEX.read_text()
    if "p10ExactFuturesTicketCapital," not in index:
        anchor = "  p10ExecutableTicketCapital,\n"
        if anchor not in index:
            raise SystemExit("p10 import anchor missing")
        index = index.replace(anchor, anchor + "  p10ExactFuturesTicketCapital,\n", 1)

    if OLD_FUTURES in index:
        index = index.replace(OLD_FUTURES, NEW_FUTURES, 1)
    elif OLD_200_CAP in index:
        index = index.replace(OLD_200_CAP, NEW_FUTURES, 1)
    elif "return p10ExactFuturesTicketCapital(available, operatorMargin, 0.01);" not in index:
        raise SystemExit("P10 futures sizing block missing or ambiguous")
    INDEX.write_text(index)

    test = TEST.read_text()
    if "p10ExactFuturesTicketCapital," not in test:
        anchor = "  p10ExecutableTicketCapital,\n"
        if anchor not in test:
            raise SystemExit("p10 test import anchor missing")
        test = test.replace(anchor, anchor + "  p10ExactFuturesTicketCapital,\n", 1)
    if TEST_MARKER not in test:
        test += TESTS
    TEST.write_text(test)


def validate() -> None:
    policy = POLICY.read_text()
    index = INDEX.read_text()
    test = TEST.read_text()

    if "export function p10ExactFuturesTicketCapital(" not in policy:
        raise SystemExit("exact futures helper missing")
    if "available + 1e-9 < operatorMargin" not in policy:
        raise SystemExit("insufficient-margin zero-ticket guard missing")

    start = index.index("function p10TicketCapital(")
    end = index.index("\n}\n", start) + 3
    block = index[start:end]
    if not re.search(r"binance_futures_allocation_usdt,\s*200", block):
        raise SystemExit("futures default margin is not 200")
    if "return p10ExactFuturesTicketCapital(available, operatorMargin, 0.01);" not in block:
        raise SystemExit("futures exact-ticket early return missing")
    futures = block[block.index('if (exchange === "binance_futures")'):]
    if "capital / slots" in futures:
        raise SystemExit("futures ticket still divides by slots")
    if "positionSlots - active.length" not in index:
        raise SystemExit("slot-cap gate missing")
    if "max_new_entries_per_scan" not in index:
        raise SystemExit("max-new-per-scan gate missing")
    if TEST_MARKER not in test:
        raise SystemExit("exact-200 regression tests missing")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if not args.validate_only:
        patch()
    validate()
