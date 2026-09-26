/** Pure account evidence validation. No order, position-adoption or control operations. */
export const REVISION = "ACCOUNT-OBSERVABILITY-1.0.0";
export const POSITION_REVISION = "1-DIRECTIONAL-FUTURES-POSITIONS";
export type Row = Record<string, any>;
export function requiredNumber(value: unknown, field: string, min = -Infinity): number {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") throw new Error(`MISSING_NUMBER:${field}`);
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`BAD_NUMBER:${field}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`BAD_NUMBER:${field}`);
  return n;
}
export function validatePortfolio(raw: Row): Row[] {
  if (!raw || raw.exchange !== "binance_futures" || raw.quote_currency !== "USDT") throw new Error("PORTFOLIO_VENUE_MISMATCH");
  for (const f of ["total_equity_quote", "available_quote", "locked_quote", "total_initial_margin_quote"]) requiredNumber(raw[f], f, f === "total_equity_quote" ? -Infinity : 0);
  if (!Array.isArray(raw.positions) || !Array.isArray(raw.accounts)) throw new Error("INCOMPLETE_PORTFOLIO");
  const keys = new Set<string>();
  return raw.positions.map((p: Row) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("BAD_POSITION");
    const market = String(p.market || "").toUpperCase(), side = String(p.side || "").toUpperCase(), key = `${market}:${side}`;
    if (!/^[A-Z0-9]{1,24}USDT$/.test(market) || !["LONG", "SHORT"].includes(side) || keys.has(key)) throw new Error("BAD_OR_DUPLICATE_POSITION");
    keys.add(key);
    const quantity = requiredNumber(p.quantity, "quantity", Number.MIN_VALUE);
    const entry = requiredNumber(p.entry_price, "entry_price", Number.MIN_VALUE);
    const leverage = requiredNumber(p.leverage, "leverage", Number.MIN_VALUE);
    const margin = requiredNumber(p.initial_margin_quote, "initial_margin_quote", 0);
    const pnl = requiredNumber(p.unrealized_pnl_quote, "unrealized_pnl_quote");
    return {...p, market, side, quantity, entry_price: entry, leverage, initial_margin_quote: margin, unrealized_pnl_quote: pnl};
  });
}
export function snapshotEvidence(raw: Row, settings: Row, tracked: Row[], capturedAt: string) {
  const positions = validatePortfolio(raw);
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("CAPTURE_TIME_REQUIRED");
  const byKey = new Map<string, number>();
  for (const p of tracked) {
    const market = String(p.market ?? p.symbol ?? "").toUpperCase(), side = String(p.position_side ?? p.side ?? "LONG").toUpperCase();
    const quantity = requiredNumber(p.remaining_quantity ?? p.quantity, "tracked_quantity", 0);
    if (!market || !["LONG", "SHORT"].includes(side)) throw new Error("BAD_TRACKED_POSITION");
    const key = `${market}:${side}`;
    byKey.set(key, (byKey.get(key) || 0) + quantity);
  }
  const matches = (p: Row) => {
    const expected = byKey.get(`${p.market}:${p.side}`);
    return expected !== undefined && Math.abs(expected-p.quantity) <= Math.max(1e-10,p.quantity*1e-8);
  };
  const unmatched = positions.filter(p => !matches(p)), known = positions.filter(matches);
  const equity = requiredNumber(raw.total_equity_quote, "equity"), available = requiredNumber(raw.available_quote, "available", 0);
  const locked = requiredNumber(raw.locked_quote, "locked", 0), used = requiredNumber(raw.total_initial_margin_quote, "initial_margin", 0);
  const capital = Math.max(0, equity), mode = settings.binance_futures_allocation_mode;
  if (mode !== "ALL" && mode !== "FIXED") throw new Error("ALLOCATION_MODE_REQUIRED");
  const reserve = Math.min(capital, requiredNumber(settings.binance_futures_reserve_usdt, "reserve", 0)), usable = Math.max(0, capital-reserve);
  const managed = mode === "FIXED" ? Math.min(usable,requiredNumber(settings.binance_futures_allocation_usdt, "fixed_allocation", 0)) : usable;
  // All authenticated exposure, including unowned contracts, consumes capacity.
  // Observation never marks it as a bot position or releases a trading circuit.
  const managedAvailable = Math.min(available, Math.max(0,managed-used));
  return {
    snapshot: {
      exchange: "binance_futures", quote_currency: "USDT", captured_at: capturedAt,
      total_equity_quote: equity, available_quote: available, locked_quote: locked,
      bot_open_cost_quote: known.reduce((s,p)=>s+p.initial_margin_quote,0),
      bot_unrealized_pnl_quote: known.reduce((s,p)=>s+p.unrealized_pnl_quote,0),
      capital_base_quote: capital, managed_capital_quote: managed,
      managed_available_quote: managedAvailable, protected_reserve_quote: reserve,
      allocation_mode: mode, balances: raw.accounts, positions,
      positions_complete: true, positions_revision: POSITION_REVISION,
      prices: raw.prices && typeof raw.prices === "object" ? raw.prices : {},
      source: "STATIC_IP_GATEWAY_ACCOUNT_OBSERVABILITY_V1",
    },
    unmatched_positions: unmatched,
    db_positions_missing_on_exchange: [...byKey.keys()].filter(k => !positions.some(p=>`${p.market}:${p.side}`===k)),
  };
}
