/** Rolling-window PnL change decomposition (R181 follow-up, 2026-09-26).
 *
 * A rolling "24h PnL" moves for three unrelated reasons, and reporting only the net move
 * misreads all three (R181: the 24h figure fell by 3.34 because profitable trades aged out of
 * the window, not because anything new lost money):
 *   A. new closed trades   -- closed inside the current window, not in the previous report;
 *   B. aged-out trades     -- in the previous window, now older than the window start;
 *   C. accounting changes  -- the same trade, reported twice with a different net
 *                             (fee/funding reconciliation, late fills).
 * delta = new - agedOut + adjustment, exactly (asserted).
 *
 * Trades are {id, closedAt(ms), net}. Pure: no I/O, no clock.
 */
const round = (x) => Math.round(x * 1e8) / 1e8;
export function windowTrades(trades, asOfMs, windowMs) {
  return trades.filter((t) => t.closedAt > asOfMs - windowMs && t.closedAt <= asOfMs);
}
export function decomposeWindowChange({ previous, current, prevAsOfMs, asOfMs, windowMs }) {
  if (![prevAsOfMs, asOfMs, windowMs].every(Number.isFinite) || asOfMs < prevAsOfMs || windowMs <= 0)
    throw Error("PNL_WINDOW_INPUT_INVALID");
  const prevIn = new Map(windowTrades(previous, prevAsOfMs, windowMs).map((t) => [String(t.id), t]));
  const currIn = new Map(windowTrades(current, asOfMs, windowMs).map((t) => [String(t.id), t]));
  const sum = (xs) => xs.reduce((a, t) => a + Number(t.net), 0);
  const added = [...currIn.values()].filter((t) => !prevIn.has(String(t.id)));
  const agedOut = [...prevIn.values()].filter((t) => !currIn.has(String(t.id)));
  const adjusted = [...currIn.values()].filter((t) => prevIn.has(String(t.id)) && Number(prevIn.get(String(t.id)).net) !== Number(t.net))
    .map((t) => ({ id: t.id, before: Number(prevIn.get(String(t.id)).net), after: Number(t.net), change: round(Number(t.net) - Number(prevIn.get(String(t.id)).net)) }));
  const prevTotal = round(sum([...prevIn.values()])), currTotal = round(sum([...currIn.values()]));
  const out = {
    windowMs, previousTotal: prevTotal, currentTotal: currTotal, delta: round(currTotal - prevTotal),
    newClosed: { count: added.length, net: round(sum(added)), ids: added.map((t) => t.id) },
    agedOut: { count: agedOut.length, net: round(sum(agedOut)), ids: agedOut.map((t) => t.id) },
    adjustment: { count: adjusted.length, net: round(adjusted.reduce((a, x) => a + x.change, 0)), trades: adjusted },
  };
  const recomposed = round(out.newClosed.net - out.agedOut.net + out.adjustment.net);
  if (Math.abs(recomposed - out.delta) > 1e-6) throw Error(`PNL_WINDOW_DECOMPOSITION_MISMATCH:${recomposed}:${out.delta}`);
  return out;
}
/** Profit factor and max drawdown of a closed-trade sequence, in close order. */
export function tradeStats(trades) {
  const xs = [...trades].sort((a, b) => a.closedAt - b.closedAt).map((t) => Number(t.net));
  const gains = xs.filter((x) => x > 0).reduce((a, x) => a + x, 0), losses = -xs.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  let eq = 0, peak = 0, mdd = 0;
  for (const x of xs) { eq += x; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
  return { trades: xs.length, net: round(xs.reduce((a, x) => a + x, 0)), grossProfit: round(gains), grossLoss: round(losses),
    profitFactor: losses > 0 ? round(gains / losses) : (gains > 0 ? Infinity : null), maxDrawdown: round(mdd),
    wins: xs.filter((x) => x > 0).length };
}
