# Venue-native position metrics hotfix — 2026-08-21

## Problem

The open-position dashboard used one spot-style formula for every venue. That made Binance USDⓈ-M Futures cards diverge from the Binance app because the dashboard used snapshot/ticker price and notional-cost return while Binance displays mark-price unrealized PNL and margin ROI.

## Trading-engine invariant

No P10 exit-policy behavior was changed by this hotfix. The live P10 monitor already routes by `position.exchange`, obtains the venue quote through `marketQuote(exchange, market)`, and uses executable-side pricing: LONG = best bid, SHORT = best ask. Completed 1h bars are also venue native: Upbit candles, Binance Spot klines, and Binance Futures klines.

This distinction is intentional:

- exchange PNL/ROI display = venue-native accounting mark
- exit decision = executable order-book price plus venue-native strategy bars

Using futures mark price itself as the order-exit trigger would be less accurate because it is not necessarily executable.

## Dashboard/source change

`trading-entry-status` revision `5-VENUE-NATIVE-OPEN-POSITION-METRICS` now selects the metric source automatically by venue:

- Upbit spot: current/exit estimate uses Upbit best bid; PNL is cost return after paid-fee share and estimated Upbit exit fee.
- Binance Spot: current/exit estimate uses Binance Spot best bid; PNL is cost return after paid-fee share and estimated spot exit fee.
- Binance USDⓈ-M Futures: displayed current price is Binance mark price; unrealized PNL is mark-to-entry PNL; ROI is unrealized PNL divided by mark-notional initial margin; executable exit price remains Futures best bid for LONG and best ask for SHORT.

The response exposes `pricing_basis`, `pnl_basis`, `return_basis`, `exit_price_basis`, `executable_exit_price`, `leverage`, `position_side`, and `initial_margin_quote` for diagnostics.

## Fail-safe

If a public venue price request fails or times out, the read-only dashboard falls back to the latest account snapshot. The dashboard path cannot submit, change, or cancel orders and does not alter the live P10 monitor.

## Deployment

Supabase `trading-entry-status` production version 33 was deployed active with the existing custom-token authentication model. Source commit: `03f9c0d62976e3ae31faa2415cb0f4c2256b096a`.
