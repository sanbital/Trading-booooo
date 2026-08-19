from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
TEST = Path("supabase/functions/market-autotrader/exit-finalization-idempotency.test.ts")

source = INDEX.read_text()
old = '''  await event(
    applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT",
    `${position.exchange}:${position.market} ${action}`,
    {
      price: applied.fillPrice,
      sold_quantity: applied.quantity,
      remaining: finite(updated?.remaining_quantity),
      pnl_quote: finite(updated?.realized_pnl_quote),
      quote: position.quote_currency,
      accounting_applied: applied.applied,
    },
    { cycleId, positionId: position.id, orderId: result.orderRow.id },
  );
'''
new = '''  // Exit finalization idempotency v7.6.12: reconciliation can rediscover an
  // already-APPLIED exchange order. The accounting RPC is correctly idempotent, so a
  // replay returns applied=false. Do not manufacture a fresh PARTIAL_EXIT/POSITION_CLOSED
  // event for that no-op; those events are state-transition facts, not poll telemetry.
  if (applied.applied) {
    await event(
      applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT",
      `${position.exchange}:${position.market} ${action}`,
      {
        price: applied.fillPrice,
        sold_quantity: applied.quantity,
        remaining: finite(updated?.remaining_quantity),
        pnl_quote: finite(updated?.realized_pnl_quote),
        quote: position.quote_currency,
        accounting_applied: true,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow.id },
    );
  }
'''
marker = "Exit finalization idempotency v7.6.12"
if marker not in source:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"FINALIZATION_SOURCE_DRIFT: expected 1 event block, found {count}")
    source = source.replace(old, new, 1)

for needle in (
    marker,
    "if (applied.applied) {",
    "accounting_applied: true",
    'const pendingSellOrders = await unappliedBotSellOrders(position);',
    '`id=eq.${position.id}&state=eq.OPEN`',
    '`id=eq.${position.id}&state=eq.EXITING`',
    "p_fill_quantity: quantity",
):
    if needle not in source:
        raise SystemExit(f"FINALIZATION_PATCH_INCOMPLETE: missing {needle}")

INDEX.write_text(source)
TEST.write_text(r'''import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("exit transition events are emitted only for newly applied accounting", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const marker = "Exit finalization idempotency v7.6.12";
  const start = source.indexOf(marker);
  assert(start >= 0, "missing v7.6.12 finalization guard");
  const window = source.slice(start, start + 1400);
  assert(window.includes("if (applied.applied) {"));
  assert(window.includes('applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT"'));
  assert(window.includes("accounting_applied: true"));
  assertEquals(window.includes("accounting_applied: applied.applied"), false);
});

Deno.test("exchange-side-effect idempotency remains intact", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const needle of [
    "const pendingSellOrders = await unappliedBotSellOrders(position);",
    "`id=eq.${position.id}&state=eq.OPEN`",
    "`id=eq.${position.id}&state=eq.EXITING`",
    "p_fill_quantity: quantity",
  ]) assert(source.includes(needle), `missing invariant: ${needle}`);
});
''')
print("exit finalization idempotency v7.6.12 patch prepared")
