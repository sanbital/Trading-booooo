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
| C7 | 4 | -0.0947 | 29.9053 | -0.32% | 0.356 | -0.1222 | -0.06934 | -0.0690 | 0.0000 | NO |
| C8 | 6 | -0.2765 | 29.7235 | -0.92% | 0.188 | -0.2875 | -0.06873 | -0.2941 | -0.1368 | NO |

Provisional candidate: NONE

no_robust_edge_found=true (no unused independent holdout).

Dataset hash: `fbb84a07a5d71ca90fdef1da23809fbe4fd7de482875e1fb763c1c4918a59024`
Code hash: `2457a1ebc8bd0f08979d6f95a56bb6c2a8c5b78605955d1fbf892bf9bb42e6d2`
