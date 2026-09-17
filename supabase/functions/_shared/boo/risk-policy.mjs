/**
 * Risk limits the strategy cannot change (brief section 6).
 *
 * Two jobs:
 *   1. Hold the protective constants as fractions, in one place, so no caller
 *      can "tune" them upward after a bad day.
 *   2. Convert the live `trading_settings` *_pct columns into those fractions
 *      explicitly, and REFUSE the values that are currently in production
 *      rather than coercing them into something survivable.
 *
 * On 2026-09-16 13:01 UTC the live row reads risk_per_trade_pct = 100 and
 * max_daily_loss_pct = 30.  Read as percentages those mean "risk the entire
 * account on one trade" and "stop after losing 30% of it".  Neither is a
 * plausible intent, and neither is something this module is allowed to quietly
 * reinterpret as 1.00 or 0.30 of anything smaller.  They are configuration
 * errors and they are reported as configuration errors.
 */

import { Dec, dec, isDecimal, ZERO } from "./decimal.mjs";

export const RISK_POLICY_VERSION = "BOO-RISK-POLICY-1";

/**
 * Protective defaults from the brief.  These are ceilings, not targets: a DB
 * value may make any of them SMALLER, never larger (see `resolveRiskPolicy`).
 */
export const PROTECTIVE_DEFAULTS = Object.freeze({
  risk_per_trade_frac: "0.0025",
  max_total_open_risk_frac: "0.005",
  max_gross_notional_to_equity: "1.0",
  max_concurrent_positions: 1,
  daily_loss_limit_frac: "0.01",
  weekly_loss_limit_frac: "0.03",
  recovery_high_water_drawdown_frac: "0.05",
  max_consecutive_losses: 3,
});

/**
 * Per-trade risk above this cannot be a deliberate setting for a futures
 * account.  Anything at or over it is rejected as a unit error rather than
 * applied.  0.05 = 5% of equity on one trade, already far beyond the 0.25%
 * this policy runs at.
 */
const IMPLAUSIBLE_TRADE_RISK_FRAC = "0.05";
const IMPLAUSIBLE_DAILY_LOSS_FRAC = "0.20";

