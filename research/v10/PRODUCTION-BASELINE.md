# V10 production baseline freeze

Read-only production snapshot at 2026-08-30 03:22-03:36 UTC, before the V10 cutover.

## Existing P10 live outcomes

Only closed, non-paper `P10_DONCHIAN_BREAKOUT_E10_SLOW_4R` positions are included.

| Venue | Side | Trades | Wins | Net quote P&L | Mean realized return | Worst | Best |
|---|---:|---:|---:|---:|---:|---:|---:|
| Binance spot | LONG | 3 | 3 | +8.456463 | +7.129049% | +0.355972% | +14.077364% |
| Binance futures | LONG | 41 | 17 | +354.462306 | +5.852108% | -14.017055% | +45.258540% |
| Binance futures | SHORT | 10 | 3 | -11.183806 | -1.853256% | -11.073795% | +16.443501% |

Combined LONG: 44 trades, 20 wins, +362.918769 quote P&L. Chronological closed-trade
LONG maximum drawdown was -57.111290 quote. All observations are from August 2026;
this is execution evidence, not an independent research backtest. It supports preserving
the existing LONG lane and rejects treating the existing SHORT lane as proven edge.

## Pre-cutover drift and safety state

- Git source intended the V3 BULL lane, but the live `claim_p10_signal()` called a DB V3
  resolver whose body had been overwritten to block BULL.
- `p10_entry_suspension` id 1 was active from 2026-08-30 02:29:10.746581 UTC with the
  exact V5-wide-research reason allowlisted in the V10 migration.
- The suspension table had RLS disabled and anonymous/authenticated table privileges;
  resolver V4 was publicly executable.
- The claim function retained a LONG fail-open on resolver exceptions. A downstream
  `BEFORE INSERT` order trigger happened to block new OPEN orders.
- There were zero open positions. Mode was `LIVE_LIMITED`; pause and emergency flags
  were false; futures sizing remained 40 USDT margin at 3x; scan/monitor heartbeats
  were current.
- Current Edge revisions were market-autotrader v404, market-v2-signal v43, and
  market-regime-observer v51.

V10 therefore treats the intended baseline as existing BULL LONG plus CASH elsewhere,
while separately repairing the live DB drift. It does not infer RANGE/BEAR alpha from
the operational outage.
