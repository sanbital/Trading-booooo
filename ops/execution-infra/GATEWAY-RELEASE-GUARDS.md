# Gateway release trigger audit — 2026-10-02

Both deploy-binance-gateway.yml (Paris) and deploy-order-gateway.yml (Tokyo) are production active release paths, not dead functions. Their push triggers redeployed on any gateway file change; the Paris workflow also redeployed after an edit to its own file. Each resets legacy scheduler/configuration and secrets during deployment. This can undo a scheduler cutover and deploy unrelated gateway changes automatically.

They remain available as workflow_dispatch-only releases from sanbital/Trading-booooo main, in the production environment, with the explicit INFRA_GATEWAY_MANUAL_V1 marker. No currently running machine, secret, cadence or trading control changes through this commit. Staged scheduler rollout must preserve the actual running machine configuration and verify image/source hashes before activation; the legacy workflows are not the cutover procedure.

Rollback of a release uses its saved machine configuration and image, not restoration of automatic push triggers. These two workflows are not one-shot migrations. No other Edge Function or workflow is removed or classified as dead by this change.
