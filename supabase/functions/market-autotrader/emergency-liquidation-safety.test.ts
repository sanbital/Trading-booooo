import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);

Deno.test("emergency liquidation uses its confirmed RPC and never masquerades as TIME", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );

  assert(source.includes('rpc("request_emergency_liquidation"'));
  assert(source.includes('p_confirmation: String(body.confirmation || "")'));
  assert(source.includes('if (action === "EMERGENCY") return "EMERGENCY"'));
  assert(source.includes('action: "EMERGENCY",\n          reason: "EMERGENCY_LIQUIDATION"'));
  assert(!source.includes('action: "TIME",\n          reason: "EMERGENCY_LIQUIDATION"'));
  assert(source.includes('rpc("complete_emergency_liquidation", {})'));
  assert(source.includes("active emergency liquidation can only be cleared"));
  assert(!source.includes('"&state=eq.OPEN&select=id&limit=1"'));
});

Deno.test("database rejects raw emergency toggles and exposes one confirmed transition", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "supabase/migrations/20260824054500_confirm_emergency_liquidation.sql",
      ROOT,
    ),
  );

  assert(migration.includes("before update of emergency_liquidation"));
  assert(migration.includes("current_setting('trading.emergency_liquidation_confirmation', true)"));
  assert(migration.includes("current_setting('trading.emergency_liquidation_clearance', true)"));
  assert(migration.includes("create or replace function public.request_emergency_liquidation"));
  assert(migration.includes("create or replace function public.complete_emergency_liquidation"));
  assert(migration.includes("coalesce(p_confirmation, '') <> 'LIQUIDATE_NOW'"));
  assert(migration.includes("pause_lock_reason = 'EMERGENCY_LIQUIDATION'"));
  assert(migration.includes("emergency_liquidation_started_at timestamptz"));
  assert(migration.includes("when emergency_liquidation is true"));
  assert(migration.includes("then emergency_liquidation_started_at"));
  assert(migration.includes("EMERGENCY_EPISODE_MARKER_MISSING"));
  assert(migration.includes("emergency_liquidation_started_at = null"));
  for (
    const state of [
      "ENTRY_PENDING",
      "OPEN",
      "EXITING",
      "RECONCILING",
      "RECONCILIATION_FAILED",
      "MANUAL_INTERVENTION_REQUIRED",
    ]
  ) assert(migration.includes(`'${state}'`));
  assert(migration.includes("v_pending_close_orders"));
  assert(migration.includes("left join public.trading_positions p on p.id = o.position_id"));
  assert(
    migration.includes(
      "o.requested_at >= v_settings.emergency_liquidation_started_at",
    ),
  );
  assert(migration.includes("create or replace function public.guard_p10_live_entry_settings"));
  assert(migration.includes("for share"));
  assert(migration.includes("P10 live entry blocked by current trading settings"));
  assert(migration.includes("trg_guard_p10_live_entry_settings"));
  assert(migration.includes("from public, anon, authenticated"));
  assert(
    migration.includes(
      "revoke all on function public.guard_emergency_liquidation_transition()",
    ),
  );
  assert(
    migration.includes("revoke all on function public.guard_p10_live_entry_settings()"),
  );
});

Deno.test("GitHub emergency control forwards the explicit confirmation", async () => {
  const workflow = await Deno.readTextFile(
    new URL(".github/workflows/trading-control.yml", ROOT),
  );
  const command = workflow.split("emergency_liquidate) body=")[1]?.split(";;")[0] || "";

  assert(command.includes('\\"confirmation\\":\\"${CONFIRMATION}\\"'));
  assertEquals(command.includes('\\"pause_confirmation\\":\\"PAUSE_NOW\\"'), false);
  assert(workflow.includes('resume_new_entries) body=\'{"action":"resume"}\''));
});
