# V26 research checkpoint — validator integrity complete

Generated: 2026-09-19

Scope: research-only. No main merge, production deploy, order, account-setting change, approval change, circuit change, or live-position mutation was performed.

## Completed now

The actual replay entry point `research/v26-validated/binance-30d-validation.mjs` is now wired to the tested integrity layer. Validator repair is complete and is no longer the hourly automation's work item.

1. Binance Vision daily/monthly archives are accepted only after their official `.CHECKSUM` passes SHA-256 verification. Cache hits re-verify and re-extract the archive, so an unverified or modified CSV cannot enter a replay.
2. Every requested 15-minute month is checked independently. Missing timestamps trigger per-day fallback, and remaining gaps fail closed.
3. One logical dataset hash is produced from sorted source object hashes, including cache hits and local audited inputs. Cache warmth and retrieval order no longer change the hash.
4. Funding is never converted to zero on an HTTP or coverage failure. The validator uses Binance USD-M funding history when reachable or an explicit cache whose coverage spans every requested holding interval. Missing coverage throws.
5. `blocked15mCutoffs` is derived from completed-bar coverage. The hard-coded zero was removed.
6. New candidate validation defaults to `STRENGTH_LOSS_V1`, which uses completed price/flow evidence and contains no holding-time input. Old `V17_MAX_HOLD`/`V17_MOMENTUM_STALE` behavior is available only through the explicitly named `LEGACY_C0_C12_REPRODUCTION` mode.
7. Positions whose strength-loss exit is not observed are kept slot-blocking through the evaluation boundary and included as clearly labelled mark-to-market exposure, not silently dropped.

## Verification

- Syntax check: pass.
- Integrity, funding, coverage, Vision cache/checksum, entry-point wiring, risk and prior replay regressions: 21/21 pass locally.
- The GitHub Actions integrity workflow now watches the integrated entry point and runs the complete 21-test set plus a live official Binance Vision checksum probe.
- GitHub-hosted funding REST may return HTTP 451. In that environment a verified coverage cache is mandatory; the validator fails closed otherwise.

## Result status

- No strategy result was promoted by this repair.
- Existing C0-C12 results remain prior evidence and are not relabelled as new holdouts.
- `no_robust_edge_found=true` remains until the separate hourly strategy-search automation produces a candidate satisfying the user's positive monthly net-profit and return criteria.
- Reserved unused holdout windows were not consumed during validator integration.

## Next automated work

The hourly automation must now use this completed validator only for candidate search, walk-forward testing and unused-holdout validation. It must stay silent unless a new candidate has meaningful positive 30-day net PnL and return after all costs and passes the robustness gates.
