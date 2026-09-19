import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export function sha256Hex(bytes) {
  const b = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return createHash("sha256").update(b).digest("hex");
}

export function parseChecksumLine(text, expectedFilename) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    const name = m[2].trim();
    if (!expectedFilename || name === expectedFilename || name.endsWith("/" + expectedFilename)) {
      return { sha256: m[1].toLowerCase(), filename: name };
    }
  }
  throw new Error("CHECKSUM_ENTRY_MISSING:" + expectedFilename);
}

export function verifyChecksumBytes(bytes, checksumText, expectedFilename) {
  const parsed = parseChecksumLine(checksumText, expectedFilename);
  const actual = sha256Hex(bytes);
  if (actual !== parsed.sha256) {
    throw new Error(`CHECKSUM_MISMATCH:${expectedFilename}:${parsed.sha256}:${actual}`);
  }
  return actual;
}

/**
 * Stable dataset digest independent of cache warmth or retrieval order.
 * Each record must represent a verified logical source object.
 */
export function logicalDatasetHash(records) {
  const h = createHash("sha256");
  const normalized = [...records].map((r) => ({
    source: String(r.source),
    sha256: String(r.sha256).toLowerCase(),
  })).sort((a,b) => a.source.localeCompare(b.source) || a.sha256.localeCompare(b.sha256));
  for (const r of normalized) h.update(r.source).update("\0").update(r.sha256).update("\n");
  return h.digest("hex");
}

export function monthSlices(start, end) {
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start)) {
    throw new Error("INVALID_RANGE");
  }
  const out = [];
  let d = new Date(start);
  let cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  while (cursor <= end) {
    const x = new Date(cursor);
    const next = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1);
    out.push({
      month: new Date(cursor).toISOString().slice(0,7),
      start: Math.max(start, cursor),
      end: Math.min(end, next - 1),
    });
    cursor = next;
  }
  return out;
}

function indexByTime(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const t = Number(r?.[0]);
    if (!Number.isSafeInteger(t)) throw new Error("INVALID_KLINE_TIME");
    const prev = m.get(t);
    if (prev && JSON.stringify(prev) !== JSON.stringify(r)) throw new Error("KLINE_CONFLICT:" + t);
    m.set(t, r);
  }
  return m;
}

export function missingTimes(rows, start, end, intervalMs) {
  if (!(Number.isSafeInteger(intervalMs) && intervalMs > 0)) throw new Error("INVALID_INTERVAL");
  const by = indexByTime(rows);
  const first = Math.ceil(start / intervalMs) * intervalMs;
  const last = Math.floor(end / intervalMs) * intervalMs;
  const missing = [];
  for (let t = first; t <= last; t += intervalMs) if (!by.has(t)) missing.push(t);
  return missing;
}

/**
 * Per-month acquisition with daily fallback for every missing expected timestamp.
 * The caller must pass an active range already clipped to the symbol lifecycle.
 */
export async function collectMonthlyWithDailyFallback({
  start, end, intervalMs, loadMonthly, loadDaily,
}) {
  const merged = new Map();
  const diagnostics = [];
  for (const slice of monthSlices(start, end)) {
    const monthly = (await loadMonthly(slice.month, slice.start, slice.end)) || [];
    for (const [t,row] of indexByTime(monthly)) merged.set(t,row);
    const gaps = missingTimes([...merged.values()].filter(r => Number(r[0]) >= slice.start && Number(r[0]) <= slice.end), slice.start, slice.end, intervalMs);
    const days = [...new Set(gaps.map(t => new Date(t).toISOString().slice(0,10)))];
    let dailyRows = 0;
    for (const day of days) {
      const rows = (await loadDaily(day, slice.start, slice.end)) || [];
      dailyRows += rows.length;
      for (const [t,row] of indexByTime(rows)) {
        const prev = merged.get(t);
        if (prev && JSON.stringify(prev) !== JSON.stringify(row)) throw new Error("KLINE_CONFLICT:" + t);
        merged.set(t,row);
      }
    }
    const after = missingTimes([...merged.values()].filter(r => Number(r[0]) >= slice.start && Number(r[0]) <= slice.end), slice.start, slice.end, intervalMs);
    diagnostics.push({month:slice.month, monthlyRows:monthly.length, missingBefore:gaps.length, dailyFallbackDays:days.length, dailyRows, missingAfter:after.length});
  }
  const finalRows = [...merged.values()].filter(r => Number(r[0]) >= start && Number(r[0]) <= end).sort((a,b)=>Number(a[0])-Number(b[0]));
  const finalMissing = missingTimes(finalRows,start,end,intervalMs);
  return { rows: finalRows, diagnostics, complete: finalMissing.length === 0, missing: finalMissing };
}

function finiteFundingRow(x, symbol) {
  return x && (!symbol || x.symbol === symbol) && Number.isSafeInteger(Number(x.fundingTime)) &&
    Number.isFinite(Number(x.fundingRate)) && Number.isFinite(Number(x.markPrice)) && Number(x.markPrice) > 0;
}

/**
 * Fetch actual Binance USD-M funding history. Missing/blocked data is an error,
 * never an implicit zero-cost observation.
 */
