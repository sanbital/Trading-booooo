/**
 * V17 slot sizing contract -- the single authoritative definition of how one
 * entry slot is turned into a quantity and an IOC limit price.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this module the slot size lived in four places that drifted apart:
 * the executor's MARGIN constant, trading_settings.binance_futures_allocation_usdt,
 * leader-momentum-v17's POLICY.marginUsdt, and the targetMarginUsdt stamped onto
 * every generated signal. On 2026-09-16 the operator moved the slot from 40 to 30
 * USDT; the executor followed, the policy did not, and generated signals carried
 * targetMarginUsdt=40 while the executor sized 30. The code half of that split is
 * closed here: every module reads THIS contract. The DB half stays a fail-closed
 * runtime comparison (V17_MARGIN_CONFIG_MISMATCH) so a live settings row can never
 * silently resize an order.
 *
 * THE UNIT BUG THIS REPLACES
 * --------------------------
 * The old sizing mixed an ABSOLUTE rounding buffer with a RELATIVE price cap:
 * quantity was ceiled to the target notional, and the shortfall to
 * `NOTIONAL + 0.12 USDT` was then made up by RAISING the limit price, capped at
 * IOC_MAX_BPS = 12. The uplift that buffer demands is
 *
 *     requiredUpliftBps = NOTIONAL_BUFFER_USDT / sizedNotional * 10_000
 *
 * which at the worst case (sizedNotional == targetNotional) is
 * NOTIONAL_BUFFER_USDT / targetNotional * 10_000. At a 120 USDT notional that is
 * 0.12/120 = 10 bps, inside the 12 bps cap, so the gate never fired. At a 90 USDT
 * notional it is 0.12/90 = 13.33 bps -- ABOVE the cap. Changing only the margin
 * therefore created a band of perfectly ordinary fills that the executor refused
 * with ENTRY_GRANULARITY_BPS, by arithmetic, regardless of the market.
 *
 * The contract below removes the coupling instead of re-tuning it:
 *   - the rounding headroom is RELATIVE (bps of the target notional), so its
 *     meaning survives a slot change;
 *   - it is satisfied by QUANTITY, never by inflating the price, so no sizing
 *     decision can ever demand a price uplift and the IOC cap is left to do its
 *     real job -- bounding slippage on a BUY;
 *   - the price is derived from the ask alone and rounded UP to a valid tick,
 *     which is the correct direction for a marketable BUY limit;
 *   - the slot overshoot budget stays an explicit, checked number, so a symbol
 *     whose lot step is genuinely too coarse for the slot is still skipped.
 *
 * INVARIANT (asserted at import, and re-asserted by the release gate):
 * no quantity this module can produce requires a price uplift above iocMaxBps.
 * See assertSlotSizingContract().
 */

/** Identity of the arithmetic below. Bump when the contract's meaning changes. */
export const SLOT_SIZING_CONTRACT_VERSION = "V17_SLOT_SIZING_4_MARGIN150";

/**
 * Production slot contract.
 *
 * targetMarginUsdt / leverage are the operator-agreed slot (200 USDT at 3x,
 * instruction of 2026-09-19; previously 30 USDT at 3x, instruction of
 * 2026-09-16). Every *Usdt field is a USDT amount and every *Bps field is a
 * relative rate in basis points of the target notional; the suffixes are
 * load-bearing, not decoration -- conflating them is the bug above.
 */
