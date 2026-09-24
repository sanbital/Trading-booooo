# GPT FINAL RECHECK — threshold calibration (2026-09-24)

Data (all order-free, stored in `public.fd1_recheck_research`, derived rows in `replay_tape_rows.json` / `replay_derived.json`):

- **Replay triggers:** the 123 FD1 16-day replay ENTRY triggers that fall inside Binance's 2-day aggTrades window. 113 of them have a usable tape; 76 are GPT BUYs with at least 20 trades in the window.
- **Tape:** `/fapi/v1/aggTrades` over [snapshot, snapshot+11 s). Production E1 runs about 10 s after the GPT snapshot (NIL 10.7 s, FF 9.8 s, NOM 10.0 s). The initial price is the last trade in the first second; the pre-dispatch window is [+1 s, +11 s).
- **Forward path:** 1m klines for 60 minutes from the dispatch price.
- **Production E1:** 132 E1 observations, 2026-09-18 to 09-24.

## Change distributions over the ~10 s decision-to-dispatch horizon

| metric | p5 | p10 | p20 | p25 | p50 | p75 | p90 | p95 |
|---|---|---|---|---|---|---|---|---|
| price change since snapshot | −0.46% | −0.35% | −0.28% | −0.17% | −0.05% | +0.14% | +0.28% | +0.43% |
| 10 s tape return (replay) | −0.45% | −0.34% | −0.26% | −0.19% | −0.04% | +0.13% | +0.27% | +0.43% |
| 10 s tape return (prod E1) | −0.62% | −0.48% | — | −0.18% | −0.02% | +0.12% | +0.23% | +0.29% |
| 10 s taker-buy share (replay) | 0.24 | 0.30 | 0.38 | 0.41 | 0.52 | 0.63 | 0.77 | 0.84 |
| 10 s taker-buy share (prod E1) | 0.20 | 0.27 | — | 0.39 | 0.49 | 0.59 | 0.71 | 0.76 |
| share − initial 5m share | −0.34 | −0.25 | −0.16 | −0.14 | −0.00 | +0.12 | +0.24 | +0.33 |

## Trigger bands

"Meaningful" means outside the normal band of change over the same horizon. Each threshold is the adverse ~20% tail, rounded toward more rechecks:

- **PRICE_ADVERSE:** price change ≤ −0.25%.
- **PRICE_CHASE:** price change ≥ +0.5% (about p97). This is a trigger only; it can never be a SKIP reason on its own.
- **TAPE_RETURN_ADVERSE:** tape return ≤ −0.25%.
- **BUY_SHARE_LOW:** buy share ≤ 0.40.
- **BUY_SHARE_DROP:** change in buy share ≤ −0.15.
- **TAPE_FLOW_REVERSED:** tape return < 0 AND buy share < 0.5. These are FD1's own published support directions (`return_* > 0`, `taker_buy_ratio_* > 0.5`), both reversed on the latest tape. It is a sign rule, not a fitted value.
- **Noise floor:** tape triggers need at least 20 trades in the window (p5 of trade counts).
- **Book (no history):** the book cannot be replayed, so these are conservative relative moves:
  - spread +5 bps and ≥2×;
  - ask/bid depth −50%;
  - imbalance −0.30;
  - estimated slippage +5 bps;
  - any FD1 book band (SPREAD_ABNORMAL, THIN_LIQUIDITY, SELL_WALL, FILL_WORSE) that worsened since the BUY.

  They are re-calibrated from the pre-dispatch snapshots recorded in `fd1_final_recheck_log`.
- **Missing data:** a missing initial reference, pre-dispatch quote or tape always triggers. It is never treated as a pass.

## What the bands select (76 replay BUYs, 60-minute forward path, native-stop proxy −2.5%)

| rule | recheck rate | triggered: 15m / 60m / MAE / stop | not triggered: 15m / 60m / MAE / stop |
|---|---|---|---|
| any trigger | 49% | −0.77% / −1.47% / −5.35% / 70% | +0.43% / −0.99% / −4.54% / 69% |
| PRICE_ADVERSE | 22% | −1.05% / −1.96% / −6.74% | +0.11% / −1.01% / −4.41% |
| TAPE_FLOW_REVERSED | 37% | −0.97% / −1.10% / −5.49% | +0.33% / −1.30% / −4.61% |
| BUY_SHARE_DROP | 26% | −1.33% / −2.41% / −5.80% | +0.27% / −0.80% / −4.62% |

- Triggered candidates have clearly worse short-horizon paths (15m −0.77% vs +0.43%).
- The stop-or-60m proxy PnL is nearly equal (−0.77% vs −0.80%), so the detector identifies changed markets. By itself it is not a profitable filter, and it must not be one: GPT decides.
- With 76 samples, nothing here is a performance claim.

## NIL

The NIL pre-dispatch state is inside every tail band:

| metric | NIL value |
|---|---|
| price change | −0.21% |
| tape return | −0.135% |
| buy share | 0.485 |
| buy-share change | −0.07 |

It triggers only TAPE_FLOW_REVERSED, the sign rule above. Nothing was tuned so that NIL skips; the FINAL decision on NIL is GPT's (see the deployment evidence).
