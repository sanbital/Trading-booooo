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
    observationMs: 8000,
    rotationPool: 48,
    rotationMinutes: 1,
    evaluatedAt: null,
    thresholdsRelaxed: false,
  };
}

/**
 * Reads only search-health and observation-budget settings. A database failure fails back to
 * the normal 12-book/8-second scan; it never changes an economic entry threshold.
 */
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
    const maxFinalists = Math.round(
      clamp(finite(row.lob_search_max_finalists, 20), baseFinalists, 20),
    );
    const baseObservation = Math.round(
      clamp(finite(row.lob_search_base_observation_ms, 8000), 8000, 12000),
    );
    const maxObservation = Math.round(
      clamp(finite(row.lob_search_max_observation_ms, 12000), baseObservation, 12000),
    );
    const failureStreak = Math.max(0, Math.floor(finite(row.lob_search_failure_streak, 0)));
    const rotationPool = Math.round(
      clamp(finite(row.lob_search_rotation_pool, 48), maxFinalists, 120),
    );
    const rotationMinutes = Math.round(
      clamp(finite(row.lob_search_rotation_minutes, 1), 1, 30),
    );
    const freshMinutes = clamp(finite(row.lob_search_state_fresh_minutes, 20), 5, 120);
    const evaluatedAtMs = Date.parse(String(row.lob_search_last_evaluated_at || ""));
    const stateFresh = Number.isFinite(evaluatedAtMs) &&
      Math.max(0, nowMs - evaluatedAtMs) <= freshMinutes * 60_000;
    const requested = row.lob_search_expand_enabled !== false && row.lob_search_failure === true;

    if (!requested) {
      return {
        ...defaults("NORMAL"),
        failureStreak,
        baseFinalists,
        finalistLimit: baseFinalists,
        observationMs: baseObservation,
        rotationPool,
        rotationMinutes,
        evaluatedAt: row.lob_search_last_evaluated_at || null,
      };
    }
    if (!stateFresh) {
      return {
        ...defaults("STALE_STATE"),
        failureStreak,
        baseFinalists,
        finalistLimit: baseFinalists,
        observationMs: baseObservation,
        rotationPool,
        rotationMinutes,
        evaluatedAt: row.lob_search_last_evaluated_at || null,
      };
    }

    // Streak 1: 18 books / 10s. Streak 2+: 20 books / 12s. Only observation breadth changes.
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

/**
 * Always observes the core Heat leaders. Extra websocket slots rotate through the next Heat
 * ranks, so search failure broadens coverage instead of repeating the same rejected books.
 */
export function selectLobSearchRows<T>(
  rows: T[],
  expansion: LobSearchExpansion,
  nowMs = Date.now(),
): T[] {
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
  const rotated = Array.from({ length: extraCount }, (_, index) =>
    tail[(offset + index) % tail.length]
  );
  return [...core, ...rotated];
}
