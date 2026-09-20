# V28 round 03 checkpoint

No candidate has passed. `CF01 NEXT_1M_BREAKOUT_FLOW_CONFIRM` was preregistered before its outcome query and evaluated against canonical automated Futures fills with read-only database access.

The 48-hour cohort contained 52 completed positions. Only 19 had the required prior/confirmation/next one-minute candles because `claude_k1` ends at 2026-09-19 10:31 UTC; 33 were fail-closed as missing. CF01 accepted two positions: one win and one loss. Funding-excluded paired PnL at original executed quantity was -1.28548051 USDT, PF 0.373342, trade-sequence MDD -2.05132739 USDT, and top-one-winner-removed PnL -2.05132739 USDT. Prespecified cost stress was -1.44850060 USDT with PF 0.320820. Entry delay cost 0.68893407 USDT gross across the two accepted positions.

The 24-hour cohort contained 34 positions, but 28 lacked required candles and no position passed the completed-bar conditions. Zero trades is a failure, not success.

This is a paired actual-flow diagnostic, not a replacement-position replay. It reused actual exit VWAP and exact sell-side fees, used only original executed quantity, omitted unverified funding, did not establish 600 USDT fillability, and did not reproduce queue/top-10/wall-clock behavior. It must not be reported as account PnL or promoted.

The Library checkpoint's referenced V28 replay files were absent locally and not present on a GitHub research branch. Therefore the current 30-day/7-day market replay, walk-forward, and unused holdout were not fabricated. The older 2026-08-19 to 2026-09-18 cache was not relabeled as current.

Next structural hypothesis: stop using a single conjunctive completed-bar gate. Preregister a causal two-path state machine: immediate admission if the completed entry minute already holds the reference with majority flow; otherwise wait for one observable pullback-reclaim with improving buyer-flow slope, then enter. Preserve 200 USDT per slot, 3x, MAX_SLOTS 10, solveQuantity, and all production protections. Explicitly measure rejected-winner opportunity cost.

No production setting, order, position, approval, circuit, cron, or deployment was changed.
