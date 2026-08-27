from pathlib import Path

ROOT = Path('.')
MODULE = ROOT / 'supabase/functions/market-autotrader/p10-entry-reconciliation.ts'
TEST = ROOT / 'supabase/functions/market-autotrader/p10-entry-reconciliation.test.ts'
INDEX = ROOT / 'supabase/functions/market-autotrader/index.ts'
OWNERSHIP_TEST = ROOT / 'supabase/functions/market-autotrader/p10-entry-latch-ownership.test.ts'
CANON = ROOT / 'supabase/migrations/20260826094500_p10_entry_reconciliation_invariants.sql'
HARDEN = ROOT / 'supabase/migrations/20260827001000_p10_entry_latch_evidence_guard.sql'
DEPLOY = ROOT / '.github/workflows/deploy-market-autotrader-v707.yml'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 anchor, found {count}')
    return text.replace(old, new, 1)


# 1) Shared pre-order classifier.
text = MODULE.read_text()
if 'export type P10PreOrderEntryDisposition' not in text:
    anchor = """const finite = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

"""
    addition = """export type P10PreOrderEntryDisposition =
  | { kind: \"POLICY_BLOCK\"; reason: string }
  | { kind: \"PREORDER_ERROR\"; reason: string };

const P10_ENTRY_BLOCK_PATTERN = /P10_ENTRY_BLOCKED:[A-Z0-9_.:+-]+/i;

/**
 * A database policy rejection happens before any exchange order is submitted. It must
 * never be promoted into entry-result uncertainty or a global reconciliation latch.
 */
export function p10PreOrderEntryDisposition(error: unknown): P10PreOrderEntryDisposition {
  const message = error instanceof Error ? error.message : String(error ?? \"\");
  const match = message.match(P10_ENTRY_BLOCK_PATTERN);
  return match
    ? { kind: \"POLICY_BLOCK\", reason: match[0] }
    : { kind: \"PREORDER_ERROR\", reason: message };
}

"""
    text = replace_once(text, anchor, anchor + addition, 'module classifier')
    MODULE.write_text(text)


# 2) Unit tests for generic policy-prefix classification.
text = TEST.read_text()
if 'p10PreOrderEntryDisposition,' not in text:
    text = replace_once(
        text,
        """  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
""",
        """  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  p10PreOrderEntryDisposition,
""",
        'test import',
    )
if 'pre-order anti-chase DB rejection is a routine policy block' not in text:
    text += '''

Deno.test("pre-order anti-chase DB rejection is a routine policy block", () => {
  assertEquals(
    p10PreOrderEntryDisposition(
      'database 400: {"code":"P0001","message":"P10_ENTRY_BLOCKED:LONG_OVERBOUGHT_RSI:70.69"}',
    ),
    { kind: "POLICY_BLOCK", reason: "P10_ENTRY_BLOCKED:LONG_OVERBOUGHT_RSI:70.69" },
  );
});

Deno.test("all canonical P10 entry-block reasons classify without enumerating each guard", () => {
  assertEquals(
    p10PreOrderEntryDisposition(
      "P10_ENTRY_BLOCKED:SHORT_OPPOSING_MARKET_FORECAST:STRONG_BULL",
    ),
    {
      kind: "POLICY_BLOCK",
      reason: "P10_ENTRY_BLOCKED:SHORT_OPPOSING_MARKET_FORECAST:STRONG_BULL",
    },
  );
  assertEquals(
    p10PreOrderEntryDisposition("P10_ENTRY_BLOCKED:MARKET_OBSERVATION_UNAVAILABLE"),
    { kind: "POLICY_BLOCK", reason: "P10_ENTRY_BLOCKED:MARKET_OBSERVATION_UNAVAILABLE" },
  );
});

Deno.test("ordinary pre-order failure is not mislabeled as policy or reconciliation", () => {
  assertEquals(
    p10PreOrderEntryDisposition("database 500: connection unavailable"),
    { kind: "PREORDER_ERROR", reason: "database 500: connection unavailable" },
  );
});

Deno.test("post-submit lookup ambiguity is not a pre-order policy block", () => {
  assertEquals(
    p10PreOrderEntryDisposition("Order does not exist."),
    { kind: "PREORDER_ERROR", reason: "Order does not exist." },
  );
});
'''
TEST.write_text(text)


# 3) Executor ownership: routine DB policy rejections terminate before order creation.
text = INDEX.read_text()
if 'p10PreOrderEntryDisposition,' not in text:
    text = replace_once(
        text,
        """  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  summarizeP10LinkedEntryFills,
""",
        """  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  p10PreOrderEntryDisposition,
  summarizeP10LinkedEntryFills,
""",
        'index import',
    )

