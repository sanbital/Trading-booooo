# V20 loss minimization and profit preservation review

This research starts from the byte-identical production V38 source at commit
`d5424b54ca25dff364cde96692f7bf9abdc6f77b`. It does not submit orders, change
operator controls, modify the ledger, repair CHZ, or deploy a strategy.

`protocol.json` freezes the evidence boundary, chronological windows, existing
promotion gates and safety constraints before candidate results are calculated.
The first workflow only exports a repeatable-read, read-only database snapshot,
signed exchange reads, public one-minute candles, the recorded L1 shadow stream,
and exact production source parity evidence. Raw account evidence is kept in a
short-lived workflow artifact and is never printed or committed.

A separate candidate lock must be committed after development-only diagnosis and
before any validation-window result is opened. A strategy release is prohibited
unless every preserved gate passes. Observability or implementation-defect fixes,
if any, must remain a separate diff and cannot be described as strategy superiority.
