from pathlib import Path


def replace_once(path: str, old: str, new: str, marker: str | None = None) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count == 1:
        target.write_text(text.replace(old, new))
        return
    if count == 0 and (marker or new) in text:
        return
    raise SystemExit(f"{path}: expected one old block or applied marker; count={count}")


engine_test = "supabase/functions/market-scanner/engine.test.ts"
replace_once(
    engine_test,
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
    '''Deno.test("dynamic orderflow requires a full 45-second observation window", () => {
  const start = 1_800_100_000_000;
  const evaluate = (intervalMs: number) => {
    const frames = dynamicFrames("absorption").slice(0, 31).map((snapshot, index) => ({
      ...snapshot,
      timestamp: start + index * intervalMs,
    }));
    const flow = dynamicTrades("absorption").slice(0, 31).map((trade, index) => ({
      ...trade,
      timestamp: start + index * intervalMs,
      trade_timestamp: start + index * intervalMs,
    }));
    return computeDynamicOrderflow(frames, flow, 0.1);
  };

  const short = evaluate(1_400);
  assert(short.observation_ms < 45_000);
  assert(short.distinct_book_updates >= 25);
  assert(short.aligned_trade_count >= 20);
  assert(!short.sufficient);

  const complete = evaluate(1_500);
  assert(complete.observation_ms >= 45_000);
  assert(complete.distinct_book_updates >= 25);
  assert(complete.aligned_trade_count >= 20);
  assert(complete.phase_consistent);
  assert(complete.sufficient);
});''',
    'slice(0, 31)',
)

momentum_test = "supabase/functions/_shared/lob/momentum-continuation.test.ts"
replace_once(
    momentum_test,
    "    observationMs: 30000,",
    "    observationMs: 45000,",
)

for path, marker in {
    engine_test: "slice(0, 31)",
    momentum_test: "observationMs: 45000",
}.items():
    if marker not in Path(path).read_text():
        raise SystemExit(f"{path}: missing verification marker {marker!r}")