export class RiskConfigError extends Error {
  constructor(code, detail) {
    super(`${code}:${detail}`);
    this.name = "RiskConfigError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Convert a *_pct column to a fraction.
 *
 * The column name says "pct", so the stored unit is percent and the conversion
 * is /100.  That is applied unconditionally -- guessing the unit from the
 * magnitude is exactly how a 100 becomes a 1.0 and empties an account.  The
 * plausibility check then runs on the CONVERTED value.
 */
/** @param {any} value @param {string} field @returns {any} */
export function pctToFrac(value, field) {
  if (value === null || value === undefined || !isDecimal(value)) {
    throw new RiskConfigError("RISK_SETTING_UNREADABLE", field);
  }
  const pct = dec(value);
  if (pct.isNeg()) throw new RiskConfigError("RISK_SETTING_NEGATIVE", `${field}=${pct}`);
  if (pct.gt(100)) throw new RiskConfigError("RISK_SETTING_ABOVE_100_PCT", `${field}=${pct}`);
  return pct.div(100);
}

/**
 * Resolve the effective, enforceable policy.
 *
 * `settings` is the raw trading_settings row (or null).  Missing settings are
 * NOT an excuse to fall back to the permissive defaults: section 4 says a
 * failed settings read must refuse new entries, so the caller gets
 * `ok:false` and the entry gate turns that into a refusal.
 */
/** @param {any} settings @param {any} [opts] @returns {any} */
export function resolveRiskPolicy(settings, { defaults = PROTECTIVE_DEFAULTS } = {}) {
  const errors = [];
  const evidence = { source: {}, version: RISK_POLICY_VERSION };

  if (!settings || typeof settings !== "object") {
    return {
      ok: false,
      errors: [{ code: "RISK_SETTINGS_UNAVAILABLE", detail: "trading_settings row missing" }],
      policy: null,
      evidence,
    };
  }

  // Per-trade risk.
  let riskPerTrade = dec(defaults.risk_per_trade_frac);
  evidence.source.risk_per_trade_frac = "PROTECTIVE_DEFAULT";
  if (settings.risk_per_trade_pct !== null && settings.risk_per_trade_pct !== undefined) {
    try {
      const f = pctToFrac(settings.risk_per_trade_pct, "risk_per_trade_pct");
      if (f.gte(IMPLAUSIBLE_TRADE_RISK_FRAC)) {
        errors.push({
          code: "RISK_PER_TRADE_IMPLAUSIBLE",
          detail:
            `risk_per_trade_pct=${settings.risk_per_trade_pct} -> ${f} of equity per trade; ` +
            `refusing. Set it to ${dec(defaults.risk_per_trade_frac).mul(100)} or lower.`,
        });
      } else if (f.lt(riskPerTrade)) {
        // A stricter operator value is honoured.
        riskPerTrade = f;
        evidence.source.risk_per_trade_frac = "TRADING_SETTINGS_STRICTER";
      } else {
        evidence.source.risk_per_trade_frac = "PROTECTIVE_DEFAULT_CAPS_SETTINGS";
      }
    } catch (e) {
      errors.push({ code: e.code ?? "RISK_SETTING_INVALID", detail: e.detail ?? String(e) });
    }
  }

  // Daily loss limit.
  let dailyLoss = dec(defaults.daily_loss_limit_frac);
  evidence.source.daily_loss_limit_frac = "PROTECTIVE_DEFAULT";
  if (settings.max_daily_loss_pct !== null && settings.max_daily_loss_pct !== undefined) {
    try {
      const f = pctToFrac(settings.max_daily_loss_pct, "max_daily_loss_pct");
      if (f.gte(IMPLAUSIBLE_DAILY_LOSS_FRAC)) {
        errors.push({
          code: "DAILY_LOSS_LIMIT_IMPLAUSIBLE",
          detail: `max_daily_loss_pct=${settings.max_daily_loss_pct} -> ${f} of equity per day; refusing.`,
        });
      } else if (f.lt(dailyLoss)) {
        dailyLoss = f;
        evidence.source.daily_loss_limit_frac = "TRADING_SETTINGS_STRICTER";
      } else {
        evidence.source.daily_loss_limit_frac = "PROTECTIVE_DEFAULT_CAPS_SETTINGS";
      }
    } catch (e) {
      errors.push({ code: e.code ?? "RISK_SETTING_INVALID", detail: e.detail ?? String(e) });
    }
  }

  // Weekly loss limit.
  let weeklyLoss = dec(defaults.weekly_loss_limit_frac);
  evidence.source.weekly_loss_limit_frac = "PROTECTIVE_DEFAULT";
  if (settings.max_weekly_loss_pct !== null && settings.max_weekly_loss_pct !== undefined) {
    try {
      const f = pctToFrac(settings.max_weekly_loss_pct, "max_weekly_loss_pct");
      if (f.lt(weeklyLoss)) {
        weeklyLoss = f;
        evidence.source.weekly_loss_limit_frac = "TRADING_SETTINGS_STRICTER";
      } else {
        evidence.source.weekly_loss_limit_frac = "PROTECTIVE_DEFAULT_CAPS_SETTINGS";
      }
    } catch (e) {
      errors.push({ code: e.code ?? "RISK_SETTING_INVALID", detail: e.detail ?? String(e) });
    }
  }

  // Concurrency: the DB may only tighten.
  let maxPositions = defaults.max_concurrent_positions;
  evidence.source.max_concurrent_positions = "PROTECTIVE_DEFAULT";
  for (const field of ["max_open_positions_per_exchange", "max_open_positions"]) {
    const raw = settings[field];
    if (raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      errors.push({ code: "MAX_POSITIONS_INVALID", detail: `${field}=${raw}` });
      continue;
    }
    if (n < maxPositions) {
      maxPositions = n;
      evidence.source.max_concurrent_positions = `${field}_STRICTER`;
    }
  }

  // Consecutive losses: the DB may only tighten.  The live row currently holds
  // 1000000, which is "no limit"; the default of 3 stands.
  let maxLosses = defaults.max_consecutive_losses;
  evidence.source.max_consecutive_losses = "PROTECTIVE_DEFAULT";
  if (settings.max_consecutive_losses !== null && settings.max_consecutive_losses !== undefined) {
    const n = Number(settings.max_consecutive_losses);
    if (!Number.isInteger(n) || n < 1) {
      errors.push({ code: "MAX_CONSECUTIVE_LOSSES_INVALID", detail: String(settings.max_consecutive_losses) });
    } else if (n < maxLosses) {
      maxLosses = n;
      evidence.source.max_consecutive_losses = "TRADING_SETTINGS_STRICTER";
    }
  }

  const policy = Object.freeze({
    version: RISK_POLICY_VERSION,
    riskPerTradeFrac: riskPerTrade,
    maxTotalOpenRiskFrac: dec(defaults.max_total_open_risk_frac),
    maxGrossNotionalToEquity: dec(defaults.max_gross_notional_to_equity),
    maxConcurrentPositions: maxPositions,
    dailyLossLimitFrac: dailyLoss,
    weeklyLossLimitFrac: weeklyLoss,
    recoveryHighWaterDrawdownFrac: dec(defaults.recovery_high_water_drawdown_frac),
    maxConsecutiveLosses: maxLosses,
  });

  return { ok: errors.length === 0, errors, policy: errors.length === 0 ? policy : null, evidence };
}

/**
 * Loss-limit state evaluated against a common basis.
 *
 * `realizedToday`/`realizedThisWeek` are signed net results (fees and funding
 * already inside, deposits/withdrawals already removed).  `openRisk` is the
 * additional loss still possible on open positions if every stop fills at its
 * planned adverse price.  The two are deliberately NOT added together when
 * testing the limit: equity already reflects realised losses, so the check is
 *   remaining budget = limit - realised loss
 * and open risk is charged against `maxTotalOpenRiskFrac` separately.  Adding
 * both to one budget double-counts, which section 6 names explicitly.
 */
/** @param {any} args @returns {any} */
export function evaluateLossLimits({
  policy,
  equity,
  realizedToday,
  realizedThisWeek,
  highWaterEquity,
  consecutiveLosses,
}) {
  const E = dec(equity);
  const blocks = [];
  if (!E.isPos()) {
    blocks.push({ code: "EQUITY_NOT_POSITIVE", detail: E.toString() });
    return { allowed: false, blocks, dailyRemaining: ZERO, weeklyRemaining: ZERO };
  }

  const dayLimit = E.mul(policy.dailyLossLimitFrac);
  const weekLimit = E.mul(policy.weeklyLossLimitFrac);
  const dayLoss = dec(realizedToday).isNeg() ? dec(realizedToday).abs() : ZERO;
  const weekLoss = dec(realizedThisWeek).isNeg() ? dec(realizedThisWeek).abs() : ZERO;

  const dailyRemaining = dayLimit.sub(dayLoss).max(ZERO);
  const weeklyRemaining = weekLimit.sub(weekLoss).max(ZERO);

  if (dayLoss.gte(dayLimit)) {
    blocks.push({ code: "DAILY_LOSS_LIMIT_REACHED", detail: `${dayLoss}/${dayLimit}` });
  }
  if (weekLoss.gte(weekLimit)) {
    blocks.push({ code: "WEEKLY_LOSS_LIMIT_REACHED", detail: `${weekLoss}/${weekLimit}` });
  }
  if (highWaterEquity !== null && highWaterEquity !== undefined) {
    const hw = dec(highWaterEquity);
    if (hw.isPos()) {
      const dd = hw.sub(E).div(hw);
      if (dd.gte(policy.recoveryHighWaterDrawdownFrac)) {
        blocks.push({
          code: "HIGH_WATER_DRAWDOWN_REACHED",
          detail: `${dd}/${policy.recoveryHighWaterDrawdownFrac}`,
        });
      }
    }
  }
  const streak = Number(consecutiveLosses ?? 0);
  if (Number.isInteger(streak) && streak >= policy.maxConsecutiveLosses) {
    blocks.push({
      code: "CONSECUTIVE_LOSS_LIMIT_REACHED",
      detail: `${streak}/${policy.maxConsecutiveLosses}`,
    });
  }

  return { allowed: blocks.length === 0, blocks, dailyRemaining, weeklyRemaining };
}
