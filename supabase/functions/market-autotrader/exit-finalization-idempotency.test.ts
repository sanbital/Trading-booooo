import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

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
  for (
    const needle of [
      "const pendingSellOrders = await unappliedBotSellOrders(position);",
      "`id=eq.${position.id}&state=eq.OPEN`",
      "`id=eq.${position.id}&state=eq.EXITING`",
      "p_fill_quantity: quantity",
    ]
  ) assert(source.includes(needle), `missing invariant: ${needle}`);
});
