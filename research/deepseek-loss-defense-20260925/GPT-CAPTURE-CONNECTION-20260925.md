# Live capture connected to GPT — 2026-09-25

The operator requested that expanded capture actually be used in GPT's live entry and exit decisions. Source commit `fd84952718000e22fa926cad8e968042643dad0d` connects it to ENTRY, FINAL RECHECK and HOLD through shared market reads, facts, packet hashes and model payload serialization. Supabase executor bundle v90 is active; `gpt_context_enabled=true`. The executor index and order adapters are byte-identical to the saved v89 deployed bundle. Only five existing GPT shared modules and one new context module changed in the deployed bundle.

Collection and input details are frozen in [GPT-CONTEXT-AMENDMENT.md](../../collectors/doa-capture/GPT-CONTEXT-AMENDMENT.md). The original capture protocol remains unchanged. Existing HOLD event triggers determine when GPT reviews a position; native stops, deterministic protection and trailing retain their existing behavior. This does not ask GPT on every five-second capture, change position sizing, or give DeepSeek execution authority.

## Deployment and verification

- [CI run 36145245186](https://github.com/sanbital/Trading-booooo/actions/runs/36145245186): 12 collector/database tests and 114 GPT/regression tests passed; both Edge Functions passed Deno checks. No CI skip marker.
- Collector `DOA-CAPTURE-2-GPT-CONTEXT`, Fly machine `8654e66fe16758`, region cdg, image digest `sha256:6450ec4ad3ba4166ca8e885a8ea58627be8eec0ab414c2502451a8b1cf4a2260`.
- Supabase v90 bundle SHA `486f6192ca97d801d9c1471ab7f8f74fbc74c58527327ba066cf12ad1e3ddb17`. Downloaded after deployment and compared against v89: executor source and all order adapters unchanged; exactly the six expected shared files differ.
- Read-only RPC migration history aligned to the CLI-generated version `20260925135156`; default disabled, explicitly enabled after collector data was ready.
- Three journaled order-free live-input GPT checks on ENAUSDT: ENTRY 2720ms, HOLD 1293ms, FINAL RECHECK 2554ms. All returned valid responses with stored AVAILABLE capture windows approximately 60 seconds long and 11.6–13.5 seconds old at collection. Request IDs and job keys are in the adjacent JSON evidence file. Payload tests verify those stored facts reach the actual serialized user messages; freshness is checked again there.
- These are fixture decisions using live market data, not executed trades. The recheck probe deliberately supplies synthetic adverse changes to exercise the recheck path; its SKIP response is not evidence of predictive performance. No forced trading was used.
- The additional nonjournaled HOLD in the entry probe was also valid. All probes reported zero order calls. Subsequent account readiness showed no open positions/orders, circuit closed, last error null and FLAT protection.
- At 14:11:29 UTC the collector watched 24 symbols, had 23 synchronized books and 24 trade streams, no REST failures and an empty queue. Seventeen summaries were AVAILABLE; seven were still unavailable due to warmup, incomplete depth coverage or gaps. Availability is conditional and never fabricated.

DeepSeek HOLD shadow received the same augmented packet but its one probe returned `COUNTER_SCHEMA_EXTRA`; that answer remained invalid and had no authority. GPT's HOLD completed normally. This is an outstanding counter-model reliability issue, not a successful DeepSeek decision validation. No automatic retries or schema relaxation were added to turn it into a passing result.

This verifies operational input delivery and existing execution invariants, not reduced losses or increased returns. New-input decisions must be version-separated in later evaluation. Existing TEST observations cannot be reused for policy selection. No prospective authority promotion for DeepSeek is implied.

## Immediate rollback

```sql
update doa_capture.control set gpt_context_enabled=false where id=1;
```

That disables usable added context; GPT continues with existing facts plus an explicit UNAVAILABLE marker. To stop the independent collector as well, set `enabled=false`. Code rollback uses the saved v89 bundle (local `capture-integration/rollback-v89.json`); original bundle SHA is `ae8742095256da88ceef4f0e337f2df9c4954229a760ae66b76bb2b7ea5dd152`. No trading tables require migration rollback.

Source is retained on the controlled release branch. Main's existing migration-triggered deployment also changes unrelated trading configuration, so this deployment did not invoke that workflow. Source commit, dedicated green CI and the exact live bundle are recorded separately rather than claiming main was updated.
