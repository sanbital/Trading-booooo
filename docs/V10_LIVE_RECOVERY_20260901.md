# V10 live recovery — 2026-09-01

## Production boundary

- Existing validated BULL/P10 runtime: live entry resumed at 40 USDT margin and 3x leverage.
- V10 RANGE: independently validated entry fingerprint activated in shadow only.
- V10 BULL candidate: failed the one-shot 2021 holdout and remains disabled.
- V10 BEAR candidate: failed the one-shot 2021 holdout and remains CASH.

## Repairs in this revision

- Generator authentication uses a dedicated 256-bit internal token looked up at runtime; unsigned public requests fail closed.
- Strategy registry rows must match the exact engine revision.
- Signal generation runs at the next 15-minute bar open instead of one minute late.
- CLOSE_LONG idempotency is keyed by exit decision; multiple split exits from one entry signal are no longer blocked by a signal-level unique constraint.

No V10 live flag is enabled by this revision.
