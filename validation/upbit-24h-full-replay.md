# Upbit KRW 24h Full-Market Replay
- Window: 2026-08-19T06:27:03Z ~ 2026-08-20T06:27:03Z
- KRW markets: 283; with candles: 283
- Market 24h return: mean 4.6000% / median 4.6784% / positive 89.40%
- Scanner BUY: raw 28, 180s-dedup 23, replayed 23

## Broad market 30-minute entry baseline (fee-net)
|Horizon|N|Mean %|Median %|P10 %|Positive %|
|---:|---:|---:|---:|---:|---:|
|180s|7819|-0.0906|-0.1000|-0.4052|21.74|
|300s|7819|-0.0777|-0.1000|-0.5094|27.20|
|600s|7819|-0.0603|-0.1000|-0.6551|33.39|
|900s|7819|-0.0738|-0.1000|-0.7704|35.02|

## Scanner BUY 600s protection replay
- Current fixed: n=23, mean=0.0946%, p10=-0.0805%, positive=82.61%
- Best dynamic: DYN_S8_T1, mean=0.0855%, p10=-0.0805%, positive=82.61%
- Observed 2s adverse move magnitude: median=11.4778bps, p90=33.2946bps, p95=44.0194bps

## Entry delay 600s fee-net
|Delay|N|Mean %|P10 %|Positive %|
|---:|---:|---:|---:|---:|
|0s|23|-0.0212|-0.8053|56.52|
|30s|23|-0.2487|-0.6940|47.83|
|60s|23|-0.2517|-0.5860|39.13|
|120s|23|-0.1480|-0.7535|52.17|