export async function fetchFundingHistory({ symbol, startTime, endTime, fetchImpl = fetch, baseUrl = "https://fapi.binance.com" }) {
  if (!symbol || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || endTime < startTime) {
    throw new Error("INVALID_FUNDING_RANGE");
  }
  const out = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const q = new URLSearchParams({symbol,startTime:String(cursor),endTime:String(endTime),limit:"1000"});
    const url = `${baseUrl}/fapi/v1/fundingRate?${q}`;
    const res = await fetchImpl(url,{headers:{"user-agent":"Trading-booooo-v26-validation"}});
    if (!res?.ok) throw new Error(`FUNDING_HTTP_${res?.status ?? "UNKNOWN"}:${symbol}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("FUNDING_RESPONSE_INVALID:" + symbol);
    for (const row of body) {
      if (!finiteFundingRow(row,symbol)) throw new Error("FUNDING_ROW_INVALID:" + symbol);
      out.push(row);
    }
    if (body.length < 1000) break;
    const last = Number(body.at(-1)?.fundingTime);
    if (!Number.isSafeInteger(last) || last < cursor) throw new Error("FUNDING_PAGINATION_STALLED:" + symbol);
    cursor = last + 1;
  }
  return [...new Map(out.map(x=>[Number(x.fundingTime),x])).values()].sort((a,b)=>Number(a.fundingTime)-Number(b.fundingTime));
}

/**
 * Read a connector-enriched funding cache without treating missing coverage as
 * a zero-cost observation. A zero-event answer is valid only when one cache
 * coverage record explicitly spans the requested interval.
 */
export function fundingHistoryFromCache({ cache, symbol, startTime, endTime }) {
  if (!symbol || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || endTime < startTime) {
    throw new Error("INVALID_FUNDING_RANGE");
  }
  const coverage = Array.isArray(cache?.coverage) ? cache.coverage : [];
  const span = coverage.find((x) => x?.symbol === symbol &&
    Number.isSafeInteger(Number(x.startTime)) && Number(x.startTime) <= startTime &&
    Number.isSafeInteger(Number(x.endTime)) && Number(x.endTime) >= endTime);
  if (!span) throw new Error(`FUNDING_CACHE_COVERAGE_MISSING:${symbol}:${startTime}:${endTime}`);
  const events = Array.isArray(span.events) ? span.events : [];
  const out = [];
  for (const row of events) {
    if (!finiteFundingRow(row,symbol)) throw new Error("FUNDING_ROW_INVALID:" + symbol);
    const t = Number(row.fundingTime);
    if (t >= startTime && t <= endTime) out.push(row);
  }
  return [...new Map(out.map((x)=>[Number(x.fundingTime),x])).values()]
    .sort((a,b)=>Number(a.fundingTime)-Number(b.fundingTime));
}

/**
 * Derive the cutoff coverage counters that the validator report must publish.
 * A symbol is evaluated only when every required completed bar immediately
 * preceding the cutoff is present. Conflicting duplicates fail closed.
 */
export function cutoffCoverageSummary({
  cutoffs, expectedByCutoff, rowsBySymbol, intervalMs, requiredBars, minCoverage,
}) {
  if (!Array.isArray(cutoffs) || typeof expectedByCutoff !== "function" ||
      !(rowsBySymbol instanceof Map) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
      !Number.isSafeInteger(requiredBars) || requiredBars <= 0 ||
      !Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
    throw new Error("INVALID_CUTOFF_COVERAGE_INPUT");
  }
  const indexed = new Map();
  for (const [symbol, rows] of rowsBySymbol) indexed.set(symbol,indexByTime(rows));
  const details = [];
  for (const cut of cutoffs) {
    if (!Number.isSafeInteger(cut)) throw new Error("INVALID_CUTOFF_TIME");
    const expected = [...new Set((expectedByCutoff(cut) || []).map(String))];
    let evaluated = 0;
    for (const symbol of expected) {
      const by = indexed.get(symbol) || new Map();
      let complete = true;
      for (let i=requiredBars;i>=1;i--) {
        if (!by.has(cut-i*intervalMs)) { complete=false; break; }
      }
      if (complete) evaluated++;
    }
    const coverage = expected.length ? evaluated/expected.length : 0;
    details.push({cutoff:cut,expected:expected.length,evaluated,coverage,blocked:coverage<minCoverage});
  }
  return {
    totalCutoffs:details.length,
    blockedCutoffs:details.filter((x)=>x.blocked).length,
    details,
  };
}

export function longFundingCost(rows, entryAt, exitAt, qty) {
  if (!(Number.isSafeInteger(entryAt) && Number.isSafeInteger(exitAt) && exitAt >= entryAt && Number.isFinite(qty) && qty >= 0)) {
    throw new Error("INVALID_FUNDING_COST_INPUT");
  }
  let cost = 0, events = 0;
  for (const x of rows || []) {
    const t=Number(x.fundingTime), rate=Number(x.fundingRate), mark=Number(x.markPrice);
    if (t > entryAt && t <= exitAt) {
      if (!(Number.isFinite(rate) && Number.isFinite(mark) && mark > 0)) throw new Error("FUNDING_ROW_INVALID");
      cost += qty * mark * rate;
      events++;
    }
  }
  return {signedCost:cost,events};
}
