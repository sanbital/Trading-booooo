from pathlib import Path

RELEASE = "7.1.1-LOB-45S-PROFIT-OR-5PCT"
CACHE_RELEASE = "7.1.1-r1-LOB-45S-PROFIT-OR-5PCT"


def replace_required(path: str, old: str, new: str, marker: str | None = None) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count == 1:
        target.write_text(text.replace(old, new))
        return
    if count == 0 and (marker or new) in text:
        return
    raise SystemExit(f"{path}: expected one old block or aligned marker; count={count}")


engine_test = "supabase/functions/market-scanner/engine.test.ts"
replace_required(
    engine_test,
    '''Deno.test("dynamic orderflow requires a full 30-second observation window", () => {
  const start = 1_800_100_000_000;
  const evaluate = (intervalMs: number) => {
    const frames = dynamicFrames("absorption").slice(0, 12).map((snapshot, index) => ({
      ...snapshot,
      timestamp: start + index * intervalMs,
    }));
    const flow = dynamicTrades("absorption").slice(0, 12).map((trade, index) => ({
      ...trade,
      timestamp: start + index * intervalMs,
      trade_timestamp: start + index * intervalMs,
    }));
    return computeDynamicOrderflow(frames, flow, 0.1);
  };

  const short = evaluate(2_700);
  assert(short.observation_ms < 30_000);
  assert(short.distinct_book_updates >= 12);
  assert(short.aligned_trade_count >= 8);
  assert(!short.sufficient);

  const complete = evaluate(2_800);
  assert(complete.observation_ms >= 30_000);
  assert(complete.phase_consistent);
  assert(complete.sufficient);
});''',
    '''Deno.test("dynamic orderflow requires a full 45-second observation window", () => {
  const start = 1_800_100_000_000;
  const evaluate = (intervalMs: number) => {
    const frames = dynamicFrames("absorption").slice(0, 12).map((snapshot, index) => ({
      ...snapshot,
      timestamp: start + index * intervalMs,
    }));
    const flow = dynamicTrades("absorption").slice(0, 12).map((trade, index) => ({
      ...trade,
      timestamp: start + index * intervalMs,
      trade_timestamp: start + index * intervalMs,
    }));
    return computeDynamicOrderflow(frames, flow, 0.1);
  };

  const short = evaluate(4_000);
  assert(short.observation_ms < 45_000);
  assert(short.distinct_book_updates >= 12);
  assert(short.aligned_trade_count >= 8);
  assert(!short.sufficient);

  const complete = evaluate(4_100);
  assert(complete.observation_ms >= 45_000);
  assert(complete.phase_consistent);
  assert(complete.sufficient);
});''',
    "full 45-second observation window",
)

lob_test = "supabase/functions/_shared/lob/lob.test.ts"
replace_required(lob_test, "  observationMs: 30000,", "  observationMs: 45000,")
replace_required(
    lob_test,
    '''test("a live entry requires the complete 30-second observation", () => {
  const short = evaluateLobEntry({ ...hot, observationMs: 29999 }, costs);
  assert(short.decision !== "BUY", "29.999 seconds must not be eligible");
  assert(
    short.reasons.includes("INSUFFICIENT_OBSERVATION_WINDOW"),
    "short observation reason must be explicit",
  );
  assert(
    evaluateLobEntry({ ...hot, observationMs: 30000 }, costs).decision === "BUY",
    "30 seconds must remain eligible",
  );
});''',
    '''test("a live entry requires the complete 45-second observation", () => {
  const short = evaluateLobEntry({ ...hot, observationMs: 44999 }, costs);
  assert(short.decision !== "BUY", "44.999 seconds must not be eligible");
  assert(
    short.reasons.includes("INSUFFICIENT_OBSERVATION_WINDOW"),
    "short observation reason must be explicit",
  );
  assert(
    evaluateLobEntry({ ...hot, observationMs: 45000 }, costs).decision === "BUY",
    "45 seconds must remain eligible",
  );
});''',
    "complete 45-second observation",
)
replace_required(
    lob_test,
    '''    bidDepthRatio: 0.8,
    minBidDepthRatio: 0.3,
  });
  assert(decision.reason === "SIGNAL_REVERSAL", "signal reversal priority must fire");''',
    '''    bidDepthRatio: 0.8,
    minBidDepthRatio: 0.3,
    softExitConfirmations: 1,
  });
  assert(decision.reason === "SIGNAL_REVERSAL", "confirmed signal reversal priority must fire");''',
    "confirmed signal reversal priority",
)

