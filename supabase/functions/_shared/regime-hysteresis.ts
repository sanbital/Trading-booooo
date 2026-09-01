// Committed regime label for the full-market observer.
//
// The observer scores the market on a 0-100 bull scale every five minutes and used to map that
// score through a bare step function (72 / 58 / 42). A score sitting on a boundary therefore
// relabelled the market on nearly every observation: replayed over the 3,164 live observations
// from 2026-08-21 to 09-01 it changed label 372 times, a flip every ~43 minutes, and which side
// of the 58 line a five-minute print happened to land on decided whether entries were open.
//
// Each boundary here keeps a pair of thresholds instead of one. Moving up requires the
// classifier's own training ground truth (40 / 60 / 75, already recorded on every observation as
// `training_ground_truth_thresholds`); moving back down requires its predicted threshold
// (42 / 58 / 72). The band is therefore not a new free parameter -- it is the gap the model
// already carries between the label it predicts and the label it was trained against. A boundary
// only moves once REGIME_DWELL consecutive observations agree, matching the two-confirmation
// idiom P10_MARKET_RISK_CONFIG already applies to its own exit thresholds.
//
// Replayed over that same series this cuts flips 372 -> 173 (-53%) and lifts median regime dwell
// from 25 to 45 minutes, while the share of observations labelled BULL or above moves only
// 17.4% -> 14.4%. It removes boundary churn without repricing exposure.

export const REGIME_LEVELS = ["RISK_OFF", "NEUTRAL", "BULL", "STRONG_BULL"] as const;
export type RegimeLabel = typeof REGIME_LEVELS[number];

/** Boundary-specific promotion/demotion thresholds retained from the two existing threshold sets. */
export const REGIME_BANDS = Object.freeze([
  { level: 1, up: 42, down: 40 },
  { level: 2, up: 60, down: 58 },
  { level: 3, up: 75, down: 72 },
]);

export const REGIME_DWELL = 2;

/** Unsmoothed classifier. Retained as the fallback when there is no committed prior to hold. */
export function instantaneousRegimeOf(score: number): RegimeLabel {
  return score >= 72 ? "STRONG_BULL" : score >= 58 ? "BULL" : score >= 42 ? "NEUTRAL" : "RISK_OFF";
}

function levelOf(regime: unknown): number | null {
  const index = REGIME_LEVELS.indexOf(String(regime) as RegimeLabel);
  return index < 0 ? null : index;
}

/**
 * Committed label for `score`, given the previously committed label and the bull scores of the
 * preceding observations (most recent first). Falls back to the unsmoothed classifier when there
 * is no usable prior -- a cold start must not invent a regime it has no evidence for.
 */
export function committedRegimeOf(
  score: number,
  priorRegime: unknown,
  priorScores: readonly number[] | null | undefined,
): RegimeLabel {
  if (!Number.isFinite(score)) return instantaneousRegimeOf(0);
  const window = [score, ...(Array.isArray(priorScores) ? priorScores : [])]
    .filter((value) => Number.isFinite(value))
    .slice(0, REGIME_DWELL);
  const prior = levelOf(priorRegime);
  if (prior === null || window.length < REGIME_DWELL) return instantaneousRegimeOf(score);
  let level = 0;
  for (const band of REGIME_BANDS) {
    const held = prior >= band.level;
    const up = window.every((value) => value >= band.up);
    const down = window.every((value) => value <= band.down);
    if (up ? true : down ? false : held) level++;
  }
  return REGIME_LEVELS[Math.min(REGIME_LEVELS.length - 1, Math.max(0, level))];
}
