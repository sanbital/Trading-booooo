export type LobSearchExpansion = {
  enabled: boolean;
  reason: "NORMAL" | "SEARCH_FAILURE" | "STALE_STATE" | "UNAVAILABLE";
  failureStreak: number;
  baseFinalists: number;
  finalistLimit: number;
  observationMs: number;
  rotationPool: number;
  rotationMinutes: number;
  evaluatedAt: string | null;
  thresholdsRelaxed: false;
};

type SearchSettingsRow = {
  lob_search_failure?: boolean;
  lob_search_failure_streak?: number | string;
  lob_search_last_evaluated_at?: string | null;
  lob_search_expand_enabled?: boolean;
  lob_search_base_finalists?: number | string;
  lob_search_max_finalists?: number | string;
  lob_search_base_observation_ms?: number | string;
  lob_search_max_observation_ms?: number | string;
  lob_search_rotation_pool?: number | string;
  lob_search_rotation_minutes?: number | string;
  lob_search_state_fresh_minutes?: number | string;
};

/** Exact field contract emitted by rankMarketHeat(). */
export type LobRankedSearchRow = {
  market: string;
  rank?: number;
  heatScore?: number;
  recentNotionalPerSecond?: number;
  previousNotionalPerSecond?: number;
  notionalAcceleration?: number;
  tradeCountPerSecond?: number;
  turnover24hQuote?: number;
  change24hPct?: number;
  range24hPct?: number;
};

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function defaults(reason: LobSearchExpansion["reason"] = "UNAVAILABLE"): LobSearchExpansion {
  return {
    enabled: false,
    reason,
    failureStreak: 0,
    baseFinalists: 12,
    finalistLimit: 12,
    observationMs: 32000,
    rotationPool: 48,
    rotationMinutes: 1,
    evaluatedAt: null,
    thresholdsRelaxed: false,
  };
}

export async function loadLobSearchExpansion(nowMs = Date.now()): Promise<LobSearchExpansion> {
  const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!url || !key) return defaults();

  try {
    const select = [
      "lob_search_failure",
      "lob_search_failure_streak",
      "lob_search_last_evaluated_at",
      "lob_search_expand_enabled",
      "lob_search_base_finalists",
      "lob_search_max_finalists",
      "lob_search_base_observation_ms",
      "lob_search_max_observation_ms",
      "lob_search_rotation_pool",
      "lob_search_rotation_minutes",
      "lob_search_state_fresh_minutes",
    ].join(",");
    const response = await fetch(
      `${url}/rest/v1/trading_settings?id=eq.1&select=${encodeURIComponent(select)}&limit=1`,
      {
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(1500),
      },
    );
    if (!response.ok) return defaults();
    const row = (await response.json())?.[0] as SearchSettingsRow | undefined;
    if (!row) return defaults();

    const baseFinalists = Math.round(clamp(finite(row.lob_search_base_finalists, 12), 4, 20));
    const maxFinalists = Math.round(clamp(finite(row.lob_search_max_finalists, 20), baseFinalists, 20));
    const baseObservation = Math.round(
      clamp(finite(row.lob_search_base_observation_ms, 32000), 32000, 60000),
    );
    const maxObservation = Math.round(
      clamp(finite(row.lob_search_max_observation_ms, 60000), baseObservation, 60000),
    );
    const failureStreak = Math.max(0, Math.floor(finite(row.lob_search_failure_streak, 0)));
    const rotationPool = Math.round(clamp(finite(row.lob_search_rotation_pool, 48), maxFinalists, 120));
    const rotationMinutes = Math.round(clamp(finite(row.lob_search_rotation_minutes, 1), 1, 30));
    const freshMinutes = clamp(finite(row.lob_search_state_fresh_minutes, 20), 5, 120);
    const evaluatedAtMs = Date.parse(String(row.lob_search_last_evaluated_at || ""));
    const stateFresh = Number.isFinite(evaluatedAtMs) && Math.max(0, nowMs - evaluatedAtMs) <= freshMinutes * 60_000;
    const requested = row.lob_search_expand_enabled !== false && row.lob_search_failure === true;

    if (!requested) {
      return {
        ...defaults("NORMAL"), failureStreak, baseFinalists, finalistLimit: baseFinalists,
        observationMs: baseObservation, rotationPool, rotationMinutes,
        evaluatedAt: row.lob_search_last_evaluated_at || null,
      };
    }
    if (!stateFresh) {
      return {
        ...defaults("STALE_STATE"), failureStreak, baseFinalists, finalistLimit: baseFinalists,
        observationMs: baseObservation, rotationPool, rotationMinutes,
        evaluatedAt: row.lob_search_last_evaluated_at || null,
      };
    }

    const finalistLimit = Math.min(
      maxFinalists,
      baseFinalists + Math.min(maxFinalists - baseFinalists, 4 + failureStreak * 2),
    );
    const observationMs = Math.min(
      maxObservation,
      baseObservation + Math.min(maxObservation - baseObservation, 1000 + failureStreak * 1000),
    );
    return {
      enabled: true,
      reason: "SEARCH_FAILURE",
      failureStreak,
      baseFinalists,
      finalistLimit,
      observationMs,
      rotationPool,
      rotationMinutes,
      evaluatedAt: row.lob_search_last_evaluated_at || null,
      thresholdsRelaxed: false,
    };
  } catch {
    return defaults();
  }
}

