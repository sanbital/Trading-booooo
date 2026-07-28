import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../../", import.meta.url);

Deno.test("v6 LOB route owns entry authority and trend is auxiliary", async () => {
  const [entry, scanner] = await Promise.all([
    Deno.readTextFile(new URL("supabase/functions/_shared/lob/entry.ts", ROOT)),
    Deno.readTextFile(new URL("supabase/functions/market-scanner/engine.ts", ROOT)),
  ]);
  assert(entry.includes("auxiliary only; never a veto"));
  assert(scanner.includes('if (risk.strategy === "LOB_SCALP")'));
  assert(scanner.includes("decision = lobResult.decision"));
});

Deno.test("v6 LOB route has no pWin or pFill hard gate", async () => {
  const [entry, payoff] = await Promise.all([
    Deno.readTextFile(new URL("supabase/functions/_shared/lob/entry.ts", ROOT)),
    Deno.readTextFile(new URL("supabase/functions/_shared/lob/payoff-governor.ts", ROOT)),
  ]);
  assert(
    entry.includes("TARGET_NET_PROFIT_NOT_POSITIVE") ||
      payoff.includes("TARGET_NET_CUSHION_TOO_SMALL"),
  );
  assert(entry.includes("NET_EV_NOT_POSITIVE"));
  assertEquals(entry.includes("PWIN_LOWER_BOUND_BELOW"), false);
  assertEquals(entry.includes("PFILL_LOWER_BOUND_TOO_LOW"), false);
});

Deno.test("v6 migration applies user-selected loss caps and no trade-count ceiling", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/202607260016_lob_scalp_v600.sql",
      ROOT,
    ),
  );
  assert(sql.includes("scalp_max_single_loss_pct = 5"));
  assert(sql.includes("scalp_daily_loss_pct = 30"));
  assert(sql.includes("max_daily_entries = 1000000"));
  assert(sql.includes("lob_max_holding_seconds = 180"));
  assert(sql.includes("lob_absolute_max_holding_seconds = 300"));
  assert(sql.includes("mode = 'PAPER'"));
});

Deno.test("v6 LOB route does not generate legacy rate-control events", async () => {
  const code = await Deno.readTextFile(
    new URL(
      "supabase/functions/market-autotrader/index.ts",
      ROOT,
    ),
  );
  const lob = code.indexOf("if (isLobStrategy((settings as any).strategy))");
  const legacy = code.indexOf('(settings as any).strategy === "SCALP"', lob);
  const rateEvent = code.indexOf('"SCALP_RATE_CONTROL"', legacy);
  assert(lob >= 0 && legacy > lob && rateEvent > legacy);
});
