import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

// These official static candles are evaluation evidence, never live bot observations.
const evidenceDir = process.argv[2];
const outputDir = process.argv[3];
if (!evidenceDir || !outputDir) {
  throw new Error('USAGE: node collect-binance-vision.mjs EVIDENCE_DIR OUTPUT_DIR');
}

const protocol = JSON.parse(readFileSync(`${evidenceDir}/protocol.json`, 'utf8'));
const developmentEnd = Date.parse(protocol.development.end_utc);
const analysisStart = Date.parse(protocol.time_boundaries.cumulative_start_utc);
const rawPositions = gunzipSync(readFileSync(`${evidenceDir}/positions.jsonl.gz`)).toString('utf8').trim();
const positions = rawPositions ? rawPositions.split('\n').map(JSON.parse) : [];
const development = positions.filter((position) => Date.parse(position.entry_at) < developmentEnd);
if (development.length !== protocol.development.expected_closed_entries) {
  throw new Error(`DEVELOPMENT_COUNT_MISMATCH:${development.length}`);
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  while (timestamp > 10_000_000_000_000) timestamp /= 1000;
  return Math.trunc(timestamp);
}

function parseCsv(text, symbol) {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line || /^open_time,/i.test(line)) continue;
    const columns = line.split(',');
    if (columns.length < 7) throw new Error('CSV_COLUMN_COUNT');
    const openTime = normalizeTimestamp(columns[0]);
    const closeTime = normalizeTimestamp(columns[6]);
    const open = Number(columns[1]);
    const high = Number(columns[2]);
    const low = Number(columns[3]);
    const close = Number(columns[4]);
    const volume = Number(columns[5]);
    if (!Number.isSafeInteger(openTime) || openTime % 60_000 !== 0 ||
        closeTime !== openTime + 59_999 ||
        ![open, high, low, close, volume].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || volume < 0) {
      throw new Error('CSV_CANDLE_INVALID');
    }
    rows.push({ symbol, open_time_ms: openTime, open, high, low, close, volume, close_time_ms: closeTime });
  }
  return rows;
}

const needs = new Map();
for (const position of development) {
  const symbol = String(position.symbol).toUpperCase();
  const start = Math.max(analysisStart, Date.parse(position.entry_at) - 5 * 60_000);
  const end = Math.min(developmentEnd - 1, Date.parse(position.closed_at) + 30 * 60_000);
  for (let day = Date.parse(`${utcDate(start)}T00:00:00Z`); day <= end; day += 86_400_000) {
    const date = utcDate(day);
    needs.set(`${symbol}:${date}`, { symbol, date });
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'trading-booooo-vision-'));
const results = [];
const candles = new Map();

async function fetchOne({ symbol, date }) {
  const encoded = encodeURIComponent(symbol);
  const filename = `${symbol}-1m-${date}.zip`;
  const root = `https://data.binance.vision/data/futures/um/daily/klines/${encoded}/1m/${encodeURIComponent(filename)}`;
  try {
    const [checksumResponse, zipResponse] = await Promise.all([
      fetch(`${root}.CHECKSUM`, { signal: AbortSignal.timeout(20_000) }),
      fetch(root, { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!checksumResponse.ok || !zipResponse.ok) {
      return { symbol, date, ok: false, reason: `HTTP_${checksumResponse.status}_${zipResponse.status}` };
    }
    const checksumText = (await checksumResponse.text()).trim();
    const expectedSha = checksumText.match(/^[0-9a-fA-F]{64}/)?.[0]?.toLowerCase();
    if (!expectedSha) return { symbol, date, ok: false, reason: 'CHECKSUM_INVALID' };
    const zip = Buffer.from(await zipResponse.arrayBuffer());
    const actualSha = createHash('sha256').update(zip).digest('hex');
    if (actualSha !== expectedSha) return { symbol, date, ok: false, reason: 'CHECKSUM_MISMATCH' };
    const localName = createHash('sha256').update(`${symbol}:${date}`).digest('hex').slice(0, 20);
    const localZip = join(temporary, `${localName}.zip`);
    writeFileSync(localZip, zip);
    const extracted = spawnSync('unzip', ['-p', localZip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (extracted.status !== 0) return { symbol, date, ok: false, reason: 'ZIP_EXTRACT_FAILED' };
    const parsed = parseCsv(extracted.stdout, symbol);
    for (const candle of parsed) {
      if (candle.open_time_ms < analysisStart - 5 * 60_000 || candle.open_time_ms >= developmentEnd + 30 * 60_000) continue;
      const key = `${symbol}:${candle.open_time_ms}`;
      const prior = candles.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) throw new Error('CONFLICTING_CANDLE');
      candles.set(key, candle);
    }
    return { symbol, date, ok: true, sha256: actualSha, bytes: zip.length, rows: parsed.length };
  } catch (error) {
    return { symbol, date, ok: false, reason: String(error instanceof Error ? error.message : error).slice(0, 120) };
  }
}

const queue = [...needs.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.date.localeCompare(b.date));
let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const index = cursor;
    cursor += 1;
    results[index] = await fetchOne(queue[index]);
  }
}
await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
rmSync(temporary, { recursive: true, force: true });

const orderedCandles = [...candles.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.open_time_ms - b.open_time_ms);
const successful = results.filter((result) => result.ok);
const failed = results.filter((result) => !result.ok);
const coveredSymbols = new Set(successful.map((result) => result.symbol));
const requiredSymbols = new Set(development.map((position) => String(position.symbol).toUpperCase()));
const summary = {
  source: 'BINANCE_VISION_FUTURES_UM_DAILY_KLINES_POST_HOC',
  execution_input: false,
  retrieved_at: new Date().toISOString(),
  analysis_start_utc: protocol.time_boundaries.cumulative_start_utc,
  development_end_utc: protocol.development.end_utc,
  development_positions: development.length,
  required_symbols: requiredSymbols.size,
  covered_symbols: coveredSymbols.size,
  requested_archives: results.length,
  successful_archives: successful.length,
  failed_archives: failed.length,
  candle_rows: orderedCandles.length,
  failures: failed.map(({ symbol, date, reason }) => ({ symbol, date, reason })),
  archives: successful,
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/vision-candles.jsonl.gz`, gzipSync(`${orderedCandles.map(JSON.stringify).join('\n')}\n`, { level: 9 }));
writeFileSync(`${outputDir}/vision-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
const manifestLines = ['vision-candles.jsonl.gz', 'vision-summary.json'].map((name) => {
  const bytes = readFileSync(`${outputDir}/${name}`);
  return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
});
writeFileSync(`${outputDir}/manifest.sha256`, `${manifestLines.join('\n')}\n`);

console.log(JSON.stringify({
  required_symbols: summary.required_symbols,
  covered_symbols: summary.covered_symbols,
  requested_archives: summary.requested_archives,
  successful_archives: summary.successful_archives,
  failed_archives: summary.failed_archives,
  candle_rows: summary.candle_rows,
}));