if 'P10_ENTRY_POLICY_BLOCK_EVENT_FAILED' not in text:
    old = """  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rejectP10Claim(claimId, message);
    throw error;
  }
  await patch(\"p10_signal_claims\", `id=eq.${claimId}`, {
"""
    new = """  } catch (error) {
    const disposition = p10PreOrderEntryDisposition(error);
    await rejectP10Claim(claimId, disposition.reason);
    if (disposition.kind === \"POLICY_BLOCK\") {
      try {
        await event(\"P10_ENTRY_POLICY_BLOCK\", disposition.reason, {
          strategy_key: P10_STRATEGY_KEY,
          venue: signal.venue,
          market: signal.market,
          side,
          signal_time: signal.signal_time,
          order_submitted: false,
        }, { cycleId, level: \"INFO\" });
      } catch (eventError) {
        console.error(\"P10_ENTRY_POLICY_BLOCK_EVENT_FAILED\", eventError);
      }
      return {
        entered: false,
        exchange,
        market: signal.market,
        side,
        policy_blocked: true,
        reason: disposition.reason,
      };
    }
    throw error;
  }
  await patch(\"p10_signal_claims\", `id=eq.${claimId}`, {
"""
    text = replace_once(text, old, new, 'position insert catch')

# Remove reconciliation ownership from the scan-level catch only.
legacy = 'P10 entry failed and safety latch could not be persisted'
if legacy in text:
    marker = text.index(legacy)
    start = text.rfind('    } catch (error) {\n', 0, marker)
    heartbeat = text.find('  const heartbeatAt', marker)
    if start < 0 or heartbeat < 0:
        raise SystemExit('scan catch boundaries not found')
    block_end = text.rfind('    }\n', marker, heartbeat)
    if block_end < 0:
        raise SystemExit('scan catch closing brace not found')
    block_end += len('    }\n')
    replacement = """    } catch (error) {
      const disposition = p10PreOrderEntryDisposition(error);
      if (disposition.kind === \"POLICY_BLOCK\") {
        entries.push({
          entered: false,
          exchange,
          market: signal.market,
          side: signal.side,
          policy_blocked: true,
          reason: disposition.reason,
        });
        try {
          await event(\"P10_ENTRY_POLICY_BLOCK\", disposition.reason, {
            strategy_key: P10_STRATEGY_KEY,
            venue: signal.venue,
            market: signal.market,
            side: signal.side,
            signal_time: signal.signal_time,
            order_submitted: false,
            caught_at: \"P10_SCAN\",
          }, { cycleId, level: \"INFO\" });
        } catch (eventError) {
          console.error(\"P10_ENTRY_POLICY_BLOCK_EVENT_FAILED\", eventError);
        }
        continue;
      }
      entries.push({
        entered: false,
        exchange,
        market: signal.market,
        side: signal.side,
        pre_order_error: true,
        error: disposition.reason,
      });
      try {
        await event(\"P10_ENTRY_PREORDER_ERROR\", disposition.reason, {
          strategy_key: P10_STRATEGY_KEY,
          venue: signal.venue,
          market: signal.market,
          side: signal.side,
          signal_time: signal.signal_time,
          order_submitted: false,
        }, { cycleId, level: \"CRITICAL\" });
      } catch (eventError) {
        console.error(\"P10_ENTRY_PREORDER_ERROR_EVENT_FAILED\", eventError);
      }
      // Only enterP10Signal owns post-submit reconciliation. This catch has no durable
      // proof that an exchange order was sent, so it must never globally latch entries.
      break;
    }
"""
    text = text[:start] + replacement + text[block_end:]

if 'const routinePolicyOnly =' not in text:
    text = replace_once(
        text,
        """  await event(
    \"P10_SCAN_SUMMARY\",
""",
        """  const routinePolicyOnly = entries.length > 0 &&
    entries.every((row) => row.policy_blocked === true || row.reason === \"signal already claimed\");
  await event(
    \"P10_SCAN_SUMMARY\",
""",
        'scan summary prefix',
    )
    text = replace_once(
        text,
        """    { cycleId, level: entries.some((row) => row.entered || row.reserved) ? \"INFO\" : \"WARNING\" },
""",
        """    {
      cycleId,
      level: entries.some((row) => row.entered || row.reserved) || routinePolicyOnly
        ? \"INFO\"
        : \"WARNING\",
    },
""",
        'scan summary level',
    )
INDEX.write_text(text)