export const SLOT_SIZING_CONTRACT = Object.freeze({
  version: SLOT_SIZING_CONTRACT_VERSION,
  targetMarginUsdt: 150,
  leverage: 3,
  /**
   * Quantity-side rounding headroom above the target notional, relative.
   * 10 bps of the target notional. Expressed relatively so this headroom
   * survives a resize instead of drifting into a different fraction of the
   * slot. It is met by buying one more step, never by paying more.
   */
  notionalBufferBps: 10,
  /**
   * How far one slot may exceed its margin allocation because the exchange's lot
   * step does not divide the target notional. 250/3 bps of the target margin,
   * which is the allowance production has run with since the 40 -> 30 cutover.
   * Expressed relatively so an absolute allowance does not silently become a
   * looser or tighter fraction of the slot every time the slot is resized.
   */
  maxSlotOvershootBps: 250 / 3,
  /**
   * How far BELOW the target notional a slot may be filled when the lot step
   * does not divide the target. This is the other half of maxSlotOvershootBps
   * and it exists because the two are not symmetric: overshooting spends margin
   * the operator did not allocate, so it is capped tightly; undershooting spends
   * less and risks less, so the only question it raises is whether the position
   * is still a meaningful slot. 5000 bps = the order must carry at least half
   * the slot. A symbol coarser than that is skipped with its own reason rather
   * than traded at a token size.
   *
   * Under the CURRENT overshoot budget this floor is provably slack, and that is
   * deliberate rather than accidental: the largest affordable multiple k satisfies
   * (k+1) x limit > maxNotional, so k x limit > maxNotional - limit; when
   * limit <= maxNotional/2 that already exceeds half the slot, and when
   * limit > maxNotional/2 then k = 1 and the single lot exceeds half by itself. So
   * nothing this contract admits today can hit the floor. It is here so that
   * widening maxSlotOvershootBps -- which does make thin lattice points reachable --
   * cannot silently start opening token-size positions.
   */
  minSlotFillBps: 5_000,
  /** Marketability uplift applied to the ask for a BUY IOC. */
  iocBaseBps: 3,
  /** Hard ceiling on how far above the ask a BUY IOC may be priced. */
  iocMaxBps: 12,
});

/** Distinct, non-overlapping reasons a slot cannot be sized. One cause each. */
export const SLOT_SIZING_REASON = Object.freeze({
  INPUT_INVALID: "QTY_INPUT_INVALID",
  /** The exchange's own minimum order already costs more margin than the slot has. */
  MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET: "MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET",
  /** The lot step is too coarse: ONE lot already costs more margin than the slot has. */
  QTY_STEP_EXCEEDS_MARGIN_BUDGET: "QTY_STEP_EXCEEDS_MARGIN_BUDGET",
  /**
   * A lot-aligned quantity fits the budget, but the largest one that does is a
   * smaller fraction of the slot than minSlotFillBps allows. Distinct from the
   * two above: nothing about the exchange forbids this order, the slot geometry
   * does, and the operator answer is a different slot size, not a different symbol.
   */
  SLOT_FILL_BELOW_FLOOR: "QTY_STEP_BELOW_SLOT_FLOOR",
  /** Tick rounding alone would price the BUY further above the ask than allowed. */
  IOC_PRICE_CAP_EXCEEDED: "IOC_PRICE_CAP_EXCEEDED",
});

export class SlotSizingError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "SlotSizingError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

const EPS = 1e-9;
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};

/** Decimal places a step/tick needs so binary rounding noise never crosses it. */
export function stepDecimals(step) {
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
}

/** Largest multiple of `step` at or below `value`. Quantity rounding, SELL side. */
export function floorStep(value, step) {
  if (!(value > 0 && step > 0)) return 0;
  return Number((Math.floor((value + step * 1e-9) / step) * step).toFixed(stepDecimals(step)));
}

/** Smallest multiple of `step` at or above `value`. Quantity rounding, BUY side. */
export function ceilStep(value, step) {
  if (!(value > 0 && step > 0)) return 0;
  return Number((Math.ceil((value - step * 1e-9) / step) * step).toFixed(stepDecimals(step)));
}

/**
 * Price rounding, deliberately a separate function from quantity rounding even
 * though the arithmetic rhymes: a tick and a lot step are different filters and
 * conflating them is how precision bugs start. UP is the correct direction for a
 * BUY limit -- it keeps the order marketable; rounding down could leave it
 * resting behind the ask. The uplift it costs is bounded by the IOC cap below.
 */
