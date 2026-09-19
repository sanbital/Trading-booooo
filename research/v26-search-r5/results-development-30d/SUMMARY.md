# Binance 30-day V26 validation

Window: 2026-08-19T15:10:00.000Z -> 2026-09-18T15:10:00.000Z

This is a fresh Binance-API development replay, not an independent holdout.

| Candidate | Trades | Net | Final equity | Return | PF | MDD | LCB/trade | Stress2x net | Stress4x net | Dev pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| C25 | 2 | 0.3580 | 30.3580 | 1.19% | Inf | -0.0404 | 0.00016 | -0.0039 | 0.0000 | NO |
| C26 | 3 | -0.0896 | 29.9104 | -0.30% | 0.354 | -0.1265 | -0.06936 | -0.0694 | 0.0000 | NO |
| C27 | 1 | -0.0025 | 29.9975 | -0.01% | 0.000 | -0.0390 | NA | 0.0000 | 0.0000 | NO |

Provisional candidate: NONE

no_robust_edge_found=true (no unused independent holdout).

Dataset hash: `928d00258104d32675414df52706665f4cac7072913d16259303f22b13a9f9b9`
Code hash: `0201ceeded67c0ec185fba3c755cf9fc55a4bd9d6ea3070f9fefea3b9fbec618`