# 4) DB defense in depth: reconciliation latch requires durable order/execution evidence.
text = CANON.read_text()
if 'NO_ENTRY_RECONCILIATION_EVIDENCE' not in text:
    fn_start = text.index('create or replace function public.latch_p10_entry_safety')
    fn_end = text.index('\n$function$;', fn_start)
    anchor = '  v_next_lock := case\n'
    anchor_idx = text.index(anchor, fn_start, fn_end)
    guard = """  -- Defense in depth: reconciliation means an exchange submission may have an unknown
  -- result. A pre-order policy/validation failure has no durable entry order and cannot
  -- pause every venue. Persistent post-submit ambiguity still latches exactly as before.
  if v_reason = 'P10_ENTRY_RECONCILIATION_REQUIRED'
     and not exists (
       select 1
       from public.trading_orders o
       join public.trading_positions p on p.id = o.position_id
       where p.strategy_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
         and coalesce(p.is_paper, false) is false
         and upper(coalesce(o.purpose, '')) = 'ENTRY'
         and (
           (
             p.state in (
               'ENTRY_PENDING', 'RECONCILING', 'RECONCILIATION_FAILED',
               'MANUAL_INTERVENTION_REQUIRED'
             )
             and o.state in (
               'REQUESTED', 'UNKNOWN', 'EXCHANGE_OPEN', 'EXCHANGE_PARTIAL',
               'EXCHANGE_DONE', 'EXCHANGE_PARTIAL_CANCELLED'
             )
           )
           or coalesce(o.executed_volume, 0) > 0
           or exists (
             select 1 from public.exchange_trade_fills f
             where f.bot_order_id = o.id and coalesce(f.quantity, 0) > 0
           )
           or exists (
             select 1 from public.trading_fills f
             where f.order_id = o.id and coalesce(f.volume, 0) > 0
           )
         )
     ) then
    return jsonb_build_object(
      'changed', false,
      'deferred', true,
      'defer_reason', 'NO_ENTRY_RECONCILIATION_EVIDENCE',
      'settings', to_jsonb(v_before)
    );
  end if;

"""
    text = text[:anchor_idx] + guard + text[anchor_idx:]
    CANON.write_text(text)

canonical = CANON.read_text()
fn_start = canonical.index('create or replace function public.latch_p10_entry_safety')
fn_end = canonical.index('\n$function$;', fn_start) + len('\n$function$;')
HARDEN.write_text(
    '-- P10 reconciliation latch ownership hardening.\n'
    '-- Canonical replay carries the same definition so later deploys cannot regress it.\n\n'
    + canonical[fn_start:fn_end]
    + '\n'
)


# 5) Source-ownership regression test.
OWNERSHIP_TEST.write_text('''import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const entryStart = source.indexOf("async function enterP10Signal(");
const scanStart = source.indexOf("async function p10ScanCycle(");
const scanEnd = source.indexOf("async function p10FetchJson(");

Deno.test("scan-level entry catch never owns post-submit reconciliation latch", () => {
  assert(entryStart >= 0 && scanStart > entryStart && scanEnd > scanStart);
  const scanSource = source.slice(scanStart, scanEnd);
  assertEquals(
    scanSource.includes('latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED")'),
    false,
  );
  assert(scanSource.includes("P10_ENTRY_PREORDER_ERROR"));
  assert(scanSource.includes("P10_ENTRY_POLICY_BLOCK"));
});

Deno.test("post-submit entry path retains reconciliation latch ownership", () => {
  const entrySource = source.slice(entryStart, scanStart);
  const needle = 'latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED")';
  const count = entrySource.split(needle).length - 1;
  assert(count >= 2, `expected at least two post-submit reconciliation latch paths, got ${count}`);
  assert(entrySource.includes("p10EntryFailureDisposition"));
  assert(entrySource.includes("p10EntryOrderDisposition"));
});
''')


# 6) Make official production validation enforce ownership forever.
text = DEPLOY.read_text()
if 'p10-entry-latch-ownership.test.ts' not in text:
    text = replace_once(
        text,
        """            supabase/functions/market-autotrader/p10-entry-reconciliation.test.ts \\
            supabase/functions/market-autotrader/emergency-liquidation-safety.test.ts \\
""",
        """            supabase/functions/market-autotrader/p10-entry-reconciliation.test.ts \\
            supabase/functions/market-autotrader/p10-entry-latch-ownership.test.ts \\
            supabase/functions/market-autotrader/emergency-liquidation-safety.test.ts \\
""",
        'deploy fmt list',
    )
    text = replace_once(
        text,
        """          deno test supabase/functions/market-autotrader/p10-entry-reconciliation.test.ts
""",
        """          deno test supabase/functions/market-autotrader/p10-entry-reconciliation.test.ts
          deno test --allow-read \\
            supabase/functions/market-autotrader/p10-entry-latch-ownership.test.ts
""",
        'deploy test command',
    )
DEPLOY.write_text(text)

print('patch prepared')
