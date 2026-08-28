import {
  createV5ResearchJob,
  upsertV5MarketResults,
  type V5ResearchJobRow,
  v5ResultConfigKey,
} from "./repository.ts";
import { BAR_MS, type MetricSummary, V5_REVISION } from "./types.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = "2026-08-28T00:00:00.000Z";

function jobRow(revision = V5_REVISION): V5ResearchJobRow {
  return {
    id: JOB_ID,
    revision,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: 120,
    window_start: "2026-04-30T00:00:00.000Z",
    window_end: NOW,
    status: "PENDING",
    cursor: 0,
    total_markets: 2,
    processed_markets: 0,
    failed_markets: 0,
    config: {},
    metrics: {},
    error: null,
    started_at: null,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function repositoryOptions(fetchFn: typeof fetch) {
  return {
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role-secret",
    fetchFn,
    now: () => new Date(NOW),
  };
}

Deno.test("new V5 job locks revision and preserves full-universe quote metadata", async () => {
  const captured: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  } = { url: "", headers: new Headers(), body: {} };
  const created = await createV5ResearchJob(
    {
      markets: [
        { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", onboardDate: 1 },
        { symbol: "BTCUSDC", quoteAsset: "USDC", marginAsset: "USDC", onboardDate: 2 },
      ],
      windowStart: 0,
      windowEnd: 120 * 86_400_000 - BAR_MS,
      config: { candidate_registry_sha256: "abc123", router_revision: "spoofed" },
    },
    repositoryOptions(async (input, init) => {
      captured.url = String(input);
      captured.headers = new Headers(init?.headers);
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify([{ ...jobRow(), config: captured.body.config }]), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  assert(created.revision === V5_REVISION);
  assert(captured.url.endsWith("/rest/v1/v2_research_jobs"));
  assert(captured.headers.get("apikey") === "service-role-secret");
  assert(captured.headers.get("authorization") === "Bearer service-role-secret");
  assert(captured.body.revision === V5_REVISION);
  assert(captured.body.status === "PENDING");
  const config = captured.body.config as Record<string, unknown>;
  assert(config.router_revision === V5_REVISION, "caller must not override locked revision");
  const universe = config.universe as Array<Record<string, unknown>>;
  assert(universe.length === 2);
  assert(universe[1].quoteAsset === "USDC" && universe[1].marginAsset === "USDC");
});

Deno.test("new V5 job rejects caller-supplied existing job id", async () => {
  let failed = false;
  try {
    await createV5ResearchJob({
      id: JOB_ID,
      markets: [{ symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", onboardDate: 1 }],
      windowStart: 0,
      windowEnd: 120 * 86_400_000 - BAR_MS,
    } as never);
  } catch (error) {
    failed = String(error).includes("cannot be supplied");
  }
  assert(failed, "caller-supplied id must be rejected");
});

Deno.test("result upsert rejects a loaded V3/V4 job before writing", async () => {
  let writes = 0;
  let failed = false;
  try {
    await upsertV5MarketResults(
      JOB_ID,
      [],
      repositoryOptions(async (_input, init) => {
        if (init?.method === "POST") writes++;
        return new Response(JSON.stringify([jobRow("REGIME_ROUTER_V4_CONFIRMATION_15M_45D_WF")]), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  } catch (error) {
    failed = String(error).includes("revision mismatch");
  }
  assert(failed, "non-V5 job must fail the revision guard");
  assert(writes === 0, "revision mismatch must not write results");
});

const METRICS: MetricSummary = {
  trades: 3,
  wins: 2,
  losses: 1,
  winRate: 2 / 3,
  grossPnlBps: 42,
  netPnlBps: 20,
  stressNetPnlBps: -7,
  profitFactor: 1.5,
  averageReturnBps: 20 / 3,
  maxDrawdownBps: 12,
  averageMfeBps: 30,
  averageMaeBps: 10,
  mfeCaptureRatio: 0.5,
  profitGivebackBps: 15,
  averageHoldBars: 4,
  stopHitRate: 1 / 3,
  targetHitRate: 1 / 3,
  timeStopRate: 0,
  regimeFrequency: 0.2,
};

Deno.test("V5 results use revision-and-fold keys on research tables only", async () => {
  const requests: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  const count = await upsertV5MarketResults(
    JOB_ID,
    [{
      market: { symbol: "BTCUSDC", quoteAsset: "USDC", marginAsset: "USDC", onboardDate: 2 },
      candidate: {
        name: "RANGE_CYCLE_A",
        family: "RANGE_CYCLE",
        side: "LONG",
        state: "RANGE_UP_CYCLE",
        neighborGroup: "RANGE_A",
        parameters: { stopAtr: 1 },
      },
      fold: 2,
      split: "TEST",
      bars: 500,
      firstBarTime: 0,
      lastBarTime: 499 * BAR_MS,
      metrics: {
        ...METRICS,
        trades: 4,
        wins: 2,
        losses: 2,
        winRate: 0.5,
        averageReturnBps: 5,
        stopHitRate: 0.25,
        targetHitRate: 0.25,
      },
      breakdown: {
        grossProfitBps: 60,
        grossLossBps: 40,
        medianNetBps: 7,
        targetHits: 1,
        stopHits: 1,
        timeExits: 0,
      },
      parameters: {
        exit_reason_counts: { TARGET: 1, STOP: 1, MAX_HOLD: 1, REGIME_EXIT: 1 },
        max_hold_count: 1,
        other_exit_count: 999,
      },
    }],
    repositoryOptions(async (input, init) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body, headers: new Headers(init?.headers) });
      if (method === "GET") {
        return new Response(JSON.stringify([jobRow()]), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 201 });
    }),
  );

  assert(count === 1);
  assert(requests.length === 2 && requests[0].method === "GET" && requests[1].method === "POST");
  assert(requests.every((request) => /v2_research_(jobs|market_results)/.test(request.url)));
  assert(
    !requests.some((request) => /trading_|orders|positions|strategy_registry/.test(request.url)),
  );
  const row = (requests[1].body as Array<Record<string, unknown>>)[0];
  assert(row.revision === V5_REVISION);
  assert(row.config_key === v5ResultConfigKey("RANGE_CYCLE_A", 2));
  assert(String(row.config_key).includes("FOLD_2"));
  assert(row.regime === "RANGE");
  const parameters = row.parameters as Record<string, unknown>;
  const metadata = parameters.market_metadata as Record<string, unknown>;
  assert(metadata.quoteAsset === "USDC" && metadata.marginAsset === "USDC");
  assert(parameters.max_hold_count === 1, "max-hold exits must remain a distinct category");
  assert(parameters.other_exit_count === 1, "non-time strategy exits must not be mislabeled");
  assert(requests[1].headers.get("prefer") === "resolution=merge-duplicates,return=minimal");
});

Deno.test("V5 result upsert rejects invalid max-hold exit counts before writing", async () => {
  for (const maxHoldCount of [-1, 0.5, 3]) {
    let writes = 0;
    let failed = false;
    try {
      await upsertV5MarketResults(
        JOB_ID,
        [{
          market: "BTCUSDT",
          candidate: {
            name: "RANGE_CYCLE_A",
            family: "RANGE_CYCLE",
            side: "LONG",
            state: "RANGE_UP_CYCLE",
            neighborGroup: "RANGE_A",
            parameters: { stopAtr: 1 },
          },
          fold: 0,
          split: "TEST",
          bars: 500,
          firstBarTime: 0,
          lastBarTime: 499 * BAR_MS,
          metrics: METRICS,
          breakdown: {
            grossProfitBps: 60,
            grossLossBps: 40,
            medianNetBps: 7,
            targetHits: 1,
            stopHits: 1,
            timeExits: 0,
          },
          parameters: { max_hold_count: maxHoldCount },
        }],
        repositoryOptions(async (_input, init) => {
          if (init?.method === "POST") writes++;
          return new Response(JSON.stringify([jobRow()]), {
            headers: { "content-type": "application/json" },
          });
        }),
      );
    } catch (error) {
      failed = maxHoldCount === 3
        ? String(error).includes("must not exceed trades")
        : String(error).includes("parameters.max_hold_count must be an integer");
    }
    assert(failed, `invalid max_hold_count ${maxHoldCount} must be rejected`);
    assert(writes === 0, "invalid exit counts must not be written");
  }
});
