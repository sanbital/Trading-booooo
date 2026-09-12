export type JsonRecord = Record<string, unknown>;

export type LifecycleQuality =
  | "FILL_VERIFIED"
  | "ENTRY_FILL_MISSING"
  | "EXIT_FILL_MISSING"
  | "TIME_REVERSED";

export type LifecycleTimes = {
  quality: LifecycleQuality;
  entryAt: string | null;
  exitAt: string | null;
  durationSeconds: number | null;
  entryFillCount: number;
  exitFillCount: number;
};

function timestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function positiveNumber(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function executableFills(rows: JsonRecord[]): JsonRecord[] {
  return rows.filter((row) => {
    if (timestampMs(row.executed_at) === null) return false;
    return positiveNumber(row.volume) || positiveNumber(row.funds_quote);
  });
}

export function earliestExecutedAt(rows: JsonRecord[]): string | null {
  let earliest: number | null = null;
  for (const row of executableFills(rows)) {
    const ms = timestampMs(row.executed_at);
    if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

export function latestExecutedAt(rows: JsonRecord[]): string | null {
  let latest: number | null = null;
  for (const row of executableFills(rows)) {
    const ms = timestampMs(row.executed_at);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function resolveLifecycleTimes(input: {
  state: unknown;
  entryFills: JsonRecord[];
  exitFills: JsonRecord[];
  nowMs?: number;
}): LifecycleTimes {
  const entryRows = executableFills(input.entryFills);
  const exitRows = executableFills(input.exitFills);
  const entryAt = earliestExecutedAt(entryRows);
  const closed = String(input.state || "").toUpperCase() === "CLOSED";
  const exitAt = closed ? latestExecutedAt(exitRows) : null;

  if (!entryAt) {
    return {
      quality: "ENTRY_FILL_MISSING",
      entryAt: null,
      exitAt,
      durationSeconds: null,
      entryFillCount: entryRows.length,
      exitFillCount: exitRows.length,
    };
  }

  if (closed && !exitAt) {
    return {
      quality: "EXIT_FILL_MISSING",
      entryAt,
      exitAt: null,
      durationSeconds: null,
      entryFillCount: entryRows.length,
      exitFillCount: exitRows.length,
    };
  }

  const entryMs = timestampMs(entryAt)!;
  const endMs = closed ? timestampMs(exitAt)! : (input.nowMs ?? Date.now());
  if (!Number.isFinite(endMs) || endMs < entryMs) {
    return {
      quality: "TIME_REVERSED",
      entryAt,
      exitAt,
      durationSeconds: null,
      entryFillCount: entryRows.length,
      exitFillCount: exitRows.length,
    };
  }

  return {
    quality: "FILL_VERIFIED",
    entryAt,
    exitAt,
    durationSeconds: Math.max(0, Math.round((endMs - entryMs) / 1000)),
    entryFillCount: entryRows.length,
    exitFillCount: exitRows.length,
  };
}
