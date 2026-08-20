import { buildTradingHeartbeatPatch } from "./heartbeat.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("heartbeat patch includes only operational heartbeat columns", () => {
  const input = {
    lastMonitorAt: "2026-08-01T00:00:00.000Z",
    lastGatewayHeartbeatAt: "2026-08-01T00:00:01.000Z",
    gatewayErrorCount: 0,
    pause_new_entries: false,
    emergency_liquidation: true,
    strategy: "OLD_STRATEGY",
  } as any;
  const patch = buildTradingHeartbeatPatch(input);
  assert(patch.last_monitor_at === input.lastMonitorAt);
  assert(patch.last_gateway_heartbeat_at === input.lastGatewayHeartbeatAt);
  assert(patch.gateway_error_count === 0);
  assert(!("pause_new_entries" in patch));
  assert(!("emergency_liquidation" in patch));
  assert(!("strategy" in patch));
});
