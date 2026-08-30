# V10-H Candidate Lock — H-X OI-Ranked Delever Rebound

Locked before querying the OI-ranked max-one-position TEST path.

Signal is identical to H-U: D11 RANGE delever rebound A/H6 plus 1h taker-flow band [0.05, 0.10).

Portfolio rule:
- maximum concurrent position = 1
- at a simultaneous entry hour, select the signal with the **most negative six-hour OI change** (`oi6_pct` ascending)
- tie break by market symbol
- this ranking is chosen because OI deleveraging is the core economic mechanism; qv24 ranking is unrelated to the rebound edge
- fixed six-hour hold; no re-ranking after entry

TRAIN max-1 OI rank:
- 15 trades / 14 markets
- STRESS +303.87 bps/trade
- PF 8.976
- halves +500.18 / +79.51
- remove-best +178.09

VALIDATION max-1 OI rank:
- 7 trades / 7 markets
- STRESS +107.22 bps/trade
- PF 2.860
- halves +118.26 / +92.50
- remove-best +0.09

TEST OI-ranked path has not been queried before this lock. Pass gate: positive STRESS mean, PF > 1.10, both chronological halves non-negative, and no material single-market concentration.