export function ceilTick(price, tick) {
  if (!(price > 0)) return 0;
  if (!(tick > 0)) return price;
  return Number((Math.ceil((price - tick * 1e-9) / tick) * tick).toFixed(stepDecimals(tick)));
}

/** Derived USDT amounts for a contract. Kept in one place so nothing recomputes them. */
export function slotSizingBounds(contract = SLOT_SIZING_CONTRACT) {
  const targetNotionalUsdt = contract.targetMarginUsdt * contract.leverage;
  return Object.freeze({
    targetNotionalUsdt,
    /** The notional a quantity AIMS at. Reaching it is preferred, not required. */
    requiredNotionalUsdt: targetNotionalUsdt * (1 + contract.notionalBufferBps / 10_000),
    /** The order, priced at its own limit, may not need more margin than this. */
    maxOrderMarginUsdt: contract.targetMarginUsdt * (1 + contract.maxSlotOvershootBps / 10_000),
    /** Below this notional at the ask the order is not a slot any more. */
    minOrderNotionalUsdt: targetNotionalUsdt * (contract.minSlotFillBps / 10_000),
  });
}

/**
 * The structural invariant that the 40 -> 30 cutover violated.
 *
 * Under this contract the limit price is a pure function of the ask, the base
 * uplift and the tick -- sizing never asks the price to make up a notional
 * shortfall -- so the uplift a SIZING decision can demand is exactly zero bps
 * and the budget left for tick rounding is the whole cap above the base uplift.
 * The old design is representable here only as a violation, which is the point:
 * the release gate calls this and refuses a deploy that reintroduces it.
 *
 * Returns the checks so a caller can report them; throws on violation.
 */
export function assertSlotSizingContract(contract = SLOT_SIZING_CONTRACT) {
  const bounds = slotSizingBounds(contract);
  const checks = [];
  const require = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) throw new SlotSizingError("SLOT_SIZING_CONTRACT_INVALID", `${name}:${detail}`);
  };
  require(
    "POSITIVE_SLOT",
    contract.targetMarginUsdt > 0 && contract.leverage > 0,
    `${contract.targetMarginUsdt}@${contract.leverage}x`,
  );
  require(
    "BASE_UPLIFT_WITHIN_CAP",
    contract.iocBaseBps >= 0 && contract.iocBaseBps <= contract.iocMaxBps,
    `${contract.iocBaseBps}<=${contract.iocMaxBps}`,
  );
  // The buffer is met by quantity, so it costs 0 bps of price. Asserting it
  // against the cap anyway is what makes a regression back to a price-funded
  // buffer -- absolute or relative -- fail here instead of in production.
  require(
    "NOTIONAL_BUFFER_COSTS_NO_PRICE_UPLIFT",
    sizingPriceUpliftBps(contract) === 0,
    `${sizingPriceUpliftBps(contract)}bps`,
  );
  require(
    "BUFFER_WITHIN_OVERSHOOT_BUDGET",
    bounds.requiredNotionalUsdt / contract.leverage <= bounds.maxOrderMarginUsdt + EPS,
    `${(bounds.requiredNotionalUsdt / contract.leverage).toFixed(6)}<=` +
      `${bounds.maxOrderMarginUsdt.toFixed(6)}`,
  );
  // Headroom for the base uplift on top of the buffer, or every fine-step symbol
  // would be admitted by quantity and then refused on margin at its own price.
  // A floor at or above the target would make the admissible band empty for every
  // symbol whose step does not divide the target exactly -- the opposite of what
  // the floor is for. A floor of zero would let a slot be filled at a token size.
  require(
    "SLOT_FILL_FLOOR_LEAVES_A_BAND",
    contract.minSlotFillBps > 0 && contract.minSlotFillBps < 10_000,
    `${contract.minSlotFillBps}`,
  );
  require(
    "OVERSHOOT_ABSORBS_BUFFER_AND_BASE_UPLIFT",
    bounds.requiredNotionalUsdt * (1 + contract.iocBaseBps / 10_000) / contract.leverage <=
      bounds.maxOrderMarginUsdt + EPS,
    `${contract.notionalBufferBps}+${contract.iocBaseBps}<=${contract.maxSlotOvershootBps}`,
  );
  return checks;
}

