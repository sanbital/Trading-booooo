# Capture recovery diagnostics: 2026-09-28

Production executor v141 reported CAPTURE / NONFINITE for ONEUSDT review
461d33ac5652b17286353a9980b0febc97cfff11d341bdfeae7ffebf98d04fda at04:00:09 UTC.
A second CAPTURE NONFINITE occurred at04:03:16. No paid request was made for these failures.

When the first read has no end timestamp, captureForInference uses -Infinity only
as an internal comparison sentinel. Both success and failure diagnostics copied
that sentinel and its infinite age into the packet; the unchanged strict snapshot
hasher then rejected the packet. A successfully recovered full trajectory could
therefore fail before GPT was called.

The fix writes null for an unknown previous end/age in diagnostics. It preserves
all acquisition comparisons, polling deadlines, original timestamps, trajectory
values, retry watermarks, strict validity checks, budgets and order protections.

Validation:
- Before fix:2 of3 regression tests failed with NONFINITE in the actual packet hasher.
- After fix:80 focused tests passed, including timeout recovery, FINAL decisions,
  IOC/partial-fill/protection paths using offline exchange transports.
- Full Node:1477 passed; Deno:1055 passed plus13 steps; executor/generator type checks passed.
- Recorded SOON FINAL RECHECK capture from job6b315a4c17605bb57040f5927afd28be2a14062e5719ff9fa5f3b858433cb0d2
  was replayed with an injected missing first read. All24 trajectory rows, dynamics
  and original end time were identical after recovery and hashing succeeded.
  This is not an exact replay of the lost ONE preparation input. Provider calls0,orders0.
- Original capture-context source matches downloaded executor v141.
- Actual rollout version/hash and post-rollout observations are retained in the
  first-fill monitor artifact; this pre-deploy document does not assert rollout success.

No decision was changed to BUY. The observed valid FINAL WAITs remain unchanged.
Residual provider timeout/unknown reservations and category-evidence/semantic errors
are separate issues and are not declared fixed by this change.
