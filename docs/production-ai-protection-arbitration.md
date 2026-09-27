# Protection arbitration (AI_PROTECTION_ARBITRATION_1)

Successor to the protection half of `AI_EXIT_AUTHORITY_2`. Nothing in hard safety changes.

## Why

Live trade `eb583cdc-3414-48fb-a559-e097476281be` (SOONUSDT, 2026-09-26):
entry `0.231022`, peak `0.2365`, hard floor `0.2283`. The deterministic engine raised the
exchange-resident reduce-only `STOP_MARKET` by itself — `0.233511` (`PROFIT_LOCK`, 21:36:15Z)
then `0.233911` (`retestAnchor_LOCK`, 21:38:18Z) — while the reviewer's last decision was `HOLD`
(21:33:19Z) and `fd1Hold.protectLevel` was `null` throughout. Price touched the level and the
position closed at `0.234` with `exit_reason=retestAnchor_LOCK`, net `+5.3537 USDT`.

Nothing was broken: every level was monotonic and the replacement was safe. The authority was
wrong. A strategic profit-protection decision executed without the final judgment that the
operating principle assigns to GPT: enter rising symbols, hold while they are strong, exit when
the reason is gone.

## Authority

| class | examples | approval |
| --- | --- | --- |
| HARD_SAFETY | `NATIVE_HARD_STOP`, `R5_RISK_CUT`, liquidation, reconciliation corruption, invalid position state, exchange critical failure | none — executes immediately, before any model call |
| SOFT_PROTECTION | `retestAnchor_LOCK`, `retestAnchor_TRAIL`, `V17_PROFIT_LOCK`, `V17_COST_BREAKEVEN`, `V17_TRAILING_STOP`, `*_SUPPORT` | a raise requires GPT FINAL `PROTECT` |
| AI_STRATEGIC | `FD1_GPT_EXIT`, `FD1_DEEPSEEK_EXIT` | fresh validated reviewer EXIT |

## Flow

```
market → deterministic candidate (retestAnchor / P142, unchanged)
       → DeepSeek independent parallel opinion on the same frozen snapshot
       → GPT FINAL arbitration: HOLD | RAISE_PROTECTION (wire: PROTECT) | EXIT
       → approved level = max(ever approved, exchange-acknowledged, this approval)
       → reduce-only STOP_MARKET replaced acknowledge-before-cancel at the approved level
       → the exchange fills it if price reaches it
```

`softCandidate()` is unchanged and still monotonic (`accepted = max(old, new)`, `P142_STOP_WIDENED`
still throws on a widening). Its output is now a **candidate**: `exit_context.protection` shows it
as `candidate_soft_stop` next to `approved_soft_stop`, and the executor's resident protection comes
from `approvedProtection()`, never from the candidate.

## Invariants

- `approved_soft_stop` is append-only. A request below it is ignored and written to the audit as
  `BELOW_APPROVED_IGNORED`; equal is `EQUAL_TO_APPROVED_NO_OP`.
- GPT never supplies a price. `PROTECT` approves exactly the candidate bound to the review claim
  (`fd1Hold.pending.softLevel`). No candidate, or none above the approved level → nothing moves.
- Only `GPT_FINAL_ONLY` authority may raise. DeepSeek's emergency authority still covers EXIT and
  HOLD; its `PROTECT` records `KEEP_LAST_APPROVED_PROTECTION` and buys elevated sensitivity only.
- Any reviewer failure (timeout, invalid answer, ABSTAIN, exhausted budget, provider outage,
  missing key) → `KEEP_LAST_APPROVED_PROTECTION`. Hard safety keeps executing regardless.
- Protection already live is grandfathered as approved: the level the exchange acknowledges, the
  level this executor last made resident, and a pre-v2 legacy profit stop. A deploy therefore
  cannot lower the protection of a position that is open across it.
- Software may close on a crossing of the **approved** level only (the gap backstop for the
  resident order). An unapproved candidate crossing closes nothing; it starts a review.

## Audit

`public.v11_protection_decisions` — append-only, service-only, insert+select grants only. One row
per protection decision with the hard floor, the candidate, the approved level and source, whether
it was raised, and the execution result. The full model answers (frozen snapshot hash, DeepSeek
decision/confidence/evidence, GPT arbitration reason with supporting/opposing evidence, model
versions) stay in the review journal row named by `details->>'reviewJobKey'`, so each answer has
exactly one authoritative copy.

Evolution reads this and the replay's `candidate_floor` / `resident_floor` pair to learn where a
raise clipped a winner and where a missing raise gave profit back. The evolution worker has no
authority over production protection.

## Counterfactual, recorded on purpose

After the real `0.234` exit SOON fell through `0.2283`. On the arbitrated path the trade would have
run to the hard floor instead, for a worse result on that single trade. `retestAnchor` is not
disabled and no hard protection was weakened — only the authority to raise a soft level moved to
the reviewer, which is the operator's stated decision.

Regression: `tests/fd1-protection-arbitration.test.mjs` (20 cases, the live SOON numbers as the
fixture, both the HOLD path and the counterfactual hard-stop path).
