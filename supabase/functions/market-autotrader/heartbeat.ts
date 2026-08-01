export type TradingHeartbeatPatch = {
  lastMonitorAt?: string;
  lastFullScanAt?: string;
  lastGatewayHeartbeatAt?: string;
  gatewayErrorCount?: number;
  gatewayRecoveryCycles?: number;
};

/**
 * Build the only payload a scheduler/monitor heartbeat may write.
 *
 * This explicit allowlist prevents a stale in-memory settings object from being spread
 * into a PATCH and restoring an old pause, strategy, allocation, or emergency flag.
 */
export function buildTradingHeartbeatPatch(input: TradingHeartbeatPatch): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.lastMonitorAt !== undefined) patch.last_monitor_at = input.lastMonitorAt;
  if (input.lastFullScanAt !== undefined) patch.last_full_scan_at = input.lastFullScanAt;
  if (input.lastGatewayHeartbeatAt !== undefined) {
    patch.last_gateway_heartbeat_at = input.lastGatewayHeartbeatAt;
  }
  if (input.gatewayErrorCount !== undefined) {
    patch.gateway_error_count = Math.max(0, Math.floor(Number(input.gatewayErrorCount) || 0));
  }
  if (input.gatewayRecoveryCycles !== undefined) {
    patch.gateway_recovery_cycles = Math.max(
      0,
      Math.floor(Number(input.gatewayRecoveryCycles) || 0),
    );
  }
  return patch;
}
