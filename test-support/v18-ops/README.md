# V18 operational isolation regression

No exchange credentials, production database, scheduler invocation or live orders are used.

From the repository root (Node 22 or newer):

```sh
npm install --prefix test-support/v18-ops --ignore-scripts --no-audit --no-fund
PGLITE_MODULE="$PWD/test-support/v18-ops/node_modules/@electric-sql/pglite/dist/index.js" \
node --test --test-reporter=tap test-support/v17-exit/*.test.mjs research/v18/*.test.mjs test-support/v18-ops/*.test.mjs gateway/*.test.mjs
```

`harness.mjs` loads the complete real executor into a VM and replaces only DB,
gateway, environment and clock boundaries. `runCycle()` invokes the real
`runWithLease → run → manage → refresh → openBull` path. The baseline loads
executor and protection modules with `git show` from
`bce9e95210829b5ae561f667dd1b499772977ec1`; fetch that commit if using a shallow clone.

`postgres.test.mjs` executes the migration and trigger/RPC cases in PGlite
PostgreSQL. Column types were read from production. The fixture includes the
affected attribution and slot-cap triggers, keys and isolated data; it is not a
complete production schema clone or a concurrent multi-connection Postgres test.

Prices, IDs and gateway timing in the execution tests are synthetic. TAC quantities
and ordering are drawn from the incident; SAGA's test price is not a historical
execution or a claim of recoverable profit. Restart tests construct a new VM and
reuse only the persisted rows and exchange receipts.

The SQL recovery timing test supplies previous observation timestamps in the
isolated database. It does not wait for two wall-clock minutes. The source-flow
tests separately exercise three scheduler cycles with distinct account reads.

Native replacement tests in `test-support/v17-exit/native-protection.test.mjs`
cover create-before-cancel, cancel-in-flight execution, unknown submission and
idempotent cumulative execution. Gateway tests use mocked signed HTTP responses.
