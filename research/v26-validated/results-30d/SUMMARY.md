# Binance 30-day V26 validation

Window: 2026-08-19T15:10:00.000Z -> 2026-09-18T15:10:00.000Z

This is a fresh Binance-API development replay, not an independent holdout.

| Candidate | Trades | Net | Final equity | Return | PF | MDD | LCB/trade | Stress2x net | Stress4x net | Dev pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| C0 | 0 | 0.0000 | 30.0000 | 0.00% | 0.000 | 0.0000 | NA | 0.0000 | 0.0000 | NO |
| C1 | 3 | -0.2070 | 29.7930 | -0.69% | 0.000 | -0.2070 | -0.06956 | -0.2069 | -0.2074 | NO |
| C2 | 3 | -0.2070 | 29.7930 | -0.69% | 0.000 | -0.2070 | -0.06956 | -0.2069 | -0.2074 | NO |
| C3 | 3 | -0.2059 | 29.7941 | -0.69% | 0.000 | -0.2059 | NA | -0.2241 | -0.1211 | NO |
| C4 | 3 | -0.2059 | 29.7941 | -0.69% | 0.000 | -0.2059 | NA | -0.2241 | -0.1211 | NO |
| C5 | 3 | -0.2083 | 29.7917 | -0.69% | 0.000 | -0.2083 | -0.06978 | -0.0953 | -0.1386 | NO |
| C6 | 5 | -0.2133 | 29.7867 | -0.71% | 0.220 | -0.2836 | -0.06873 | -0.1582 | 0.0000 | NO |

Provisional candidate: NONE

no_robust_edge_found=true (no unused independent holdout).

Dataset hash: `1680efc947c3a40ec82022ccf926c77b43564cd29a49e66516b6efe6abf434e1`
Code hash: `f2d744e4e8534394f1c32f85762c25de48e28e52acfa4b5c181abb9276930aee`