/**
 * Price uplift, in bps of the ask, that SIZING demands of the limit price.
 * Zero by construction under this contract; the function exists so the release
 * gate can assert that rather than assume it.
 */
export function sizingPriceUpliftBps(_contract = SLOT_SIZING_CONTRACT) {
  return 0;
}

/**
 * The best quantity this slot can buy, or a single specific reason why none exists.
 *
 * WHY THIS IS A LATTICE SEARCH AND NOT A FORMULA
 * ----------------------------------------------
 * The admissible quantities are the multiples of the exchange's lot step, and the
 * slot defines a band on them: at least the exchange's own minimums, at most the
 * margin ceiling, aiming at the target notional. The previous implementation only
 * ever evaluated ONE point on that lattice -- ceil(target / ask) -- and refused the
 * whole symbol when that single point sat above the ceiling. That is a false
 * refusal whenever a smaller multiple is admissible, which is the ordinary case for
 * any symbol whose step is a meaningful fraction of the slot:
 *
 *     UNIUSDT, 2026-09-18 03:17 UTC. ask 8.916, step 1, slot 30 USDT at 3x.
 *     ceil(90.09 / 8.916) = 11 -> 11 x 8.919 / 3 = 32.70 USDT > 30.25 ceiling.
 *     REFUSED as QTY_STEP_EXCEEDS_MARGIN_BUDGET -- while qty 10 costs 29.73 USDT,
 *     satisfies every exchange filter, and is 99.1% of the slot.
 *
 * So the search walks DOWN from the target to the largest admissible multiple. It
 * never walks up: the margin ceiling is the operator's allocation and is enforced
 * at the order's own limit price, which is the worst case for a BUY IOC because
 * every lot could fill at the cap.
 *
 * `ask` is the executable reference price; the target notional is measured against
 * it. The exchange's min-notional filter is measured against the ORDER's own price,
 * which is what the exchange validates.
 */
