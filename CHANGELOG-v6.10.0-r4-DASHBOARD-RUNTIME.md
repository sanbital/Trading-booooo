# v6.10.0 r4 — Dashboard Runtime Hotfix

## Confirmed defect

The operator dashboard called `finite(...)` in `renderPositions()` and the residual inventory renderer, but the second browser IIFE did not declare that helper. Authentication and the backend request succeeded; rendering the returned status then threw `ReferenceError: finite is not defined`, which the login UI displayed as a connection failure.

## Fix

- Added a local, bounded `finite(value, fallback)` helper to the operator-dashboard IIFE.
- Bumped the `app.js` cache-busting query string to `v6.10.0-r4`.
- Added a v6.10 deployment invariant that verifies the helper is declared before use.
- Added a dashboard-specific GitHub Actions workflow so browser JavaScript changes receive syntax and source-level runtime checks.

## Scope

No trading, accounting, sizing, policy, migration, gateway, or Supabase Edge Function behavior changed.
