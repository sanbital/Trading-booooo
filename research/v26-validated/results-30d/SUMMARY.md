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

Provisional candidate: NONE

no_robust_edge_found=true (no unused independent holdout).

Dataset hash: `ace383a59ac3e42fefb0a6a36b4b9c0c1935902d37f3b7d2b3e8d03b2db28b1f`
Code hash: `e1ebc6d57629d68df2ecd79a7209b0db670bafeb7fc25e5f5e57cda439e95847`