momentum_test = "supabase/functions/_shared/lob/momentum-continuation.test.ts"
replace_required(
    momentum_test,
    "  assertEquals(decision.maxHoldingSeconds, 90);",
    "  assertEquals(decision.maxHoldingSeconds, 180);",
)
replace_required(
    momentum_test,
    "  assert(decision.maxHoldingSeconds !== 90 || decision.decision !== \"BUY\");",
    "  assert(decision.maxHoldingSeconds !== 180 || decision.decision !== \"BUY\");",
)

v512_test = "supabase/functions/_shared/scalp/v512-invariants.test.ts"
replace_required(
    v512_test,
    '''Deno.test("SCALP monitoring preserves the profile TIMEOUT before and after TP cancellation", async () => {
  const code = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  const calls = [...code.matchAll(/decideExit\\([^;]+\\);/g)].map((m) => m[0]);
  assert(calls.length >= 2);
  for (const call of calls) assert(/,\\s*true,\\s*\\);$/.test(call), call);
});''',
    '''Deno.test("legacy SCALP preserves TIMEOUT while LOB disables clock exits", async () => {
  const code = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  const calls = [...code.matchAll(/decideExit\\([^;]+\\);/g)].map((m) => m[0]);
  assert(calls.length >= 2);
  assert(calls.some((call) => /,\\s*!lobMode,\\s*\\);$/.test(call)), "LOB call must disable time exit");
  assert(calls.some((call) => /,\\s*true,\\s*\\);$/.test(call)), "legacy recheck keeps TIMEOUT");
});''',
    "LOB call must disable time exit",
)

gateway = "gateway/server.mjs"
replace_required(
    gateway,
    'const VERSION = "7.0.5-LOB-30S-MINIMUM";',
    f'const VERSION = "{RELEASE}";',
)
replace_required(
    gateway,
    "// Trading-booooo v6.1.0-HEAT static-egress spot order gateway.",
    f"// Trading-booooo v{RELEASE} static-egress spot order gateway.",
)

dashboard = "docs/index.html"
text = Path(dashboard).read_text()
if "7.0.5-r1-LOB-30S-MINIMUM" in text:
    text = text.replace("7.0.5-r1-LOB-30S-MINIMUM", CACHE_RELEASE)
if "v7.0.5-LOB-30S-MINIMUM" in text:
    text = text.replace("v7.0.5-LOB-30S-MINIMUM", f"v{RELEASE}")
if CACHE_RELEASE not in text or f"SPOT · v{RELEASE}" not in text:
    raise SystemExit(f"{dashboard}: dashboard release markers are not aligned")
Path(dashboard).write_text(text)

version_test = "supabase/functions/_shared/scalp/version.test.ts"
replace_required(
    version_test,
    '''    html.includes("config.js?v=7.0.5-r1-LOB-30S-MINIMUM") &&
      html.includes("app.js?v=7.0.5-r1-LOB-30S-MINIMUM"),''',
    f'''    html.includes("config.js?v={CACHE_RELEASE}") &&
      html.includes("app.js?v={CACHE_RELEASE}"),''',
    CACHE_RELEASE,
)

for path, marker in {
    engine_test: "full 45-second observation window",
    lob_test: "complete 45-second observation",
    momentum_test: "maxHoldingSeconds, 180",
    v512_test: "LOB call must disable time exit",
    gateway: RELEASE,
    dashboard: f"SPOT · v{RELEASE}",
    version_test: CACHE_RELEASE,
}.items():
    if marker not in Path(path).read_text():
        raise SystemExit(f"{path}: missing aligned marker {marker!r}")
