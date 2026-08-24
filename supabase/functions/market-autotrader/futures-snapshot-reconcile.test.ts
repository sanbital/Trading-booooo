import { assert, assertEquals } from "../../../test-support/assert.ts";
import {
  authenticatedFuturesSnapshot,
  FUTURES_POSITION_SNAPSHOT_REVISION,
} from "./futures-snapshot.ts";

const ROOT = new URL("../../../", import.meta.url);
const AUTOTRADER = await Deno.readTextFile(
  new URL("supabase/functions/market-autotrader/index.ts", ROOT),
);
const MIGRATION = await Deno.readTextFile(
  new URL(
    "supabase/migrations/20260824031619_direction_aware_futures_snapshot_reconcile.sql",
    ROOT,
  ),
);

Deno.test("futures snapshots retain both LONG and SHORT as directional account truth", () => {
  const snapshot = authenticatedFuturesSnapshot("binance_futures", {
    positions: [
      { market: "ethusdt", base_asset: "eth", side: "short", quantity: 2.5 },
      { market: "BTCUSDT", base_asset: "BTC", side: "LONG", quantity: 0.01 },
    ],
  });

  assert(snapshot.complete);
  assertEquals(snapshot.positions?.map((row) => [row.market, row.side, row.quantity]), [
    ["ETHUSDT", "SHORT", 2.5],
    ["BTCUSDT", "LONG", 0.01],
  ]);
});

Deno.test("an authenticated empty futures position list remains distinguishable from omission", () => {
  assertEquals(authenticatedFuturesSnapshot("binance_futures", { positions: [] }), {
    positions: [],
    complete: true,
  });
  assertEquals(authenticatedFuturesSnapshot("binance_futures", {}), {
    positions: null,
    complete: false,
  });
  assertEquals(authenticatedFuturesSnapshot("binance", { positions: [] }), {
    positions: null,
    complete: false,
  });
});

Deno.test("malformed futures rows fail the whole snapshot closed", () => {
  for (
    const positions of [
      [{ market: "ETHUSDT", side: "SHORT", quantity: 0 }],
      [{ market: "ETHUSDT", side: "SIDEWAYS", quantity: 2 }],
      [{ market: "ETH-USDT", side: "SHORT", quantity: 2 }],
      [{ market: "ETHUSDT", side: "SHORT", quantity: "not-a-number" }],
    ]
  ) {
    assertEquals(authenticatedFuturesSnapshot("binance_futures", { positions }), {
      positions: null,
      complete: false,
    });
  }
});

Deno.test("SHORT zero reconciliation requires three complete directional snapshots", () => {
  assert(MIGRATION.includes("r.position_side = 'SHORT'"));
  assert(MIGRATION.includes("coalesce(new.positions_complete, false) = false"));
  assert(MIGRATION.includes("v_recent_count = 3"));
  assert(MIGRATION.includes("v_usable_count = 3"));
  assert(MIGRATION.includes("v_zero_count = 3"));
  assert(MIGRATION.includes("upper(r.market)"));
  assert(MIGRATION.includes(FUTURES_POSITION_SNAPSHOT_REVISION));
  assert(!MIGRATION.includes("position_row->>'side'"));
  assert(MIGRATION.includes("opposite-side row is a ledger-direction mismatch"));
  assert(MIGRATION.includes("r.position_side = 'LONG'"));
  assert(MIGRATION.includes("jsonb_array_elements(recent.balances)"));
  assert(MIGRATION.includes("then 'BUY'"));
  assert(MIGRATION.includes("else 'SELL'"));
});

Deno.test("snapshot persistence and trigger privileges are deployment guarded", () => {
  assert(AUTOTRADER.includes("authenticatedFuturesSnapshot(exchange, portfolio)"));
  assert(AUTOTRADER.includes("positions: futuresSnapshot.positions"));
  assert(AUTOTRADER.includes("positions_complete: futuresSnapshot.complete"));
  assert(
    AUTOTRADER.includes(
      "positions_revision: futuresSnapshot.complete ? FUTURES_POSITION_SNAPSHOT_REVISION : null",
    ),
  );
  assert(MIGRATION.includes("8.0.1-DIRECTION-AWARE-FUTURES-ZERO-SNAPSHOT-RECONCILE"));
  assert(MIGRATION.includes("security definer"));
  assert(MIGRATION.includes("set search_path = ''"));
  assert(
    MIGRATION.includes(
      "revoke all on function public.reconcile_futures_zero_positions_from_snapshots()",
    ),
  );
  assert(MIGRATION.includes("from public, anon, authenticated"));
  assert(MIGRATION.includes("to service_role"));
  assert(MIGRATION.includes("add column if not exists positions jsonb,"));
  assert(!MIGRATION.includes("add column if not exists positions jsonb not null"));
  assert(
    MIGRATION.includes(
      "add column if not exists positions_complete boolean not null default false",
    ),
  );
  assert(MIGRATION.includes("add column if not exists positions_revision text"));
});
