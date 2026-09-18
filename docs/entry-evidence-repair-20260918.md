# Entry evidence boundary repair — 2026-09-18

Base: `fff9cf4c90d4b9d0f390076f4b4e722b1df0fde6`.

## Findings and changes

A setup's `V17_REACCEL_TRIGGERED` event was an intermediate candidate, not final
order approval. The inspected unfilled candidates ended in `V17_ENTRY_DRIFT`.
An OBSERVE BOO verdict is not the enforcing cause of that rejection. There was
no persisted executable quote sufficient to reconstruct those historical drift
checks. This change retains the original 1% two-sided price guard, records the
actual checked limit/reference/quote timestamp/stage, and separates setup events
from completed-entry outcomes. It does not claim those candidates would have
been profitable or should have been traded.

Independently reproduced code defects:

* E1 used the old 120-second signal deadline for setup entries that can trigger
  later. Setup entries now use their own 60-second trigger deadline, bounded by
  the 15-minute setup expiry, with identity/time/reference consistency checks.
  Legacy entries keep the original deadline. No timestamp is rebased to arrival.
* BOO read `quote.raw.asks/bids` while the gateway returns normalized
  `quote.asks/bids` objects. The adapter now validates and converts them to the
  risk solver's array format. Empty, invalid, crossed, stale, future and
  inconsistent books remain unhealthy.
* The gateway reports `taker_pct`, but the executor read fraction-only names.
  Percent is converted to a fraction once, using the account/symbol response.
  Missing/conflicting fees cause explicit refusal, not zero or a default fee.
* P10 portfolio does not report account position mode. A separate authenticated
  read-only `futures_position_mode` command now supplies fresh explicit evidence.
  It never changes the mode, does not read/update the order cache, and adds no
  calls to position management/exit portfolio reads. Unknown and hedge modes do
  not become one-way approval.

## Boundaries

No live settings, database rows, validation records, strategy thresholds,
leverage, slot size, risk ceilings, protective-stop state machines, or exit
policies are changed. OBSERVE/ENFORCE is still selected by the existing control
row. Approval records and measured positive edge are not invented. Implausible
risk settings still require an explicit operator decision; margin allocation is
not reinterpreted as equity-loss risk.

A fresh mode read requires the matching gateway code before an enforcing
executor can use it. An older gateway's unknown-command response remains unknown
mode evidence. No production deployment is performed by this branch's tests.

The additional mode GET is entry-only and bounded by the existing cycle budget.
Existing quote freshness limits are not relaxed. Slow dependency reads can still
make a quote too old; these are real refusals, not grounds for admitting stale data.

## Verification

Run the new boundary/source-wiring tests and the existing gateway tests:

```sh
node --test supabase/functions/v10-lane-executor/entry-evidence.test.mjs gateway/*.test.mjs
```

The `Entry evidence regression` CI also runs the repository's canonical
`test:entry` command and the Deno BOO/margin tests with read-only runtime
permissions. No exchange/DB credentials are provided to the regression job.

These tests verify deterministic behavior with mocks and synthetic fixtures,
not profitable strategy performance or a completed live order lifecycle.
