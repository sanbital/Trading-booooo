#!/usr/bin/env node
/**
 * Deterministic, read-only replay for the frozen V20 loss-preservation rules.
 *
 * Usage:
 *   node replay-candidates.mjs \
 *     --evidence /path/to/v20-evidence \
 *     --vision /path/to/v20-binance-vision \
 *     --prospective /path/to/dataset.json \
 *     [--supplement /path/to/pre-v20-supplement.json] \
 *     [--output /path/to/results.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {
  CANDIDATES,
  evaluateCandidate,
  freshQuote,
  normalizeCandle,
  twoBearishDescending,
} from './candidate-rules.mjs';

const MINUTE_MS = 60_000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(fs.readFileSync(path.join(scriptDir, 'protocol.json'), 'utf8'));
const candidateLock = JSON.parse(fs.readFileSync(path.join(scriptDir, 'candidate-lock.json'), 'utf8'));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENT:${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ['evidence', 'vision', 'prospective']) if (!args[key]) throw new Error(`MISSING_ARGUMENT:${key}`);
  return args;
}

async function jsonlGzip(file, visit) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  const lines = readline.createInterface({input, crlfDelay: Infinity});
  for await (const line of lines) if (line.trim()) await visit(JSON.parse(line));
}

async function readJsonlGzip(file) {
  const rows = [];
  await jsonlGzip(file, row => rows.push(row));
  return rows;
}

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const atMs = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sum = (rows, select = x => x) => rows.reduce((total, row) => total + Number(select(row) ?? 0), 0);
const round = (value, digits = 9) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function metadataOf(raw) {
  if (raw.metadata) return raw.metadata;
  return {
    qv3: raw.qv3,
    qv3State: raw.qv3_state,
    entryFeatures: raw.entry_features,
    exitTelemetry: raw.exit_telemetry,
    exitProtection: raw.exit_protection,
    leaderExitPolicy: raw.exit_policy,
    leaderExitPolicyVersion: raw.exit_policy_version,
    executorPatch: raw.executor_patch,
    sizedMarginUsdt: raw.sized_margin_usdt,
  };
}

function normalizePosition(raw, source) {
  const metadata = metadataOf(raw);
  const entryAtMs = atMs(raw.entry_at);
  const closedAtMs = atMs(raw.closed_at);
  return {
    id: raw.id,
    source,
    symbol: raw.symbol,
    ownership: 'AUTO',
    side: raw.side ?? 'LONG',
    state: raw.state,
    entryAtMs,
    closedAtMs,
    entryAt: raw.entry_at,
    closedAt: raw.closed_at,
    entryPrice: number(raw.entry_price),
    exitPrice: number(raw.exit_price),
    quantity: number(raw.original_quantity),
    peakPrice: number(raw.peak_price),
    actualPnl: number(raw.realized_pnl_usdt),
    entryFee: number(raw.entry_fee_usdt) ?? 0,
    hardStopPrice: number(raw.hard_stop_price),
    exitReason: raw.exit_reason,
    metadata,
    features: metadata.entryFeatures ?? {},
    qv3: metadata.qv3 ?? null,
    qv3State: metadata.qv3State ?? null,
    exitProtection: metadata.exitProtection ?? null,
    executorPatch: metadata.executorPatch ?? null,
    strategyId: metadata.qv3?.version ?? metadata.entryFeatures?.strategy ?? null,
  };
}

function normalizeDecision(raw, source) {
  const details = raw.details ?? raw;
  const qv3 = details.qv3 ?? null;
  const detectedAtMs = number(details.detectedAtMs ?? raw.detected_at_ms) ?? atMs(raw.decided_at);
  const evaluationAtMs = number(qv3?.inputEvidence?.evaluatedAtMs ?? qv3?.state?.observedAt) ?? detectedAtMs;
  return {
    source,
    id: raw.id ?? null,
    positionId: raw.position_id,
    decidedAt: raw.decided_at,
    decidedAtMs: atMs(raw.decided_at),
    evaluationAtMs,
    detectedAtMs,
    bid: number(details.bid ?? raw.bid),
    action: raw.action ?? details.action,
    reason: raw.reason ?? details.reason,
    stopPrice: number(details.stopPrice ?? raw.stop_price),
    priceReturn: number(details.priceReturn ?? raw.price_return),
    observedMfe: number(details.observedMfe ?? raw.observed_mfe),
    protectionStage: details.protectionStage ?? raw.protection_stage ?? null,
    exchangeBookAtMs: number(details.exchangeBookAtMs ?? raw.exchange_book_at_ms),
    quoteReceivedAtMs: number(details.quoteReceivedAtMs ?? raw.quote_received_at_ms),
    quoteRequestedAtMs: number(details.quoteRequestedAtMs ?? raw.quote_requested_at_ms),
    qv3,
  };
}

function candleMapPut(target, key, raw) {
  const candle = normalizeCandle(raw);
  if (!candle) return;
  let map = target.get(key);
  if (!map) target.set(key, map = new Map());
  const prior = map.get(candle.openTimeMs);
  if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) map.set(candle.openTimeMs, null);
  else if (prior === undefined) map.set(candle.openTimeMs, candle);
}

function tailFromMap(map, evaluationAtMs) {
  if (!map || !Number.isSafeInteger(evaluationAtMs)) return [];
  const secondOpen = Math.floor(evaluationAtMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  const first = map.get(secondOpen - MINUTE_MS);
  const second = map.get(secondOpen);
  return first && second ? [first, second] : [];
}

function hasFavorableClose(map, position, evaluationAtMs) {
  if (!map) return false;
  const first = Math.ceil(position.entryAtMs / MINUTE_MS) * MINUTE_MS;
  for (const candle of map.values()) {
    if (candle && candle.openTimeMs >= first && candle.closeTimeMs < evaluationAtMs &&
        candle.close > position.entryPrice * 1.002) return true;
  }
  return false;
}

function evidenceTail(decision) {
  const evidence = decision.qv3?.inputEvidence;
  if (evidence?.status !== 'CAPTURED' || !Array.isArray(evidence.tail)) return [];
  return evidence.tail.map(normalizeCandle).filter(Boolean);
}

function finalNativeStop(position) {
  const orders = position.exitProtection?.orders;
  if (!Array.isArray(orders)) return null;
  const finished = orders.filter(order => order?.status === 'FINISHED' || order?.fillStatus === 'FILLED');
  const order = finished.sort((a, b) => Number(a.submittedAt ?? 0) - Number(b.submittedAt ?? 0)).at(-1);
  if (!order) return null;
  const params = order.spec?.params ?? {};
  return {
    triggerPrice: number(params.triggerPrice),
    workingType: params.workingType ?? null,
    priceProtect: params.priceProtect ?? null,
    reduceOnly: params.reduceOnly ?? null,
    closePosition: params.closePosition ?? null,
    submittedAtMs: number(order.submittedAt),
    ackAtMs: number(order.ackAt),
    actualOrderId: order.actualOrderId ?? null,
    clientId: order.clientId ?? null,
    status: order.status ?? null,
  };
}

function actualMfe(position, decisions) {
  const byPeak = position.peakPrice && position.entryPrice ? Math.max(0, position.peakPrice / position.entryPrice - 1) : 0;
  return Math.max(byPeak, ...decisions.map(decision => decision.observedMfe ?? 0), 0);
}

function actualMae(position, decisions) {
  const exitGross = position.exitPrice && position.entryPrice ? position.exitPrice / position.entryPrice - 1 : 0;
  return Math.min(exitGross, ...decisions.map(decision => decision.priceReturn ?? 0), 0);
}

function baselineRow(position, decisions) {
  const notional = position.entryPrice * position.quantity;
  const mfe = actualMfe(position, decisions);
  const mae = actualMae(position, decisions);
  const finalStop = finalNativeStop(position);
  return {
    id: position.id,
    symbol: position.symbol,
    source: position.source,
    entryAtMs: position.entryAtMs,
    exitAtMs: position.closedAtMs,
    exitPrice: position.exitPrice,
    actualPnl: position.actualPnl,
    pnl: position.actualPnl,
    return: position.actualPnl / notional,
    mfe,
    mae,
    modified: false,
    reason: position.exitReason,
    actualReason: position.exitReason,
    hardLoss: position.exitReason === 'V17_NATIVE_STOP' &&
      finalStop?.triggerPrice / position.entryPrice - 1 <= -0.02,
    earlyCut: false,
    candidateTrigger: null,
  };
}

function simulatedRow(position, decisions, trigger, scenario) {
  const baseline = baselineRow(position, decisions);
  if (!trigger) return baseline;
  let execution = trigger.decision;
  if (scenario.delayMs) {
    execution = decisions.find(decision => decision.evaluationAtMs >= trigger.atMs + scenario.delayMs &&
      decision.evaluationAtMs < position.closedAtMs && freshQuote(decision));
    if (!execution) return baseline;
  }
  if (!(execution.bid > 0) || execution.evaluationAtMs >= position.closedAtMs) return baseline;
  const exitPrice = execution.bid * (1 - scenario.impact);
  const fee = position.entryFee + exitPrice * position.quantity * scenario.exitFeeRate;
  const pnl = (exitPrice - position.entryPrice) * position.quantity - fee;
  const notional = position.entryPrice * position.quantity;
  const observed = decisions.filter(decision => decision.evaluationAtMs <= execution.evaluationAtMs);
  const mfe = Math.max(0, ...observed.map(decision => Math.max(
    decision.observedMfe ?? 0,
    decision.bid ? decision.bid / position.entryPrice - 1 : 0,
  )));
  const mae = Math.min(0, exitPrice / position.entryPrice - 1,
    ...observed.map(decision => decision.priceReturn ?? 0));
  return {
    ...baseline,
    exitAtMs: execution.evaluationAtMs,
    exitPrice,
    pnl,
    return: pnl / notional,
    mfe,
    mae,
    modified: true,
    reason: trigger.reason,
    hardLoss: false,
    earlyCut: trigger.reason.startsWith('C1_'),
    candidateTrigger: {
      atMs: trigger.atMs,
      executionAtMs: execution.evaluationAtMs,
      observedBid: trigger.decision.bid,
      executionBid: execution.bid,
      reason: trigger.reason,
    },
  };
}

function stats(rows, positionsById) {
  const ordered = [...rows].sort((a, b) => a.exitAtMs - b.exitAtMs || a.id.localeCompare(b.id));
  const wins = rows.filter(row => row.pnl > 0);
  const losses = rows.filter(row => row.pnl < 0);
  const grossProfit = sum(wins, row => row.pnl);
  const grossLoss = -sum(losses, row => row.pnl);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let currentLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const row of ordered) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    currentLosses = row.pnl < 0 ? currentLosses + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
  }
  const sumMfe = sum(rows, row => row.mfe);
  const sumReturn = sum(rows, row => row.return);
  const actualWinners = rows.filter(row => row.actualPnl > 0);
  const largeActualWinners = rows.filter(row => row.actualPnl >= 1);
  const actualLargeValue = sum(largeActualWinners, row => row.actualPnl);
  const candidateLargeValue = sum(largeActualWinners, row => Math.max(0, row.pnl));
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length : null,
    grossProfit,
    grossLoss,
    netPnl: sum(rows, row => row.pnl),
    avgReturn: rows.length ? sumReturn / rows.length : null,
    avgWinner: wins.length ? grossProfit / wins.length : null,
    avgLoser: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
    expectancy: rows.length ? sum(rows, row => row.pnl) / rows.length : null,
    maxConsecutiveLosses,
    maxDrawdown,
    worstTrade: rows.length ? Math.min(...rows.map(row => row.pnl)) : null,
    hardLossCount: rows.filter(row => row.hardLoss).length,
    earlyCutCount: rows.filter(row => row.earlyCut).length,
    changedTrades: rows.filter(row => row.modified).length,
    mfeCapture: sumMfe ? sumReturn / sumMfe : null,
    profitGiveback: sumMfe ? 1 - sumReturn / sumMfe : null,
    winnerRetention: actualWinners.length ? rows.filter(row => row.actualPnl > 0 && row.pnl > 0).length / actualWinners.length : null,
    winnerToLossCount: rows.filter(row => row.actualPnl > 0 && row.pnl <= 0).length,
    largeWinnerValueRetention: actualLargeValue ? candidateLargeValue / actualLargeValue : null,
    rejectedLosingEntries: 0,
    rejectedWinningEntries: 0,
    positionCountCheck: rows.filter(row => positionsById.has(row.id)).length,
  };
}

function deltaStats(candidate, baseline) {
  const result = {};
  for (const key of ['netPnl', 'expectancy', 'winRate', 'avgReturn', 'avgWinner', 'avgLoser',
    'profitFactor', 'maxDrawdown', 'worstTrade', 'hardLossCount', 'mfeCapture', 'profitGiveback']) {
    result[key] = candidate[key] === null || baseline[key] === null ? null : candidate[key] - baseline[key];
  }
  return result;
}

function cohortDefinitions(positions, prospectiveCutoffMs) {
  const bounds = protocol.time_boundaries;
  const qv3 = Date.parse(bounds.qv3_cutover_utc);
  const analysis = Date.parse(bounds.analysis_cutoff_utc);
  const sorted = [...positions].sort((a, b) => a.closedAtMs - b.closedAtMs || a.id.localeCompare(b.id));
  const latest20 = new Set(sorted.slice(-20).map(position => position.id));
  const previous20 = new Set(sorted.slice(-40, -20).map(position => position.id));
  const prospectiveSorted = sorted.filter(position => position.source === 'PROSPECTIVE_V20');
  const historicalSorted = sorted.filter(position => position.source !== 'PROSPECTIVE_V20');
  // The user-supplied 6W/14L snapshot ended at the twentieth V20 close.  Keep it
  // immutable while also reporting the moving latest-20 cohort separately.
  const suppliedSnapshot20 = new Set(prospectiveSorted.slice(0, 20).map(position => position.id));
  const suppliedSnapshotRecent12 = new Set(prospectiveSorted.slice(8, 20).map(position => position.id));
  const preV20Equal20 = new Set(historicalSorted.slice(-20).map(position => position.id));
  const prospectiveLatest12 = new Set(prospectiveSorted.slice(-12).map(position => position.id));
  return {
    DEVELOPMENT: position => position.entryAtMs < qv3,
    VALIDATION_ALL: position => position.entryAtMs >= qv3 && position.entryAtMs <= analysis,
    W1: position => position.entryAtMs >= Date.parse(bounds.qv3_cutover_utc) && position.entryAtMs < Date.parse('2026-09-11T21:53:38Z'),
    W2: position => position.entryAtMs >= Date.parse('2026-09-11T21:53:38Z') && position.entryAtMs < Date.parse('2026-09-12T03:30:41Z'),
    W3: position => position.entryAtMs >= Date.parse('2026-09-12T03:30:41Z') && position.entryAtMs <= analysis,
    PROSPECTIVE_V20: position => position.source === 'PROSPECTIVE_V20',
    POST_QV3_COMBINED: position => position.entryAtMs >= qv3,
    OPERATIONAL_GAP: position => position.source === 'OPERATIONAL_GAP',
    LATEST_48H: position => position.closedAtMs >= prospectiveCutoffMs - 48 * 3_600_000,
    LATEST_7D_AVAILABLE: position => position.closedAtMs >= prospectiveCutoffMs - 7 * 86_400_000,
    LATEST20: position => latest20.has(position.id),
    PREVIOUS20: position => previous20.has(position.id),
    SUPPLIED_V20_SNAPSHOT20: position => suppliedSnapshot20.has(position.id),
    SUPPLIED_PRE_V20_EQUAL20: position => preV20Equal20.has(position.id),
    SUPPLIED_V20_RECENT12: position => suppliedSnapshotRecent12.has(position.id),
    PROSPECTIVE_LATEST12: position => prospectiveLatest12.has(position.id),
  };
}

function diagnosticEntryFilters(positions, rows, cohortName) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const filters = [];
  const addCaps = (feature, values) => values.forEach(limit => filters.push({
    id: `${feature.toUpperCase()}_MAX_${limit}`,
    feature,
    limit,
    reject: value => value > limit,
  }));
  addCaps('dayReturn', [0.15, 0.20, 0.25, 0.30, 0.40]);
  addCaps('return5m', [0.005, 0.01, 0.015, 0.02]);
  addCaps('return15m', [0.03, 0.05, 0.08, 0.12]);
  addCaps('confirmationReturn15m', [0.03, 0.05, 0.08, 0.12]);
  addCaps('volumeRatio', [2, 3, 5, 8]);
  addCaps('entryDrift', [0.003, 0.005, 0.01]);
  return filters.map(filter => {
    const rejected = [];
    const kept = [];
    for (const position of positions) {
      const row = byId.get(position.id);
      const reference = number(position.features.referenceClose);
      const value = filter.feature === 'entryDrift'
        ? (reference > 0 ? Math.abs(position.entryPrice / reference - 1) : null)
        : number(position.features[filter.feature]);
      if (value !== null && filter.reject(value)) rejected.push(row);
      else kept.push(row);
    }
    const rejectedLosses = rejected.filter(row => row.pnl < 0);
    const rejectedWinners = rejected.filter(row => row.pnl > 0);
    const grossProfit = sum(kept.filter(row => row.pnl > 0), row => row.pnl);
    const grossLoss = -sum(kept.filter(row => row.pnl < 0), row => row.pnl);
    return {
      cohort: cohortName,
      id: filter.id,
      feature: filter.feature,
      limit: filter.limit,
      rejectedLosingEntries: rejectedLosses.length,
      rejectedWinningEntries: rejectedWinners.length,
      savedLoss: -sum(rejectedLosses, row => row.pnl),
      lostProfit: sum(rejectedWinners, row => row.pnl),
      netImprovement: -sum(rejected, row => row.pnl),
      tradeReduction: positions.length ? rejected.length / positions.length : null,
      resultingTrades: kept.length,
      resultingProfitFactor: grossLoss ? grossProfit / grossLoss : null,
      resultingExpectancy: kept.length ? sum(kept, row => row.pnl) / kept.length : null,
      missingPreserved: positions.filter(position => {
        const reference = number(position.features.referenceClose);
        return filter.feature === 'entryDrift' ? !(reference > 0) : number(position.features[filter.feature]) === null;
      }).length,
    };
  });
}

function extremaTime(position, decisions, kind) {
  if (!decisions.length) return 'UNKNOWN';
  if (kind === 'MFE') {
    const target = actualMfe(position, decisions);
    const match = decisions.find(decision => decision.observedMfe !== null && Math.abs(decision.observedMfe - target) < 1e-10);
    return match?.decidedAt ?? 'UNKNOWN';
  }
  const target = actualMae(position, decisions);
  const match = decisions.find(decision => decision.priceReturn !== null && Math.abs(decision.priceReturn - target) < 1e-10);
  if (match) return match.decidedAt;
  const exitGross = position.exitPrice / position.entryPrice - 1;
  return Math.abs(exitGross - target) < 1e-10 ? position.closedAt : 'UNKNOWN';
}

function tradeAudit(position, decisions, fills) {
  const notional = position.entryPrice * position.quantity;
  const mfe = actualMfe(position, decisions);
  const mae = actualMae(position, decisions);
  const netReturn = position.actualPnl / notional;
  const stop = finalNativeStop(position);
  const positionFills = fills.filter(fill => fill.position_id === position.id);
  const fees = sum(positionFills, fill => fill.fee_quote_amount ?? fill.fee_amount);
  const lastDecision = [...decisions].sort((a, b) => a.evaluationAtMs - b.evaluationAtMs).at(-1);
  const triggerSlippageBps = stop?.triggerPrice && position.exitPrice
    ? (position.exitPrice / stop.triggerPrice - 1) * 10_000 : null;
  const hardLoss = position.exitReason === 'V17_NATIVE_STOP' && stop?.triggerPrice / position.entryPrice - 1 <= -0.02;
  const falseMomentum = mfe < 0.002 && number(position.features.return5m) >= 0.002 &&
    number(position.features.volumeRatio) >= 1.1;
  const profitGiveback = mfe >= 0.005 && netReturn < mfe * 0.5;
  const flags = {
    A_BAD_ENTRY: mfe < 0.002,
    B_LATE_ENTRY: 'UNKNOWN',
    C_FALSE_MOMENTUM: falseMomentum,
    D_HARD_LOSS_BEFORE_ARMING: hardLoss && !position.qv3State?.favorableCandle,
    E_PROFIT_GIVEBACK: profitGiveback,
    F_EXIT_TOO_EARLY: 'UNKNOWN',
    G_STOP_EXECUTION_LOSS: triggerSlippageBps !== null ? triggerSlippageBps <= -30 : false,
  };
  const primary = flags.G_STOP_EXECUTION_LOSS ? 'G_STOP_EXECUTION_LOSS'
    : flags.D_HARD_LOSS_BEFORE_ARMING ? 'D_HARD_LOSS_BEFORE_ARMING'
      : flags.A_BAD_ENTRY ? 'A_BAD_ENTRY'
        : flags.E_PROFIT_GIVEBACK ? 'E_PROFIT_GIVEBACK'
          : flags.C_FALSE_MOMENTUM ? 'C_FALSE_MOMENTUM' : 'H_NORMAL_LOSS';
  return {
    id: position.id,
    symbol: position.symbol,
    market: 'FUTURES',
    side: position.side,
    entryTimestamp: position.entryAt,
    entryPrice: position.entryPrice,
    exitTimestamp: position.closedAt,
    exitPrice: position.exitPrice,
    size: position.quantity,
    notional,
    leverage: number(position.features.leverage),
    realizedPnl: position.actualPnl,
    realizedReturn: netReturn,
    fee: positionFills.length ? fees : 'UNKNOWN',
    mfe,
    mae,
    mfeAt: extremaTime(position, decisions, 'MFE'),
    maeAt: extremaTime(position, decisions, 'MAE'),
    mfeAtExit: lastDecision?.observedMfe ?? 'UNKNOWN',
    givebackReturn: mfe - netReturn,
    entryStructure1m: 'UNKNOWN',
    return5m: number(position.features.return5m) ?? 'UNKNOWN',
    return15m: number(position.features.return15m) ?? 'UNKNOWN',
    transactionAmount24h: number(position.features.qv24) ?? 'UNKNOWN',
    dayReturn: number(position.features.dayReturn) ?? 'UNKNOWN',
    acceleration: {
      return5m: number(position.features.return5m) ?? 'UNKNOWN',
      confirmationReturn15m: number(position.features.confirmationReturn15m) ?? 'UNKNOWN',
    },
    volatility: {
      atr: number(position.features.atr) ?? 'UNKNOWN',
      atrToReference: number(position.features.atr) !== null && number(position.features.referenceClose) > 0
        ? number(position.features.atr) / number(position.features.referenceClose) : 'UNKNOWN',
    },
    volumeExpansion: number(position.features.volumeRatio) ?? 'UNKNOWN',
    momentumIndicator: 'V17_RETURN_5M_15M_30M_60M',
    rsi: 'UNKNOWN',
    emaPriceDistance: 'UNKNOWN',
    recentHighPosition: 'UNKNOWN',
    breakout: 'UNKNOWN',
    pullback: 'UNKNOWN',
    strategyDecision: position.strategyId,
    stopHistory: Array.isArray(position.exitProtection?.orders) ? position.exitProtection.orders.map(order => ({
      triggerPrice: number(order.spec?.params?.triggerPrice),
      status: order.status ?? null,
      submittedAtMs: number(order.submittedAt),
      ackAtMs: number(order.ackAt),
      cancelRequestedAtMs: number(order.cancelRequestedAt),
      workingType: order.spec?.params?.workingType ?? null,
      priceProtect: order.spec?.params?.priceProtect ?? null,
      reduceOnly: order.spec?.params?.reduceOnly ?? null,
    })) : [],
    exitReason: position.exitReason,
    triggerPrice: stop?.triggerPrice ?? 'UNKNOWN',
    actualFill: position.exitPrice,
    triggerTimestamp: 'UNKNOWN',
    fillTimestamp: position.closedAt,
    triggerToFillSlippageBps: triggerSlippageBps ?? 'UNKNOWN',
    workingType: stop?.workingType ?? 'UNKNOWN',
    priceProtect: stop?.priceProtect ?? 'UNKNOWN',
    primaryClassification: position.actualPnl < 0 ? primary : null,
    classification: position.actualPnl < 0 ? {...flags, H_NORMAL_LOSS: primary === 'H_NORMAL_LOSS'} : {},
  };
}

function summarizeStopExecution(positions) {
  const rows = positions.filter(position => position.exitReason === 'V17_NATIVE_STOP').map(position => {
    const stop = finalNativeStop(position);
    return {
      positionId: position.id,
      symbol: position.symbol,
      triggerPrice: stop?.triggerPrice ?? null,
      actualFill: position.exitPrice,
      slippageBps: stop?.triggerPrice && position.exitPrice ? (position.exitPrice / stop.triggerPrice - 1) * 10_000 : null,
      workingType: stop?.workingType ?? null,
      priceProtect: stop?.priceProtect ?? null,
      reduceOnly: stop?.reduceOnly ?? null,
      submittedAtMs: stop?.submittedAtMs ?? null,
      ackAtMs: stop?.ackAtMs ?? null,
      triggerAtMs: null,
      fillAtMs: position.closedAtMs,
      atrToReference: number(position.features.atr) !== null && number(position.features.referenceClose) > 0
        ? number(position.features.atr) / number(position.features.referenceClose) : null,
      liquidityAtTrigger: null,
    };
  });
  const known = rows.filter(row => row.slippageBps !== null).sort((a, b) => a.slippageBps - b.slippageBps);
  return {
    rows,
    count: rows.length,
    known: known.length,
    medianSlippageBps: known.length ? known[Math.floor((known.length - 1) / 2)].slippageBps : null,
    worstSlippageBps: known.length ? known[0].slippageBps : null,
    worseThan10Bps: known.filter(row => row.slippageBps <= -10).length,
    worseThan30Bps: known.filter(row => row.slippageBps <= -30).length,
    worseThan50Bps: known.filter(row => row.slippageBps <= -50).length,
    triggerTimestampCoverage: 0,
    liquidityCoverage: 0,
  };
}

function roundDeep(value) {
  if (typeof value === 'number') return round(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  return value;
}

async function main() {
  const args = parseArgs(process.argv);
  const historicalPositionsRaw = await readJsonlGzip(path.join(args.evidence, 'positions.jsonl.gz'));
  const historicalDecisionsRaw = await readJsonlGzip(path.join(args.evidence, 'decisions.jsonl.gz'));
  const prospective = JSON.parse(fs.readFileSync(args.prospective, 'utf8'));
  const supplement = args.supplement
    ? JSON.parse(fs.readFileSync(args.supplement, 'utf8'))
    : {positions: [], decisions: [], fills: [], shadow: []};
  const historicalPositions = historicalPositionsRaw.map(row => normalizePosition(row,
    atMs(row.entry_at) < Date.parse(protocol.time_boundaries.qv3_cutover_utc) ? 'DEVELOPMENT' : 'VALIDATION'));
  const prospectivePositions = prospective.positions.map(row => normalizePosition(row, 'PROSPECTIVE_V20'));
  const supplementPositions = (supplement.positions ?? []).map(row => normalizePosition(row, 'OPERATIONAL_GAP'));
  const positions = [...historicalPositions, ...supplementPositions, ...prospectivePositions]
    .filter(position => position.state === 'CLOSED' && position.side === 'LONG' && position.entryAtMs && position.closedAtMs);
  const positionsById = new Map(positions.map(position => [position.id, position]));

  const decisions = [
    ...historicalDecisionsRaw.map(row => normalizeDecision(row, 'HISTORICAL')),
    ...(supplement.decisions ?? []).map(row => normalizeDecision(row, 'OPERATIONAL_GAP')),
    ...prospective.decisions.map(row => normalizeDecision(row, 'PROSPECTIVE_V20')),
  ].filter(decision => positionsById.has(decision.positionId) && decision.evaluationAtMs);
  const decisionsByPosition = new Map();
  for (const decision of decisions) {
    let rows = decisionsByPosition.get(decision.positionId);
    if (!rows) decisionsByPosition.set(decision.positionId, rows = []);
    rows.push(decision);
  }
  for (const rows of decisionsByPosition.values()) rows.sort((a, b) => a.evaluationAtMs - b.evaluationAtMs);

  const visionBySymbol = new Map();
  await jsonlGzip(path.join(args.vision, 'vision-candles.jsonl.gz'), row => candleMapPut(visionBySymbol, row.symbol, row));
  const shadowByPosition = new Map();
  await jsonlGzip(path.join(args.evidence, 'strategy-shadow.jsonl.gz'), row => {
    if (!String(row.policy_version ?? '').startsWith('QV3')) return;
    for (const decision of row.payload?.exitDecisions ?? []) {
      if (!positionsById.has(decision.positionId)) continue;
      for (const candle of decision.raw ?? []) candleMapPut(shadowByPosition, decision.positionId, candle);
    }
  });
  for (const row of supplement.shadow ?? []) {
    if (!String(row.policy_version ?? '').startsWith('QV3')) continue;
    for (const decision of row.payload?.exitDecisions ?? []) {
      if (!positionsById.has(decision.positionId)) continue;
      for (const candle of decision.raw ?? []) candleMapPut(shadowByPosition, decision.positionId, candle);
    }
  }

  const triggersByCandidate = new Map(Object.values(CANDIDATES).map(candidate => [candidate, new Map()]));
  const coverage = {development: new Set(), validation: new Set(), operationalGap: new Set(), prospective: new Set()};
  const coverageRequired = {development: new Set(), validation: new Set(), operationalGap: new Set(), prospective: new Set()};
  const structuralNoTwoCandle = {development: new Set(), validation: new Set(), operationalGap: new Set(), prospective: new Set()};
  const parity = {eligible: 0, matches: 0, mismatches: [], unavailable: 0};
  for (const position of positions) {
    const positionDecisions = (decisionsByPosition.get(position.id) ?? [])
      .filter(decision => decision.evaluationAtMs >= position.entryAtMs && decision.evaluationAtMs < position.closedAtMs);
    const coverageKey = position.source === 'DEVELOPMENT' ? 'development'
      : position.source === 'VALIDATION' ? 'validation'
        : position.source === 'OPERATIONAL_GAP' ? 'operationalGap' : 'prospective';
    const secondPostEntryClose = Math.ceil(position.entryAtMs / MINUTE_MS) * MINUTE_MS + 2 * MINUTE_MS - 1;
    if (positionDecisions.some(decision => decision.evaluationAtMs > secondPostEntryClose)) coverageRequired[coverageKey].add(position.id);
    else structuralNoTwoCandle[coverageKey].add(position.id);
    const candleMap = position.source === 'DEVELOPMENT' ? visionBySymbol.get(position.symbol)
      : position.source === 'PROSPECTIVE_V20' ? null : shadowByPosition.get(position.id);
    let baselineArmed = false;
    const candidateStates = new Map();
    for (const decision of positionDecisions) {
      const tail = position.source === 'PROSPECTIVE_V20' ? evidenceTail(decision) : tailFromMap(candleMap, decision.evaluationAtMs);
      if (tail.length === 2) coverage[coverageKey].add(position.id);
      if (decision.qv3?.state?.favorableCandle) baselineArmed = true;
      if (!baselineArmed && candleMap) baselineArmed = hasFavorableClose(candleMap, position, decision.evaluationAtMs);
      const baselineWouldClose = baselineArmed && twoBearishDescending(tail);
      if (decision.qv3?.available === true) {
        if (tail.length !== 2) parity.unavailable++;
        else {
          parity.eligible++;
          const actual = Boolean(decision.qv3.wouldClose);
          if (actual === baselineWouldClose) parity.matches++;
          else parity.mismatches.push({positionId: position.id, symbol: position.symbol,
            atMs: decision.evaluationAtMs, actual, replay: baselineWouldClose});
        }
      }
      for (const candidate of Object.values(CANDIDATES)) {
        const candidateTriggers = triggersByCandidate.get(candidate);
        if (candidateTriggers.has(position.id)) continue;
        const result = evaluateCandidate({
          candidate,
          position: {...position, state: 'OPEN'},
          decision,
          completedCandles: tail,
          baselineArmed,
          priorState: candidateStates.get(candidate) ?? null,
        });
        candidateStates.set(candidate, result.state);
        const baselineSameObservation = decision.qv3?.wouldClose === true ||
          (decision.action === 'CLOSE' && String(decision.reason).startsWith('QV3_'));
        if (result.wouldClose && !baselineSameObservation && decision.bid > 0) {
          candidateTriggers.set(position.id, {atMs: decision.evaluationAtMs, reason: result.reason, decision});
        }
      }
    }
  }

  const scenarios = {
    NORMAL: {impact: 0.001, exitFeeRate: 0.0005, delayMs: 0},
    COST_STRESS: {impact: 0.002, exitFeeRate: 0.001, delayMs: 0},
    DELAY_60S_STRESS: {impact: 0.002, exitFeeRate: 0.001, delayMs: 60_000},
  };
  const prospectiveCutoffMs = Date.parse(prospective.cutoff);
  const cohorts = cohortDefinitions(positions, prospectiveCutoffMs);
  const baselineRows = positions.map(position => baselineRow(position, decisionsByPosition.get(position.id) ?? []));
  const baselineById = new Map(baselineRows.map(row => [row.id, row]));
  const results = {};
  const runs = {};
  for (const [scenarioName, scenario] of Object.entries(scenarios)) {
    runs[scenarioName] = {};
    results[scenarioName] = {};
    for (const candidate of Object.values(CANDIDATES)) {
      const rows = positions.map(position => simulatedRow(position, decisionsByPosition.get(position.id) ?? [],
        triggersByCandidate.get(candidate).get(position.id), scenario));
      runs[scenarioName][candidate] = rows;
      results[scenarioName][candidate] = {};
      for (const [cohortName, select] of Object.entries(cohorts)) {
        const ids = new Set(positions.filter(select).map(position => position.id));
        const candidateRows = rows.filter(row => ids.has(row.id));
        const baseRows = baselineRows.filter(row => ids.has(row.id));
        const candidateStats = stats(candidateRows, positionsById);
        const baseStats = stats(baseRows, positionsById);
        results[scenarioName][candidate][cohortName] = {
          baseline: baseStats,
          candidate: candidateStats,
          delta: deltaStats(candidateStats, baseStats),
        };
      }
    }
  }

  const normal = runs.NORMAL;
  const robustness = {};
  const gates = {};
  const postQv3 = positions.filter(cohorts.POST_QV3_COMBINED);
  for (const candidate of Object.values(CANDIDATES)) {
    const candidateRows = normal[candidate];
    const rowById = new Map(candidateRows.map(row => [row.id, row]));
    const deltas = postQv3.map(position => rowById.get(position.id).pnl - baselineById.get(position.id).pnl);
    const totalDelta = sum(deltas);
    const bySymbol = new Map();
    postQv3.forEach((position, index) => bySymbol.set(position.symbol, (bySymbol.get(position.symbol) ?? 0) + deltas[index]));
    robustness[candidate] = {
      postQv3Delta: totalDelta,
      leaveOneTradeOutMinimumDelta: deltas.length ? Math.min(...deltas.map(delta => totalDelta - delta)) : null,
      leaveOneSymbolOutMinimumDelta: bySymbol.size ? Math.min(...[...bySymbol.values()].map(delta => totalDelta - delta)) : null,
      changedTradeDeltas: postQv3.map((position, index) => ({positionId: position.id, symbol: position.symbol, delta: deltas[index]}))
        .filter(row => Math.abs(row.delta) > 1e-12),
    };
    const development = results.NORMAL[candidate].DEVELOPMENT;
    const validation = results.NORMAL[candidate].VALIDATION_ALL;
    const combined = results.NORMAL[candidate].POST_QV3_COMBINED;
    const stressCost = results.COST_STRESS[candidate].POST_QV3_COMBINED;
    const stressDelay = results.DELAY_60S_STRESS[candidate].POST_QV3_COMBINED;
    const windowDeltas = ['W1', 'W2', 'W3'].map(window => results.NORMAL[candidate][window].delta.netPnl);
    const performance = {
      developmentNetNonnegative: development.delta.netPnl >= -1e-9,
      validationNetPositive: validation.delta.netPnl > 0,
      validationExpectancyPositive: validation.delta.expectancy > 0,
      eachWindowNonnegative: windowDeltas.every(delta => delta >= -1e-9),
      worstTradeNotWorse: combined.candidate.worstTrade >= combined.baseline.worstTrade - 1e-9,
      drawdownNotWorse: combined.candidate.maxDrawdown <= combined.baseline.maxDrawdown + 1e-9,
      winnerToLossZero: combined.candidate.winnerToLossCount === 0,
      largeWinnerRetention: (combined.candidate.largeWinnerValueRetention ?? 1) >= 0.9,
      opportunityRetention: 1 >= 0.7,
      costStressOutperformance: stressCost.delta.netPnl > 0,
      delayStressOutperformance: stressDelay.delta.netPnl > 0,
      leaveOneTradeOutPositive: robustness[candidate].leaveOneTradeOutMinimumDelta > 0,
      leaveOneSymbolOutPositive: robustness[candidate].leaveOneSymbolOutMinimumDelta > 0,
      profitGivebackImproved: combined.delta.profitGiveback < 0,
      netPnlImproved: combined.delta.netPnl > 0,
      expectancyImproved: combined.delta.expectancy > 0,
      hardLossReduced: combined.delta.hardLossCount < 0,
    };
    const data = {
      developmentEligibleCandleCoverage: coverageRequired.development.size
        ? coverage.development.size / coverageRequired.development.size : 1,
      developmentPositionCoverageIncludingStructuralIneligible:
        (coverage.development.size + structuralNoTwoCandle.development.size) / positions.filter(cohorts.DEVELOPMENT).length,
      developmentCandleCoveragePass: coverageRequired.development.size
        ? coverage.development.size / coverageRequired.development.size >= 0.98 : true,
      validationEligibleRawCandleCoverage: coverageRequired.validation.size
        ? coverage.validation.size / coverageRequired.validation.size : 1,
      validationPositionCoverageIncludingStructuralIneligible:
        (coverage.validation.size + structuralNoTwoCandle.validation.size) / positions.filter(cohorts.VALIDATION_ALL).length,
      validationRawCandleCoveragePass: coverageRequired.validation.size === coverage.validation.size,
      prospectiveEligibleExactEvidenceCoverage: coverageRequired.prospective.size
        ? coverage.prospective.size / coverageRequired.prospective.size : 1,
      prospectivePositionCoverageIncludingStructuralIneligible:
        (coverage.prospective.size + structuralNoTwoCandle.prospective.size) / prospectivePositions.length,
      fundingAttribution: false,
      pointInTimeCashSlotReplay: false,
      postUpdateClosedTrades: postQv3.length,
      minimumPostUpdateClosedTradesPass: postQv3.length >= 100,
      validationTrades: positions.filter(cohorts.VALIDATION_ALL).length,
      minimumValidationTradesPass: positions.filter(cohorts.VALIDATION_ALL).length >= 30,
      validationWindowsPass: windowDeltas.length >= 3,
    };
    const fidelity = {
      baselineDecisionMatchRate: parity.eligible ? parity.matches / parity.eligible : null,
      baselineDecisionMatchPass: parity.eligible ? parity.matches / parity.eligible >= 0.99 : false,
      actualSignedFillBaselineRetained: true,
      fundingIncluded: false,
    };
    const performancePass = Object.values(performance).every(Boolean);
    const dataPass = Object.entries(data).filter(([key]) => key.endsWith('Pass') || ['fundingAttribution', 'pointInTimeCashSlotReplay'].includes(key))
      .every(([, value]) => value === true);
    const fidelityPass = fidelity.baselineDecisionMatchPass && fidelity.fundingIncluded;
    gates[candidate] = {
      data,
      fidelity,
      performance,
      verdict: performancePass && dataPass && fidelityPass ? 'SUPERIOR'
        : performancePass ? 'DEFER' : 'INFERIOR',
      productionPromotion: false,
    };
  }

  const entryDiagnostics = {};
  for (const cohortName of ['VALIDATION_ALL', 'PROSPECTIVE_V20', 'SUPPLIED_V20_SNAPSHOT20',
    'SUPPLIED_PRE_V20_EQUAL20', 'POST_QV3_COMBINED', 'LATEST_48H', 'LATEST_7D_AVAILABLE']) {
    const cohortPositions = positions.filter(cohorts[cohortName]);
    const cohortRows = baselineRows.filter(row => cohortPositions.some(position => position.id === row.id));
    entryDiagnostics[cohortName] = diagnosticEntryFilters(cohortPositions, cohortRows, cohortName);
  }

  const prospectiveDecisions = new Map(prospectivePositions.map(position => [position.id,
    (decisionsByPosition.get(position.id) ?? []).filter(decision => decision.source === 'PROSPECTIVE_V20')]));
  const tradeAudits = prospectivePositions.map(position => tradeAudit(position,
    prospectiveDecisions.get(position.id) ?? [], prospective.fills ?? []));
  const exitPaths = Object.values(tradeAudits.reduce((groups, row) => {
    const key = row.exitReason;
    if (!groups[key]) groups[key] = {exitReason: key, trades: 0, wins: 0, losses: 0, netPnl: 0};
    groups[key].trades++;
    groups[key].wins += row.realizedPnl > 0 ? 1 : 0;
    groups[key].losses += row.realizedPnl < 0 ? 1 : 0;
    groups[key].netPnl += row.realizedPnl;
    return groups;
  }, {}));
  const classifications = Object.values(tradeAudits.filter(row => row.realizedPnl < 0).reduce((groups, row) => {
    const key = row.primaryClassification;
    if (!groups[key]) groups[key] = {classification: key, trades: 0, netPnl: 0};
    groups[key].trades++;
    groups[key].netPnl += row.realizedPnl;
    return groups;
  }, {}));

  const output = roundDeep({
    generatedAt: new Date().toISOString(),
    scope: 'READ_ONLY_FIXED_EXECUTED_ENTRY_REPLAY_NO_ACCOUNT_REENTRY',
    protocol: protocol.protocol,
    candidateLock: candidateLock.lock,
    prospectiveCutoff: prospective.cutoff,
    counts: {
      positions: positions.length,
      development: positions.filter(cohorts.DEVELOPMENT).length,
      validation: positions.filter(cohorts.VALIDATION_ALL).length,
      operationalGap: supplementPositions.length,
      prospectiveV20: prospectivePositions.length,
      postQv3Combined: postQv3.length,
      decisions: decisions.length,
    },
    evidence: {
      baselineDecisionParity: parity,
      coverage: {
        development: coverage.development.size,
        validation: coverage.validation.size,
        operationalGap: coverage.operationalGap.size,
        prospective: coverage.prospective.size,
        required: Object.fromEntries(Object.entries(coverageRequired).map(([key, ids]) => [key, ids.size])),
        structuralNoTwoCandle: Object.fromEntries(Object.entries(structuralNoTwoCandle).map(([key, ids]) => [key, ids.size])),
        missingRequired: Object.fromEntries(Object.entries(coverageRequired).map(([key, ids]) => [key,
          [...ids].filter(id => !coverage[key].has(id))])),
      },
      funding: 'UNKNOWN_NOT_ZERO',
      pointInTimeCashSlots: 'NOT_RECONSTRUCTED',
    },
    results,
    robustness,
    gates,
    candidateTradeChanges: Object.fromEntries(Object.values(CANDIDATES).map(candidate => [candidate,
      normal[candidate].filter(row => row.modified).map(row => ({
        positionId: row.id,
        symbol: row.symbol,
        source: row.source,
        actualPnl: row.actualPnl,
        candidatePnl: row.pnl,
        delta: row.pnl - row.actualPnl,
        actualReason: row.actualReason,
        candidateReason: row.reason,
        actualExitAtMs: positionsById.get(row.id)?.closedAtMs ?? null,
        candidateExitAtMs: row.exitAtMs,
        candidateExitPrice: row.exitPrice,
        candidateMfe: row.mfe,
        trigger: row.candidateTrigger,
      }))])),
    entryDiagnostics,
    prospectiveTradeAudit: tradeAudits,
    prospectiveExitPaths: exitPaths,
    prospectiveLossClassifications: classifications,
    nativeStopExecution: {
      allEvidence: summarizeStopExecution(positions),
      prospectiveV20: summarizeStopExecution(prospectivePositions),
    },
  });
  if (args.output) fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    counts: output.counts,
    parity: output.evidence.baselineDecisionParity,
    normalPostQv3: Object.fromEntries(Object.values(CANDIDATES).map(candidate => [candidate,
      output.results.NORMAL[candidate].POST_QV3_COMBINED])),
    gates: output.gates,
    prospectiveExitPaths: output.prospectiveExitPaths,
    prospectiveLossClassifications: output.prospectiveLossClassifications,
    nativeStopExecution: output.nativeStopExecution.prospectiveV20,
  }, null, 2));
}

await main();
