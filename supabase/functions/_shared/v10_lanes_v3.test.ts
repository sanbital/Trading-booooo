import {
  ATR_BASE_BARS,
  BAR_MS,
  computeLaneFeatures,
  evaluateLane,
  LaneBar,
  MAX_AGGREGATE_NOTIONAL_USDT,
  MAX_CONCURRENT_TOTAL,
  NOTIONAL_USDT_PER_POSITION,
  REQUIRED_BARS,
  SMA_BARS,
  V10_LANES_REVISION,
  V10_LANES_SPEC_SHA256,
} from "./v10_lanes_v3.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function closeEnough(left: number, right: number, tolerance = 1e-10): boolean {
  return Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

Deno.test("golden feature decisions remain exact", async () => {
  const url = new URL("./v10_lanes.golden.v3.json", import.meta.url);
  const fixture = JSON.parse(await Deno.readTextFile(url)) as {
    revision: string;
    specSha256: string;
    fixtures: Array<{
      name: string;
      features: Parameters<typeof evaluateLane>[0];
      expected: Record<string, unknown>;
    }>;
  };
  assert(fixture.revision === V10_LANES_REVISION, "golden revision drift");
  assert(fixture.specSha256 === V10_LANES_SPEC_SHA256, "golden spec drift");
  for (const row of fixture.fixtures) {
    const actual = evaluateLane(row.features);
    for (const [key, value] of Object.entries(row.expected)) {
      assert((actual as unknown as Record<string, unknown>)[key] === value, `${row.name}:${key}`);
    }
  }
});

function syntheticBars(count: number, quoteVolume = 1_000_000): LaneBar[] {
  const start = Date.UTC(2020, 0, 1);
  const bars: LaneBar[] = [];
  for (let index = 0; index < count; index += 1) {
    const center = 100 + 0.004 * index + 0.8 * Math.sin(index / 19);
    const open = center - 0.05 * Math.sin(index / 7);
    const close = center + 0.05 * Math.cos(index / 11);
    bars.push({
      openTime: start + index * BAR_MS,
      open,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      close,
      quoteVolume,
    });
  }
  return bars;
}

Deno.test("lookbacks are time-correct and current ATR is excluded from baseline", () => {
  assert(SMA_BARS === 80, "20-hour SMA must be 80 x 15m bars");
  assert(ATR_BASE_BARS === 2880, "30-day ATR baseline must be 2880 x 15m bars");
  const normal = syntheticBars(REQUIRED_BARS + 20);
  const btc = syntheticBars(REQUIRED_BARS + 20, 2_000_000);
  const normalFeature = computeLaneFeatures("ETHUSDT", normal, btc);

  const shocked = normal.map((bar) => ({ ...bar }));
  const last = shocked[shocked.length - 1];
  last.high += 20;
  last.low -= 20;
  const shockedFeature = computeLaneFeatures("ETHUSDT", shocked, btc);

  assert(closeEnough(normalFeature.atrBaseline, shockedFeature.atrBaseline), "current bar leaked into ATR baseline");
  assert(shockedFeature.atr > normalFeature.atr, "current volatility shock did not affect current ATR");
  assert(shockedFeature.atrRatio > normalFeature.atrRatio, "current volatility shock did not affect ATR ratio");
});

Deno.test("bar gaps fail closed", () => {
  const asset = syntheticBars(REQUIRED_BARS + 20);
  const btc = syntheticBars(REQUIRED_BARS + 20, 2_000_000);
  asset[asset.length - 100].openTime += BAR_MS;
  let failed = false;
  try {
    computeLaneFeatures("ETHUSDT", asset, btc);
  } catch {
    failed = true;
  }
  assert(failed, "gap was not rejected");
});

Deno.test("portfolio sizing is bounded to the predeclared aggregate exposure", () => {
  assert(MAX_CONCURRENT_TOTAL === 10, "unexpected capacity");
  assert(NOTIONAL_USDT_PER_POSITION === 8, "unexpected per-position notional");
  assert(MAX_CONCURRENT_TOTAL * NOTIONAL_USDT_PER_POSITION === MAX_AGGREGATE_NOTIONAL_USDT, "aggregate exposure mismatch");
});
