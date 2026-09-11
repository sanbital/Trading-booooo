# Frozen conditional strategy validation

Pure offline candidate entry and exit rules, fill reconciliation, actual-decision parity,
bounded fixed-entry replay, component ablations, execution stress, and descriptive
multiple-comparison adjusted bootstrap. These scripts have no account credentials,
network access, deployment action or trading controls.

The private companion evidence package contains the frozen `protocol.json`, its hash,
positions, signed fills, recorded decisions, candles and results. No private account
data is published in this repository. Preserve that protocol and its negative findings.

From the repository root with Node 24+ and Python 3.11+:

```sh
python research/20260911_quant_validation/audit.py /absolute/path/to/evidence
node research/20260911_quant_validation/replay.mjs /absolute/path/to/evidence
node --test research/20260911_quant_validation/candidates.test.mjs
```

`BASELINE` imports the same pure exit policy used by the verified operational executor.
The existing four prior exit experiments are replayed separately and keep their names.
New hypotheses are ATR-normalized completed-candle entry filtering, no-progress exit,
and a profit-plateau exit. All seven combinations are evaluated once at frozen values.
Existing stops, peaks and partial state are retained. No candidate is imported by a
production function, and no current position is migrated.

The replay fixes historical executed entry events. It does not reconstruct replacement
signals, full account funding, cash/slot competition, or all intraminute stop execution.
Stop/action agreement on recorded bids does not establish fill-price or account parity.
Known-entry retention is not market opportunity retention. Funding remains unknown.
An apparent gain cannot pass promotion when these required evidence gates fail.

Actual fill matching uses market and order/trade identifiers, verifies balanced quantity,
preserves partial fills, and avoids double charging slippage on observed prices. Invariant
failures stop reconstruction. Candidate results and bootstrap intervals remain diagnostic
when baseline execution fidelity or independent data is insufficient.

For operational recovery, use the separately verified production manifest and a human
operator. A source branch, tests, or a research result is not a deployment or authorization
to enable live orders. Do not reset protection state or treat a reported symbol-validation
failure as permission to bypass exchange validation.