export function selectLobSearchRows<T>(rows: T[], expansion: LobSearchExpansion, nowMs = Date.now()): T[] {
  const source = Array.isArray(rows) ? rows : [];
  const baseCount = Math.min(source.length, expansion.baseFinalists);
  const core = source.slice(0, baseCount);
  if (!expansion.enabled || expansion.finalistLimit <= baseCount) return core;
  const extraCount = Math.min(expansion.finalistLimit - baseCount, source.length - baseCount);
  if (extraCount <= 0) return core;
  const tailEnd = Math.min(source.length, baseCount + expansion.rotationPool);
  const tail = source.slice(baseCount, tailEnd);
  if (tail.length <= extraCount) return [...core, ...tail];
  const bucketMs = Math.max(1, expansion.rotationMinutes) * 60_000;
  const bucket = Math.floor(nowMs / bucketMs);
  const offset = (bucket * extraCount) % tail.length;
  return [...core, ...Array.from({ length: extraCount }, (_, i) => tail[(offset + i) % tail.length])];
}

/**
 * Allocates websocket observation slots across Heat leaders, current momentum continuations and
 * deep liquid books. It receives MarketHeatScore directly, so camelCase is part of the contract.
 */
export function selectCostAwareLobRows<T extends LobRankedSearchRow>(
  rows: T[],
  expansion: LobSearchExpansion,
  nowMs = Date.now(),
): T[] {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return [];
  const limit = Math.min(source.length, expansion.finalistLimit);
  const liquidityReserve = Math.min(3, Math.max(1, Math.floor(expansion.baseFinalists / 4)));
  const momentumReserve = Math.min(4, Math.max(2, Math.floor(expansion.baseFinalists / 3)));
  const heatCoreCount = Math.max(1, Math.min(limit, expansion.baseFinalists - liquidityReserve - momentumReserve));
  const selected: T[] = [];
  const seen = new Set<string>();
  const add = (row: T | undefined) => {
    if (!row || seen.has(row.market) || selected.length >= limit) return;
    seen.add(row.market);
    selected.push(row);
  };

  source.slice(0, heatCoreCount).forEach(add);

  [...source]
    .filter((row) => finite(row.change24hPct, 0) >= 3 && finite(row.change24hPct, 0) <= 60)
    .sort((left, right) => {
      const score = (row: T) =>
        Math.min(30, finite(row.change24hPct, 0)) * 2 +
        finite(row.notionalAcceleration, 0) * 35 +
        finite(row.heatScore, 0) * 0.25 +
        Math.log10(Math.max(1, finite(row.turnover24hQuote, 0)));
      return score(right) - score(left);
    })
    .forEach((row) => {
      if (selected.length < heatCoreCount + momentumReserve) add(row);
    });

  [...source]
    .sort((left, right) =>
      finite(right.turnover24hQuote, 0) - finite(left.turnover24hQuote, 0) ||
      finite(right.recentNotionalPerSecond, 0) - finite(left.recentNotionalPerSecond, 0)
    )
    .forEach((row) => {
      if (selected.length < heatCoreCount + momentumReserve + liquidityReserve) add(row);
    });

  source.filter((row) => !seen.has(row.market))
    .slice(0, Math.max(0, expansion.baseFinalists - selected.length))
    .forEach(add);
  if (!expansion.enabled || selected.length >= limit) return selected.slice(0, limit);

  const extraCount = limit - selected.length;
  const pool = source
    .slice(heatCoreCount, Math.min(source.length, heatCoreCount + expansion.rotationPool))
    .filter((row) => !seen.has(row.market));
  if (pool.length <= extraCount) {
    pool.forEach(add);
    return selected.slice(0, limit);
  }
  const bucketMs = Math.max(1, expansion.rotationMinutes) * 60_000;
  const bucket = Math.floor(nowMs / bucketMs);
  const offset = (bucket * extraCount) % pool.length;
  for (let index = 0; index < extraCount; index++) add(pool[(offset + index) % pool.length]);
  return selected.slice(0, limit);
}
