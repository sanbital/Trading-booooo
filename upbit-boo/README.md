# Upbit Boo

Independent Upbit deployment of Trading Boo.

## Source snapshot

- Original repository: `sanbital/Trading-booooo`
- Original branch: `main`
- Original commit: `75b9bc9ab7663eb06335a7278158918987c67072`
- Bootstrap date: 2026-08-14 KST

The strategy code under this directory is a snapshot of the validated Original Trading Boo runtime. The Upbit deployment must remain operationally isolated even when strategy upgrades are synced from Original.

## Isolation contract

Upbit Boo must use its own:

- Supabase project and database
- Supabase service-role/publishable keys
- Upbit API access key and secret key
- order gateway deployment/static egress IP
- `GATEWAY_SHARED_SECRET`
- `AUTOTRADE_ACCESS_TOKEN`
- runtime logs, orders, fills, positions and learning data

Do not reuse the Original Trading Boo production Supabase project or exchange credentials.

## Exchange mode

The Upbit Boo database must initialize the trading settings as:

- `upbit_enabled = true`
- `binance_enabled = false`
- `binance_futures_enabled = false`
- initial mode: `PAPER`

The gateway already contains Upbit JWT signing, quotation/order handling and local rate guards. Binance credentials must remain unset for this deployment.

## Safety rules

1. Start in `PAPER` / shadow operation.
2. The Upbit API key must not have withdrawal or transfer capability.
3. Restrict the Upbit API key to the dedicated gateway static egress IP when supported.
4. Never commit real keys or service-role secrets to Git.
5. Promote to `LIVE_LIMITED` only after schema, gateway, reconciliation, order-test and shadow-trade validation pass.
6. Original Trading Boo remains the master strategy. Strategy upgrades may be copied into this directory only after validation; secrets and database state never sync.

## Bootstrap sequence

1. Create a separate Supabase project.
2. Apply the Trading Boo schema/migrations to the new project.
3. Deploy copied Edge Functions to the new project.
4. Deploy a dedicated Upbit order gateway.
5. Configure only Upbit credentials and the new Supabase credentials.
6. Initialize Upbit-only trading settings in `PAPER` mode.
7. Verify market reads, order-test, balances, LOB telemetry, candidate generation and reconciliation.
8. Collect shadow-trading data before enabling `LIVE_LIMITED`.
