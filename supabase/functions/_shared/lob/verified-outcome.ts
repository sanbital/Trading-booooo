// Trading-booooo v6.10.0 r7 — authoritative learning-label parser.
//
// A pattern profile may vote only when all three economic dimensions are verified:
// residual accounting, fee accounting, and fill-conditional prediction basis.

import type { LobOutcomeSample } from "./learning.ts";
import type { LobPatternName } from "./types.ts";
import type { LobTrapName } from "./traps.ts";

const PATTERNS = new Set<LobPatternName>([
  "ABSORPTION_REVERSAL",
  "QUEUE_DEPLETION_BREAKOUT",
  "SWEEP_RECLAIM",
  "OFI_CONTINUATION",
  "REPLENISHMENT_ICEBERG",
]);

const TRAPS = new Set<LobTrapName>([
  "ASK_ICEBERG",
  "BID_SPOOF",
  "ASK_SPOOF",
  "CHOP_NO_VIABLE_STOP",
  "QUOTE_FLICKER",
]);

const VERIFIED_ACCOUNTING = new Set([
  "NO_RESIDUAL",
  "RESIDUAL_MARKED_TO_EXIT",
]);

const VERIFIED_FEES = new Set([
  "EXACT",
  "AGGREGATE_EXACT",
  "THIRD_ASSET_MARKED",
  "BASE_ASSET_ACCOUNTED",
]);

function finite(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === 1 || String(value).toLowerCase() === "true") return true;
  if (value === false || value === 0 || String(value).toLowerCase() === "false") return false;
  return null;
}

export function verifiedOutcomeReason(row: Record<string, any>): string | null {
  if (!VERIFIED_ACCOUNTING.has(String(row?.accounting_quality || ""))) {
    return "UNVERIFIED_RESIDUAL_ACCOUNTING";
  }
  if (!VERIFIED_FEES.has(String(row?.fee_accounting_quality || ""))) {
    return "UNVERIFIED_FEE_ACCOUNTING";
  }
  if (String(row?.prediction_basis || "") !== "FILL_CONDITIONAL") {
    return "UNVERIFIED_PREDICTION_BASIS";
  }
  if (!Number.isFinite(finite(row?.net_bps))) return "NET_BPS_MISSING";
  if (!row?.entry_snapshot || typeof row.entry_snapshot !== "object") {
    return "ENTRY_SNAPSHOT_MISSING";
  }
  return null;
}

export function verifiedOutcomeToSample(
  row: Record<string, any>,
): LobOutcomeSample | null {
  if (verifiedOutcomeReason(row)) return null;

  const snapshot = row.entry_snapshot || {};
  const pattern = String(row.pattern || snapshot.pattern || "") as LobPatternName;
  if (!PATTERNS.has(pattern)) return null;

  const predicted = finite(snapshot.p_target);
  if (!Number.isFinite(predicted)) return null;

  const target = finite(snapshot.target_bps);
  const stop = finite(snapshot.noise_adjusted_stop_bps ?? snapshot.stop_bps);
  const neutral = Number.isFinite(finite(snapshot.neutral_win_rate))
    ? finite(snapshot.neutral_win_rate)
    : Number.isFinite(target) && Number.isFinite(stop) && target + stop > 0
    ? stop / (target + stop)
    : Number.NaN;
  if (!Number.isFinite(neutral)) return null;

  const netBps = finite(row.net_bps);
  const explicitTargetHit = bool(row.target_hit);
  const exitReason = String(row.exit_reason || row.close_reason || "").toUpperCase();
  const outcome: 0 | 1 = explicitTargetHit != null
    ? explicitTargetHit ? 1 : 0
    : exitReason.includes("TARGET")
    ? 1
    : netBps > 0
    ? 1
    : 0;

  const traps = Array.isArray(snapshot.traps)
    ? snapshot.traps
      .map(String)
      .filter((name): name is LobTrapName => TRAPS.has(name as LobTrapName))
    : [];

  const heldSeconds = Math.max(0, finite(row.held_seconds, 0));
  const closedAtMs = Date.parse(String(row.closed_at || "")) || Date.now();

  return {
    pattern,
    predicted,
    neutral,
    outcome,
    netBps,
    heldSeconds,
    traps,
    exploration: Boolean(
      row.is_exploration ??
        snapshot.is_exploration ??
        snapshot.exploration,
    ),
    closedAtMs,
  };
}
