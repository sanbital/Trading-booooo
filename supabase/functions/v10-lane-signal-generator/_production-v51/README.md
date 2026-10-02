This graph preserves the 15 dependency files returned by the production
v10-lane-signal-generator v51 deployment on 2026-10-02. The manifest in
deployment-evidence/signal-generator-v51-baseline.json records their hashes.
The entrypoint changes only the three shared import prefixes.

The executor v183 shares some filenames but contains different capture,
dynamic packet, paid transport, and authority-clock implementations. Deploying
the generator against the executor's shared graph would silently change the
generator's behavior. Keep this graph immutable during the infrastructure
migration. Scheduler admission belongs in the entrypoint, outside this graph.
Any later consolidation requires a separate behavior-equivalence review.
