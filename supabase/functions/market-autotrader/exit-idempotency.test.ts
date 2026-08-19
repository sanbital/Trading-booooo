import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("live exits have a single exchange-side-effect claim", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (
    const needle of [
      "const pendingSellOrders = await unappliedBotSellOrders(position);",
      '"EXIT_DEFERRED_UNSETTLED_ORDER"',
      "`id=eq.${position.id}&state=eq.OPEN`",
      '"EXIT_CLAIM_SKIPPED"',
      "`id=eq.${position.id}&state=eq.EXITING`",
    ]
  ) {
    assert(source.includes(needle), `missing exit idempotency invariant: ${needle}`);
  }
});

Deno.test("exit accounting keeps the complete exchange fill contract", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(source.includes("p_fill_quantity: quantity"));
  assert(source.includes("p_fill_funds: finite(fill.executedFunds, price * quantity)"));
  assert(source.includes("p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee)"));
});