export function planSlotEntry(input, contract = SLOT_SIZING_CONTRACT) {
  const ask = num(input?.ask),
    quantityStep = num(input?.quantityStep),
    priceTick = input?.priceTick == null ? 0 : num(input.priceTick),
    minNotionalUsdt = input?.minNotionalUsdt == null ? 0 : num(input.minNotionalUsdt),
    minQuantity = input?.minQuantity == null ? 0 : num(input.minQuantity);
  if (!(ask > 0) || !(quantityStep > 0) || !Number.isFinite(priceTick) || priceTick < 0 ||
      !Number.isFinite(minNotionalUsdt) || minNotionalUsdt < 0 ||
      !Number.isFinite(minQuantity) || minQuantity < 0) {
    throw new SlotSizingError(SLOT_SIZING_REASON.INPUT_INVALID);
  }
  const bounds = slotSizingBounds(contract);

  // 1. Price first, and from the ask alone. Nothing about the quantity feeds in.
  const limitPrice = ceilTick(ask * (1 + contract.iocBaseBps / 10_000), priceTick);
  const iocBps = (limitPrice / ask - 1) * 10_000;
  if (iocBps > contract.iocMaxBps + EPS) {
    throw new SlotSizingError(SLOT_SIZING_REASON.IOC_PRICE_CAP_EXCEEDED, iocBps.toFixed(3));
  }

  // 2. The lattice bounds, all expressed as lot-aligned quantities.
  //    LOWER: what the exchange will not go below. UPPER: what the slot will not
  //    go above, charged at the order's own limit. AIM: the target notional.
  const quantityForTarget = ceilStep(bounds.requiredNotionalUsdt / ask, quantityStep);
  const quantityForMinNotional = minNotionalUsdt > 0
    ? ceilStep(minNotionalUsdt / limitPrice, quantityStep)
    : 0;
  const quantityForMinQuantity = minQuantity > 0 ? ceilStep(minQuantity, quantityStep) : 0;
  const exchangeFloor = Math.max(quantityStep, quantityForMinNotional, quantityForMinQuantity);
  const marginCeiling = floorStep(
    bounds.maxOrderMarginUsdt * contract.leverage / limitPrice, quantityStep);

  const detail = (quantity) =>
    `${(quantity * limitPrice / contract.leverage).toFixed(6)}` +
    `:max=${bounds.maxOrderMarginUsdt.toFixed(6)}` +
    `:step=${quantityStep}:qty=${quantity}:px=${limitPrice}`;

  // 3. Three distinct ways the lattice can be empty, never merged into one code:
  //    one lot is unaffordable (a property of the price against the slot), the
  //    exchange's own minimum is unaffordable (a property of the listing), or the
  //    best affordable lot is not a meaningful slot (a property of the geometry).
  //    They need different operator answers.
  if (!(marginCeiling >= quantityStep - EPS)) {
    throw new SlotSizingError(SLOT_SIZING_REASON.QTY_STEP_EXCEEDS_MARGIN_BUDGET,
      detail(quantityStep));
  }
  if (exchangeFloor > marginCeiling + EPS) {
    throw new SlotSizingError(SLOT_SIZING_REASON.MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET,
      detail(exchangeFloor));
  }

  // 4. The best admissible point: as close to the target as the ceiling allows,
  //    never below what the exchange requires.
  const quantity = Math.max(exchangeFloor, Math.min(quantityForTarget, marginCeiling));
  if (!(quantity > 0)) throw new SlotSizingError(SLOT_SIZING_REASON.INPUT_INVALID);

  const referenceNotionalUsdt = quantity * ask;
  if (referenceNotionalUsdt + EPS < bounds.minOrderNotionalUsdt) {
    throw new SlotSizingError(SLOT_SIZING_REASON.SLOT_FILL_BELOW_FLOOR,
      `${detail(quantity)}:notional=${referenceNotionalUsdt.toFixed(6)}` +
      `:floor=${bounds.minOrderNotionalUsdt.toFixed(6)}`);
  }

  const orderNotionalUsdt = quantity * limitPrice,
    orderMarginUsdt = orderNotionalUsdt / contract.leverage;
  // Belt and braces: the ceiling is how `quantity` was derived, so this can only
  // fire on an arithmetic regression. It stays because it is the one invariant a
  // sizing bug must never be able to cross silently.
  if (orderMarginUsdt > bounds.maxOrderMarginUsdt + EPS) {
    throw new SlotSizingError(SLOT_SIZING_REASON.QTY_STEP_EXCEEDS_MARGIN_BUDGET, detail(quantity));
  }

  return {
    contractVersion: contract.version,
    quantity,
    limitPrice,
    iocBps,
    /** Notional and margin at the reference ask. */
    referenceNotionalUsdt,
    referenceMarginUsdt: referenceNotionalUsdt / contract.leverage,
    /** Notional and margin if every lot fills at the limit. The budgeted figures. */
    orderNotionalUsdt,
    orderMarginUsdt,
    targetNotionalUsdt: bounds.targetNotionalUsdt,
    requiredNotionalUsdt: bounds.requiredNotionalUsdt,
    maxOrderMarginUsdt: bounds.maxOrderMarginUsdt,
    minOrderNotionalUsdt: bounds.minOrderNotionalUsdt,
    /** How much of the slot this order actually carries, in bps of the target. */
    slotFillBps: referenceNotionalUsdt / bounds.targetNotionalUsdt * 10_000,
    boundBy: quantity === quantityForMinNotional && quantity > quantityForTarget
      ? "EXCHANGE_MIN_NOTIONAL"
      : quantity === quantityForMinQuantity && quantity > quantityForTarget
      ? "EXCHANGE_MIN_QUANTITY"
      : quantity === quantityForTarget
      ? "TARGET_NOTIONAL"
      : "MARGIN_BUDGET_CAP",
  };
}

// Fail at import rather than at the first order of the day.
assertSlotSizingContract();
