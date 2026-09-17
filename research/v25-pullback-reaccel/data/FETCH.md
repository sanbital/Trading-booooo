# Re-fetching the klines

`*-bars.json` are raw Binance 1m klines and are **not committed** — they are ~13 MB of
numbers that the exchange will hand back on request. Everything derived from them is
committed: the candidate rows, the triggers, and `results.json`, which carries every
replayed trade with its entry, exit, reason and PnL.

The klines were pulled read-only through the production database's `http` extension,
because this environment's egress policy blocks `fapi.binance.com` directly. Nothing
was written to the database: no table was created and no row was inserted or updated.
Klines weight 1–2 per request and the whole set is ~800 requests, so this is well
inside the account's rate budget — but it does share the production IP, so run it when
the bot is not mid-scan.

Each file is `{ "<signal id>": [[openTime, open, high, low, close], ...] }`.

## The four pulls

All four use the same shape. `<WHERE>` and `<RANGE>` change per file.

```sql
with t as (
  select id::text cid, symbol, (features->>'signal5Close')::bigint s5c,
         (features->>'referenceClose')::numeric ref,
         (features->>'dayReturn')::numeric dayret,
         (features->>'volumeRatio')::numeric vr
  from public.v11_long_regime_signals
  where features->>'strategy' = 'LEADER_MOMENTUM_V17' and <WHERE>
), fetched as (
  select t.*, (select content from http_get(
    'https://fapi.binance.com/fapi/v1/klines?symbol=' || t.symbol ||
    '&interval=1m&startTime=' || <RANGE_START> ||
    '&endTime=' || <RANGE_END> || '&limit=380')) body
  from t
)
select json_agg(json_build_object('cid', cid, 'symbol', symbol, 's5c', s5c, 'ref', ref,
         'dayReturn', dayret, 'volumeRatio', vr, 'bars', bars))::text
from (
  select f.cid, f.symbol, f.s5c, f.ref, f.dayret, f.vr,
         string_agg(format('%s,%s,%s,%s,%s', k->>0, k->>1, k->>2, k->>3, k->>4), ';'
                    order by (k->>0)::bigint) bars
  from fetched f, lateral jsonb_array_elements(f.body::jsonb) k
  group by f.cid, f.symbol, f.s5c, f.ref, f.dayret, f.vr
) g;
```

| file | WHERE | range |
|---|---|---|
| `setup-bars.json` | gated: `created_at >= '2026-09-10'` and `dayReturn` in [0.03, 0.08) and `volumeRatio >= 1.30` | `s5c - 120000` → `s5c + 960000` (25 bars: the setup window plus one lead-in) |
| `hold-bars.json` | the 43 ids in `triggers.json` | `triggerAt` → `triggerAt + 22500000` (376 bars: 6h16m) |
| `baseline-bars.json` | the 88 merged gated candidates | `s5c` → `s5c + 22500000` |
| `ungated-{dev,holdout}-bars.json` | ungated, ASCII symbols only, deduped by `(symbol, s5c / 900000)`; dev is `s5c < 1789567200000`, holdout is `>=` | `s5c` → `s5c + 22500000` |

Five gated candidates returned no klines (delisted or unlisted at the time) and are
excluded; the replay counts them as `NO_BARS` rather than silently dropping them.
