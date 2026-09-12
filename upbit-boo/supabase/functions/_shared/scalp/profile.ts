// Trading-booooo v6.0.0-LOB — strategy-profile holding barriers.

import type { StrategyProfile } from "./outcome-forecaster.ts";

export interface ProfileHoldingDecision {
  profile: StrategyProfile;
  profileCeilingMinutes: number;
  geometryHorizonCeilingMinutes: number;
  expectedResolutionMinutes: number;
  timeoutMinutes: number;
}

function clamp(value: number, low: number, high: number): number {
  const x = Number.isFinite(value) ? value : low;
  return Math.max(low, Math.min(high, x));
}

export function normalizeStrategyProfile(value: unknown): StrategyProfile {
  const profile = String(value);
  return profile === "LOB_SCALP" ? "LOB_SCALP" : profile === "INTRADAY_SCALP" ? "INTRADAY_SCALP" : "HF_SCALP";
}

export function profileHoldingCeilingMinutes(profile: StrategyProfile): number {
  return profile === "LOB_SCALP" ? 5 : profile === "INTRADAY_SCALP" ? 120 : 30;
}

export function resolveProfileHolding(
  profileValue: unknown,
  configuredHorizonMinutes: number,
  configuredTimeoutMinutes: number,
  expectedResolutionMinutes: number,
): ProfileHoldingDecision {
  const profile = normalizeStrategyProfile(profileValue);
  const profileCeilingMinutes = profileHoldingCeilingMinutes(profile);
  const minimum = profile === "LOB_SCALP" ? 0.1 : 5;
  const expectedMinimum = profile === "LOB_SCALP" ? 0.1 : 1;
  const geometryHorizonCeilingMinutes = clamp(configuredHorizonMinutes, minimum, profileCeilingMinutes);
  const expected = clamp(expectedResolutionMinutes, expectedMinimum, geometryHorizonCeilingMinutes);
  const timeoutMinutes = Math.min(
    profileCeilingMinutes,
    Math.max(expected, clamp(configuredTimeoutMinutes, minimum, profileCeilingMinutes)),
  );
  return {
    profile,
    profileCeilingMinutes,
    geometryHorizonCeilingMinutes,
    expectedResolutionMinutes: expected,
    timeoutMinutes,
  };
}
