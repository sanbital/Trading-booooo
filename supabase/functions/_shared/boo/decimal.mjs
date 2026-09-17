/**
 * Exact fixed-point decimal arithmetic for order sizing and accounting.
 *
 * Section 3 and section 6 of the brief both forbid hiding residuals behind
 * floating point noise.  The reconciliation this module backs found a
 * -0.000000169999933973 USDT residual across 119 positions that exists ONLY
 * because `realized_pnl_usdt` was written from JavaScript doubles: the stored
 * numbers are the float64 neighbours of the true values, not the true values.
 * Sizing arithmetic must not add more of that, so every quantity/price/notional
 * computation in the entry path goes through this module.
 *
 * Representation: a BigInt numerator over a fixed 10^SCALE denominator.
 * SCALE=18 covers every Binance USDⓈ-M price and quantity filter with room to
 * spare (the smallest tickSize currently listed is 1e-8).
 *
 * Division truncates toward negative infinity for `div` so that repeated
 * floor-to-step operations stay monotone; `mul` is exact before the single
 * rescale, so `mul` never loses a digit that `add` could have kept.
 */

export const SCALE = 18n;
const ONE = 10n ** SCALE;

function pow10(n) {
  return 10n ** BigInt(n);
}

/** Parse a decimal string/number/bigint into scaled BigInt. Throws on junk. */
export function D(value) {
  if (typeof value === "bigint") return value * ONE;
  if (value instanceof Dec) return value.v;
  let s = typeof value === "number"
    // A double cannot represent most decimals exactly.  Going through the
    // shortest round-tripping decimal string (what `String(n)` gives) recovers
    // the decimal the caller almost certainly meant, and refuses the ones that
    // have already lost precision (>=1e21 switches to exponential with no
    // meaningful digits left, NaN/Infinity have none at all).
    ? String(value)
    : String(value ?? "").trim();
  if (s === "") throw new Error("DECIMAL_EMPTY");
  let neg = false;
  if (s[0] === "+") s = s.slice(1);
  else if (s[0] === "-") {
    neg = true;
    s = s.slice(1);
  }
  // Exponential form (1e-8, 2.5E+3) shows up in exchangeInfo filters.
  const e = s.search(/[eE]/);
  let exp = 0;
  if (e >= 0) {
    exp = Number(s.slice(e + 1));
    if (!Number.isInteger(exp)) throw new Error(`DECIMAL_INVALID:${value}`);
    s = s.slice(0, e);
  }
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") {
    throw new Error(`DECIMAL_INVALID:${value}`);
  }
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const fracPart = dot < 0 ? "" : s.slice(dot + 1);
  const shift = Number(SCALE) + exp - fracPart.length;
  if (shift < 0) {
    // More digits than SCALE can hold.  Refuse rather than silently round:
    // a tickSize we cannot represent must not become a tradable price.
    const digits = BigInt(intPart + fracPart);
    const drop = pow10(-shift);
    if (digits % drop !== 0n) throw new Error(`DECIMAL_PRECISION_LOSS:${value}`);
    const v = digits / drop;
    return neg ? -v : v;
  }
  const v = BigInt(intPart + fracPart) * pow10(shift);
  return neg ? -v : v;
}

export class Dec {
  constructor(v) {
    this.v = typeof v === "bigint" ? v : D(v);
  }
  static of(x) {
    return x instanceof Dec ? x : new Dec(D(x));
  }
  add(o) {
    return new Dec(this.v + Dec.of(o).v);
  }
  sub(o) {
    return new Dec(this.v - Dec.of(o).v);
  }
  mul(o) {
    return new Dec(divFloor(this.v * Dec.of(o).v, ONE));
  }
  div(o) {
    const d = Dec.of(o).v;
    if (d === 0n) throw new Error("DECIMAL_DIV_ZERO");
    return new Dec(divFloor(this.v * ONE, d));
  }
  neg() {
    return new Dec(-this.v);
  }
  abs() {
    return new Dec(this.v < 0n ? -this.v : this.v);
  }
  cmp(o) {
    const b = Dec.of(o).v;
    return this.v < b ? -1 : this.v > b ? 1 : 0;
  }
  lt(o) {
    return this.cmp(o) < 0;
  }
  lte(o) {
    return this.cmp(o) <= 0;
  }
  gt(o) {
    return this.cmp(o) > 0;
  }
  gte(o) {
    return this.cmp(o) >= 0;
  }
  eq(o) {
    return this.cmp(o) === 0;
  }
  isZero() {
    return this.v === 0n;
  }
  isNeg() {
    return this.v < 0n;
  }
  isPos() {
    return this.v > 0n;
  }
  min(o) {
    return this.lte(o) ? this : Dec.of(o);
  }
  max(o) {
    return this.gte(o) ? this : Dec.of(o);
  }
  /** Largest multiple of `step` that is <= this. Used for stepSize/quantity. */
  floorStep(step) {
    const s = Dec.of(step).v;
    if (s <= 0n) throw new Error("DECIMAL_STEP_INVALID");
    return new Dec(divFloor(this.v, s) * s);
  }
  /** Smallest multiple of `step` that is >= this. Used for stop alignment. */
  ceilStep(step) {
    const s = Dec.of(step).v;
    if (s <= 0n) throw new Error("DECIMAL_STEP_INVALID");
    return new Dec(-divFloor(-this.v, s) * s);
  }
  /** Exact decimal string, no exponent, no trailing-zero padding beyond need. */
  toString() {
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    const i = a / ONE;
    const f = (a % ONE).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${i}${f ? `.${f}` : ""}`;
  }
  /** Fixed-width decimal string, truncating (never rounding up) at `dp`. */
  toFixed(dp) {
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    const drop = pow10(Number(SCALE) - dp);
    const t = (a / drop) * drop;
    const i = t / ONE;
    const f = (t % ONE).toString().padStart(Number(SCALE), "0").slice(0, dp);
    return `${neg ? "-" : ""}${i}${dp > 0 ? `.${f}` : ""}`;
  }
  /**
   * Lossy escape hatch for logging and for payloads that must be JSON numbers.
   * Never feed the result back into sizing -- that is the bug this class exists
   * to prevent -- and never use it for a comparison against a limit.
   */
  toNumber() {
    return Number(this.toString());
  }
  toJSON() {
    return this.toString();
  }
}

function divFloor(a, b) {
  const q = a / b;
  // BigInt division truncates toward zero; correct it to floor.
  return (a % b !== 0n && ((a < 0n) !== (b < 0n))) ? q - 1n : q;
}

export const dec = (x) => Dec.of(x);
export const ZERO = new Dec(0n);

/** True when `x` parses as a finite decimal. Used to reject unreadable config. */
export function isDecimal(x) {
  try {
    D(x);
    return true;
  } catch {
    return false;
  }
}

/** Sum a list exactly. Empty sum is zero. */
export function sum(xs) {
  let t = 0n;
  for (const x of xs) t += Dec.of(x).v;
  return new Dec(t);
}

/**
 * Number of decimal places implied by a step, for exchange payload formatting.
 * Reads the step itself -- never pricePrecision/quantityPrecision, which
 * section 7 forbids as a substitute for the filter value.
 */
export function stepDecimals(step) {
  const s = Dec.of(step).toString();
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}
