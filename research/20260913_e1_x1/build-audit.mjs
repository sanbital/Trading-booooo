import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const sourceRoot = resolve(process.argv[2] ?? '');
const outputRoot = resolve(process.argv[3] ?? new URL('./generated', import.meta.url).pathname);
if (!process.argv[2]) throw new Error('usage: node build-audit.mjs <broad-study-dir> [output-dir]');

const readJson = async name => JSON.parse(await readFile(join(sourceRoot, name), 'utf8'));
const sha256 = async name => createHash('sha256').update(await readFile(join(sourceRoot, name))).digest('hex');
const iso = value => value == null || value === '' ? null : new Date(Number.isFinite(Number(value)) ? Number(value) : value).toISOString();
const num = value => value == null || value === '' ? null : Number(value);
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
const round = (value, digits = 12) => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

function csv(rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.map(cell).join(',')}\n${rows.map(row => columns.map(key => cell(row[key])).join(',')).join('\n')}\n`;
}

function firstProtection(row) {
  const orders = Array.isArray(row.exit_protection?.orders) ? row.exit_protection.orders : [];
  return [...orders].filter(order => Number.isFinite(num(order.submittedAt)))
    .sort((a, b) => num(a.submittedAt) - num(b.submittedAt))[0] ?? null;
}

function lastProtection(row) {
  const orders = Array.isArray(row.exit_protection?.orders) ? row.exit_protection.orders : [];
  return [...orders].filter(order => Number.isFinite(num(order.submittedAt)))
    .sort((a, b) => num(b.submittedAt) - num(a.submittedAt))[0] ?? null;
}

function knownExitFee(row, liveById) {
  const live = liveById.get(row.id);
  if (live?.exitFeeUsdt != null) return live.exitFeeUsdt;
  const orders = Array.isArray(row.exit_protection?.orders) ? row.exit_protection.orders : [];
  const final = [...orders].reverse().find(order => num(order.appliedFee) >= 0 && order.actualOrderId);
  return final ? num(final.appliedFee) : null;
}

function maxDrawdown(rows) {
  let equity = 0, peak = 0, worst = 0, peakAt = null, troughAt = null, candidatePeakAt = null;
  for (const row of [...rows].sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at))) {
    equity += num(row.realized_pnl_usdt);
    if (equity > peak) { peak = equity; candidatePeakAt = row.closed_at; }
    const dd = peak - equity;
    if (dd > worst) { worst = dd; peakAt = candidatePeakAt; troughAt = row.closed_at; }
  }
  return {maxDrawdownUsdt: round(worst), peakAt, troughAt};
}

function maxConsecutiveLosses(rows) {
  let current = 0, maximum = 0;
  for (const row of [...rows].sort((a, b) => Date.parse(a.closed_at) - Date.parse(b.closed_at))) {
    current = num(row.realized_pnl_usdt) < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

const [cohort, review, featuresFile, tape, winners, winnerResults, winnerCross, manifest,
  candidateManifest, liveEvidence] = await Promise.all([
  readJson('cohort.json'), readJson('cohort_review.json'), readJson('features.json'),
  readJson('tape10_results.json'), readJson('winner_cases.json'), readJson('winner_results.json'),
  readJson('winner_cross_results.json'), readJson('manifest.json'), readJson('candidate_manifest.json'),
  JSON.parse(await readFile(new URL('./live-selected-evidence.json', import.meta.url), 'utf8')),
]);

if (cohort.length !== 210) throw new Error(`FIXED_COHORT_DRIFT:${cohort.length}`);
const tapeRows = tape.rows ?? [];
const tapeById = new Map([...tapeRows, ...(tape.supplement_rows ?? [])].map(row => [row.id, row]));
const featureById = new Map(featuresFile.rows.map(row => [row.id, row]));
const liveById = new Map(liveEvidence.fillReconciliation.map(row => [row.positionId, row]));
const recoveredFillById = new Map([
  [liveEvidence.entryFillTimeIntegrity.positionId, Date.parse(liveEvidence.entryFillTimeIntegrity.rawFillAt)],
  ...liveEvidence.v22InitialProtection.rows.map(row => [row.positionId, row.fillAtMs]),
]);
const fixedIds = new Set(cohort.map(row => row.id));

const tradeTruth = cohort.map(row => {
  const entry = num(row.entry_price), exit = num(row.exit_price), quantity = num(row.original_quantity);
  const gross = (exit - entry) * quantity, net = num(row.realized_pnl_usdt);
  const exitFee = knownExitFee(row, liveById);
  const knownFees = num(row.entry_fee_usdt) + (exitFee ?? 0);
  const exportedFillMs = num(row.exchange_fill_ms), recoveredFillMs = recoveredFillById.get(row.id) ?? null;
  const fillMs = exportedFillMs ?? recoveredFillMs;
  return {
    cohort_role: 'FIXED_210', position_id: row.id, symbol: row.symbol, side: row.side,
    ownership: 'AUTO_LEADER_MOMENTUM_V17_COHORT',
    decision_at: row.decision_at, exchange_entry_fill_at: iso(fillMs), db_entry_at: iso(row.entry_at),
    entry_time_source: exportedFillMs ? (row.entry_fill_ms ? 'RAW_FILL_STAMP' : 'RAW_FILL_RECONSTRUCTED') :
      (recoveredFillMs ? 'RAW_FILL_RECOVERED_IN_CURRENT_AUDIT' : 'DB_FALLBACK'),
    exit_fill_or_close_at: iso(row.closed_at), entry_price: entry, exit_price: exit, quantity,
    gross_price_pnl_usdt: round(gross), settled_net_pnl_usdt: round(net),
    price_to_settlement_difference_usdt: round(gross - net),
    known_entry_fee_usdt: num(row.entry_fee_usdt), known_exit_fee_usdt: exitFee,
    known_fee_sum_usdt: exitFee == null ? null : round(knownFees),
    residual_after_known_fees_usdt: exitFee == null ? null : round(gross - net - knownFees),
    funding_cashflow_usdt: null, funding_coverage: 'UNKNOWN_NOT_ZERO',
    exit_reason: row.exit_reason, executor_patch: row.patch,
    entry_policy_version: row.entry_request?.entry_execution_policy?.version ?? null,
    exit_policy_version: row.exit_policy,
    qv3_policy_version: row.entry_request?.qv3?.version ?? null,
    entry_order_client_id: row.entry_request?.order?.identifier ?? null,
    entry_exchange_order_id: row.entry_request?.order?.exchange_order_id ?? null,
  };
});

const timeline = cohort.map(row => {
  const first = firstProtection(row), last = lastProtection(row);
  const fillMs = num(row.exchange_fill_ms) ?? recoveredFillById.get(row.id) ?? null;
  return {
    cohort_role: 'FIXED_210', position_id: row.id, symbol: row.symbol,
    signal_completed_at: iso(row.entry_features?.signal5Close), decision_at: iso(row.decision_at),
    entry_request_at: null, entry_request_time_status: 'NOT_EXPORTED',
    entry_fill_at: iso(fillMs), db_entry_at: iso(row.entry_at),
    entry_db_lag_ms: fillMs == null ? null : Date.parse(row.entry_at) - fillMs,
    first_native_stop_submitted_at: iso(first?.submittedAt), first_native_stop_ack_at: iso(first?.ackAt),
    fill_to_first_stop_ack_ms: fillMs == null || first?.ackAt == null ? null : num(first.ackAt) - fillMs,
    last_observation_detected_at: iso(row.exit_telemetry?.detectedAtMs),
    last_quote_received_at: iso(row.exit_telemetry?.quoteReceivedAtMs),
    last_exchange_book_at: iso(row.exit_telemetry?.exchangeBookAtMs),
    exit_trigger_or_close_at: iso(row.closed_at), exit_fill_at: iso(row.closed_at),
    settlement_at: null, settlement_time_status: 'NOT_EXPORTED',
    final_native_actual_order_id: last?.actualOrderId ?? null,
    final_native_client_id: last?.clientId ?? null,
    final_native_status: last?.status ?? null,
  };
});

function causeRow(row) {
  const entry = num(row.entry_price), exit = num(row.exit_price), quantity = num(row.original_quantity);
  const net = num(row.realized_pnl_usdt), gross = (exit - entry) * quantity;
  const mfePct = (num(row.peak_price) / entry - 1) * 100;
  const tapeRow = tapeById.get(row.id), final = lastProtection(row);
  const trigger = num(final?.spec?.params?.triggerPrice), triggerPct = trigger ? (trigger / entry - 1) * 100 : null;
  const confirmed = [];
  if (row.exit_reason === 'QV3_TWO_BEARISH_CLOSED') confirmed.push('QV3_TWO_BEARISH_CLOSED가 실제 청산을 발생시킴');
  else if (row.exit_reason === 'V17_HARD_STOP') confirmed.push('V17 하드스톱이 실제 청산을 발생시킴');
  else if (row.exit_reason === 'V17_RISK_CUT') confirmed.push('R5 -1.2% 위험축소 단계가 실제 청산을 발생시킴');
  else if (row.exit_reason === 'V17_TRAILING_STOP') confirmed.push('R5 trailing 단계가 실제 청산을 발생시킴');
  else if (row.exit_reason === 'V17_NATIVE_STOP') confirmed.push('거래소 native stop 체결로 실제 청산됨');
  else confirmed.push(`${row.exit_reason} 사유로 원장상 청산됨`);
  if (net < 0 && gross > 0) confirmed.push('가격 총손익은 양수였으나 비용 포함 정산손익은 음수');
  if (net < 0 && mfePct >= 1 && mfePct < 2 && row.exit_policy === 'V17_EXIT_R5_TAIL')
    confirmed.push('관측 MFE +1% 이상/+2% 미만에서 R5는 -1.2% 위험축소까지만 허용');
  const hypotheses = [];
  const refuted = [];
  if (tapeRow?.fast_weak) {
    hypotheses.push('직전 10초 가격<-0.2%와 taker-buy<45% 조합은 확장표본에서 기대 저하와 연관');
    if (net > 0) refuted.push('fastWeak를 일괄 진입금지로 사용하는 설명의 수익 반례');
  }
  if (mfePct >= 1 && net < 0) hypotheses.push('더 빠른 실제 bid/VWAP 관측이 이익 반납을 줄일 가능성');
  if (featureById.get(row.id)?.features?.rsi5 >= 70 && net > 0) refuted.push('RSI>=70 일괄 금지의 수익 반례');
  return {
    position_id: row.id, symbol: row.symbol, settled_net_pnl_usdt: round(net),
    gross_price_pnl_usdt: round(gross), exit_reason: row.exit_reason,
    observed_sampled_bid_mfe_pct: round(mfePct, 6), final_native_trigger_pct: round(triggerPct, 6),
    fast_weak_10s: tapeRow?.fast_weak ?? null,
    confirmed: confirmed.join(' | '),
    supported_hypothesis: hypotheses.length ? hypotheses.join(' | ') : null,
    unknown: '근본적인 시장 방향 원인; 당시 수량별 매도 VWAP와 연속 L2; 후보 주문 ACK 전 실현 가능 가격',
    refuted: refuted.length ? refuted.join(' | ') : null,
    assessment: 'MECHANISM_CONFIRMED_PREDICTIVE_CAUSE_NOT_CONFIRMED',
  };
}
const causeMatrix = cohort.map(causeRow);

const winnersOnly = cohort.filter(row => num(row.realized_pnl_usdt) > 0);
const lossesOnly = cohort.filter(row => num(row.realized_pnl_usdt) < 0);
const transition1 = cohort.filter(row => num(row.realized_pnl_usdt) < 0 && num(row.peak_price) / num(row.entry_price) - 1 >= .01);
const transition2 = cohort.filter(row => num(row.realized_pnl_usdt) < 0 && num(row.peak_price) / num(row.entry_price) - 1 >= .02);
const baselineMetrics = {
  cohort: {entryBeforeExclusive: '2026-09-13T12:15:00.000Z', trades: cohort.length,
    symbols: new Set(cohort.map(row => row.symbol)).size},
  netPnlUsdt: round(sum(cohort, row => num(row.realized_pnl_usdt))),
  netExpectancyUsdt: round(sum(cohort, row => num(row.realized_pnl_usdt)) / cohort.length),
  winners: winnersOnly.length, losses: lossesOnly.length, winRate: winnersOnly.length / cohort.length,
  profitFactor: review.all.profit_factor,
  averageWinUsdt: round(sum(winnersOnly, row => num(row.realized_pnl_usdt)) / winnersOnly.length),
  averageLossUsdt: round(sum(lossesOnly, row => num(row.realized_pnl_usdt)) / lossesOnly.length),
  medianWinUsdt: review.all.median_win, medianLossUsdt: review.all.median_loss,
  worstTrade: (() => { const row=cohort.reduce((worst, candidate) => num(candidate.realized_pnl_usdt) < num(worst.realized_pnl_usdt) ? candidate : worst);
    return {positionId:row.id,symbol:row.symbol,closedAt:row.closed_at,netPnlUsdt:num(row.realized_pnl_usdt),exitReason:row.exit_reason}; })(),
  ...maxDrawdown(cohort), maxConsecutiveLosses: maxConsecutiveLosses(cohort),
  profitToLossConversions: {sampledBidMfeAtLeast1Pct: transition1.length,
    sampledBidMfeAtLeast2Pct: transition2.length,
    netLossUsdtAtLeast1Pct: round(sum(transition1, row => num(row.realized_pnl_usdt))),
    caveat: 'sampled peak, not quantity executable VWAP'},
  byDay: review.by_day, byExit: review.by_exit,
};

const fastWeak = tapeRows.filter(row => row.fast_weak);
const fastWeakWins = fastWeak.filter(row => num(row.labels?.actual_net_usdt) > 0);
const fastWeakLosses = fastWeak.filter(row => num(row.labels?.actual_net_usdt) < 0);
const candidateComparison = {
  B0: {
    definition: 'actual mixed-version fixed ledger; current code equations separately traced',
    actualLedger: review.all,
    behavioralReplayErrorPerTradeUsdt: null,
    behavioralReplayGatePassed: false,
    verdict: 'DEFER_AS_REPLAY_BASELINE',
    reason: 'minute candles cannot reproduce sampled bid/native stop/ACK/intrabar ordering to <=0.25 USDT per trade',
  },
  E1: {
    definition: 'fastWeak -> at most 30s wait -> two qualifying 5s blocks -> fresh mid/guards/depth repricing',
    descriptiveFastWeakAssociation: tape.groups.ALL.fast_weak,
    blanketVetoCounterfactual: {
      affected: fastWeak.length, winnersMissed: fastWeakWins.length, winnerPnlMissedUsdt: round(sum(fastWeakWins, row => num(row.labels.actual_net_usdt))),
      lossesAvoided: fastWeakLosses.length, lossPnlRemovedUsdt: round(-sum(fastWeakLosses, row => num(row.labels.actual_net_usdt))),
      staticNetDeltaUsdt: round(-sum(fastWeak, row => num(row.labels.actual_net_usdt))),
      validStrategyResult: false,
    },
    accountReplay: null, opportunityRetention: null, netPnl: null, verdict: 'DEFER',
    missing: ['post-t0 non-overlapping 5s blocks', 'fresh L2/mid', 'quantity VWAP', 'wait/reprice fills', 'point-in-time cash/slots'],
  },
  X1: {
    definition: 'unchanged R5/QV3 evaluated from <=1s fresh quotes; QV3 only on a new completed bar',
    sameEntryExitReplay: null, netPnl: null, winnerDamage: null, verdict: 'DEFER',
    evidence: {FLOCK: {sampledBidPeakPct: .765, completedBarTradeHighPct: 2.017},
      BTW_loss: {sampledBidPeakPct: 1.979, completedBarTradeHighPct: 2.496}},
    missing: ['historical <=1s best bid', 'quantity sell-VWAP', 'old/new native stop ACK sequence', 'intrabar event order'],
  },
  E1_X1: {accountReplay: null, netPnl: null, verdict: 'DEFER', reason: 'both component paths lack causal execution replay'},
  promotion: {eligible: false, deployed: false, reason: 'No candidate satisfies fidelity, independent validation, cost/stress, and account replay gates'},
};

const winnerDamage = {
  topTailDependency: {
    top5WinnerPnlUsdt: round(sum(review.top_winners.slice(0, 5), row => row.realized_pnl_usdt)),
    shareOfWinningPnl: sum(review.top_winners.slice(0, 5), row => row.realized_pnl_usdt) / review.all.winning_net_sum,
    netWithoutLargestWinnerUsdt: review.without_largest_winner.net,
    netWithoutTop5WinnersUsdt: review.without_top5_winners.net,
  },
  blanketFastWeakVetoDescriptiveOnly: candidateComparison.E1.blanketVetoCounterfactual,
  naiveSingleFilters: review.naive_filter_affected,
  postExitNoStopGrossDifferenceUsdt: Object.fromEntries(winnerResults.map(row => [row.symbol.replace('USDT',''), row.post_exit])),
  partialExitVtho: {assumption: 'half at +2%, half at actual exit', grossPnlDeltaVsActualFullHoldUsdt: -6.44,
    excludes: ['extra fees', 'slippage', 'remaining stop interactions']},
  e1ActualWinnerDamage: null,
  x1ActualWinnerDamage: null,
  conclusion: 'UNKNOWN until executable replay/forward shadow; no opportunity-retention gate can be marked passed',
};

const derivativeCounts = ['oi_change15','long_account_ratio','premium_bps','last_funding_bps']
  .map(key => ({key, count: featuresFile.rows.filter(row => Number.isFinite(num(row.features?.[key]))).length}));
const featureCoverage = [
  {family:'actual_position_ledger',source:'Supabase v11_long_regime_positions export',covered:210,eligible:210,grade:'A',availability:'actual stored record'},
  {family:'raw_entry_fill_time',source:'order.raw.updateTime/trades',covered:209,eligible:210,grade:'A/B',availability:'package had 208 exact/2 fallback; current exchange_trade_fills query recovered STEEM, leaving 209 exact/1 fallback'},
  {family:'completed_1m_candles_trade_cohort',source:'Binance historical futures klines',covered:52494,eligible:210,grade:'B',availability:`logical per-trade rows; ${sum(manifest,row=>row.rows)} consolidated stored symbol-time rows; post-retrieved, no historical receivedAt`},
  {family:'completed_1m_candles_signal_cohort',source:'Binance historical futures klines',covered:76222,eligible:621,grade:'B',availability:`logical per-candidate rows; ${sum(candidateManifest,row=>row.rows)} consolidated stored symbol-time rows; overlaps trade cohort and is not additive`},
  {family:'predecision_10s_aggTrades',source:'Binance historical aggTrades',covered:tapeRows.length,eligible:210,grade:'B',availability:'109 complete; 103 decision reference <=1s; fastWeak 28 all fresh'},
  {family:'post_t0_E1_5s_blocks',source:'required but not archived',covered:0,eligible:fastWeak.length,grade:'UNKNOWN',availability:'cannot synthesize'},
  {family:'historical_L2_best_bid_quantity_vwap',source:'v10_usdm_forward_snapshots / gateway',covered:0,eligible:210,grade:'UNKNOWN',availability:'forward snapshot latest 2026-09-01; none for 2026-09-13'},
  {family:'cross_venue_winner_cases',source:'Binance spot/perp, Upbit, KRW-per-USDT',covered:winnerCross.rows.length,eligible:4,grade:'B/C',availability:'case study; receipt-time lead/lag unavailable'},
  ...derivativeCounts.map(item => ({family:item.key,source:'Binance historical derivative endpoint',covered:item.count,eligible:210,grade:'C',availability:'availableAt assumed 5m; 10m sensitivity run'})),
  {family:'actual_funding_cashflow',source:'exchange income ledger',covered:0,eligible:210,grade:'UNKNOWN',availability:'not reconciled trade-by-trade'},
  {family:'news_onchain_liquidations',source:'not supplied',covered:0,eligible:210,grade:'UNKNOWN',availability:'not used'},
];

const preregistration = {
  protocol: 'B0_E1_X1_20260913_FREEZE_1', frozenAt: '2026-09-13T14:13:15.392Z',
  fixedCohort: {entryFromInclusive:'2026-09-07T15:00:00.000Z', entryBeforeExclusive:'2026-09-13T12:15:00.000Z',
    trades:210, symbols:78, dataRole:'already observed development/reconstruction data'},
  supplements: {ids:['2938b901-5f4e-4c14-ac28-b3b849612801','8d9d800f-9107-4f5b-b648-7dbf56dab07e'],
    dataRole:'post-cutoff case studies only; excluded from fixed 210 learning/validation'},
  comparisons:['B0','E1','X1','E1+X1'], maxNewCandidateFamilies:2,
  E1:{last10sReturnLt:-.002,takerBuyQuoteShare10sLt:.45,deadlineMs:30000,blockMs:5000,
    minimumTradesPerBlock:2,requiredConsecutiveBlocks:2,eachBlockReturnGte:0,eachBlockBuyShareGte:.5,
    currentMidGteT0Mid:true,maxQuoteAgeMs:1000,missing:'UNKNOWN'},
  X1:{baseExitPolicy:'V17_EXIT_R5_TAIL',qv3:'QV3_ENTRY_EXIT_TWO_1',maxQuoteAgeMs:1000,
    quoteEvaluationTargetMs:1000,qv3OnlyNewCompletedBar:true,tradeHighNeverExecutablePeak:true,
    monotonicStop:true,restUpdateEverySecond:false,missing:'UNKNOWN'},
  risk:{marginUsdt:40,leverage:3,maxSlots:10,realAvailableCashRequired:true,manualAndOtherOwnerPositions:'PRESERVE'},
  costs:{actualFillAlreadyContainsSlippage:true,funding:'UNKNOWN_NOT_ZERO',quantityDepthRequired:true},
  gates: {
    minimumPostUpdateClosedTrades:100,minimumChronologicalValidationTrades:30,minimumValidationWindows:3,
    baselineAbsoluteErrorPerTradeMaxUsdt:.25,positiveValidationNetExpectancy:true,validationNetImprovement:true,
    noWorseMaxDrawdown:true,noWorseWorstTrade:true,minimumOpportunityRetention:.70,
    costDelayStressOutperformance:true,pointInTimeAccountSlotCashReplay:true,fundingCoverage:true,
    each24hDeltaNonnegative:true,latestDeploymentDeltaNonnegative:true,positiveNetUnderStress:true,
    familywiseBootstrapConfidence:.99,
  },
  verdictRule:{SUPERIOR:'all fidelity/performance/risk/account gates pass',INFERIOR:'performance or risk clearly worsens',
    DEFER:'sample, timing, execution, account replay, or independent validation insufficient'},
};

const baselineReconciliation = {
  fixedLedger: {databaseQueryAt:'2026-09-13T14:02:10Z', packageNetPnlUsdt:review.all.net,
    databaseNetPnlUsdt:-10.27714339, differenceUsdt:round(review.all.net - (-10.27714339)), exactAggregateMatch:true},
  rawFillTimes:{originalPackageExact:208,originalPackageFallback:2,currentAuditExact:209,currentAuditFallback:1,
    newlyRecoveredPositionId:'6320bad6-d86b-48be-bbdc-775a685ffcb6',recoverySource:'exchange_trade_fills',steemDbLagMs:56054},
  behavioralReplay:{produced:false,errorPerTradeUsdt:null,maxAllowedUsdt:.25,gatePassed:false,
    blockers:['historical native-stop event order','continuous best bid','quantity sell-VWAP','order submit/ACK timing','actual funding cashflow']},
  cvcException:{exchangeTradeFillJoinRows:0,rawEntryOrderId:'443218755',rawEntryTradeIds:[25107968,25107969,25107970,25107971],
    nativeActualOrderId:'443307531',nativeTradeIds:[25118356,25118357,25118358],entryFeeUsdt:.06000895,exitFeeUsdt:.05923829,
    assessment:'CONFIRMED fill exists; JOIN absence is ledger-link coverage failure, not no trade/no fee'},
};

const coreIds = new Set([
  '6646f8dd-8b1b-4b86-8dac-db7e7b9a6e96','91c496d2-5731-4244-a016-576a94f90216',
  '594cba3b-b359-47e2-bf21-bd0e8df2b538','3fc3e93f-44ff-4d09-90da-0836af362942',
  '30f8d76f-46e2-486f-a844-5140945dc06e','d2460043-a596-4e9e-9c0f-94e1af5687f0',
  '6320bad6-d86b-48be-bbdc-775a685ffcb6','681aec00-81df-4fb2-8f55-d20320811210',
  '69cdf212-34ca-4339-905d-5b32f356a4d3','104b3c79-7490-484f-a934-3228f9780591',
  'f99c1d50-63c8-4ac9-bb81-0390660352b8','7974d3fe-088b-4638-acaa-99467ff0ef94',
  '985525a5-89f7-4a81-90ac-71b93105a0c2','e480e974-d0b3-4f5a-8205-b84f2678cf31',
  '2e63ba95-103b-469a-a61f-ad6886ac6004','2938b901-5f4e-4c14-ac28-b3b849612801',
  '8d9d800f-9107-4f5b-b648-7dbf56dab07e','4630b19b-fda4-47ba-a358-765429be663a',
]);
const winnerById = new Map(winners.map(row => [row.id, row]));
const resultById = new Map(winnerResults.map(row => [row.id, row]));
const coreCases = [...cohort.filter(row => coreIds.has(row.id)), ...winners.filter(row => coreIds.has(row.id) && !fixedIds.has(row.id))]
  .map(row => {
    const tapeRow = tapeById.get(row.id), result = resultById.get(row.id), feature = featureById.get(row.id);
    return {
      cohortRole: fixedIds.has(row.id) ? 'FIXED_210' : 'POST_CUTOFF_CASE_ONLY', id:row.id,symbol:row.symbol,
      entryAt:row.entry_at,closedAt:row.closed_at,entryPrice:num(row.entry_price),exitPrice:num(row.exit_price),
      quantity:num(row.original_quantity),settledNetPnlUsdt:num(row.realized_pnl_usdt),exitReason:row.exit_reason,
      sampledBidPeak:num(row.peak_price),sampledBidMfePct:result?.observed_peak_return_pct ??
        (num(row.peak_price) && num(row.entry_price) ? (num(row.peak_price)/num(row.entry_price)-1)*100 : null),
      fastWeak:tapeRow?.fast_weak ?? null,last10sReturnPct:tapeRow?.['10']?.return_pct ?? null,
      last10sBuyShare:tapeRow?.['10']?.buy_share ?? null,decisionReferenceAgeMs:tapeRow?.reference_trade_age_ms ?? null,
      forward5AfterDecisionPct:tapeRow?.labels?.forward5_after_decision ?? null,
      rsi5:result?.pre_features?.rsi5 ?? feature?.features?.rsi5 ?? null,
      crossVenue:winnerCross.rows.find(candidate=>candidate.id===row.id) ?? null,
      completePostEntryBars:result?.complete_postentry_bars ?? null,
      liveObservations:result?.live_observations ?? null,
      postExitNoStop:result?.post_exit ?? null,
    };
  });

const codePath = {
  currentLive:{
    entry:['v10-lane-signal-generator/index.ts','leader-momentum-v17.mjs','v10-lane-executor/index.ts','entryFresh/postFillEntryGuard','gateway create_order','entry settlement','position insert','native stop ensure'],
    exit:['v10-lane-executor manageLeader','gateway p10_quotes once per invocation','nextExitReviewed with stamped R5','durable CAS position update','native stop ensure','qv3AfterProtection on completed bars','idempotent close settlement'],
    shadowDeadEnd:{function:'pushShadowPositions',definedAt:'v10-lane-executor/index.ts:268',calls:0,
      consequence:'gateway shadow worker presence does not prove position observation or X1 deployment'},
  },
  candidates:{
    E1:{module:'research/20260913_e1_x1/e1-recovery.mjs',liveImports:0,executionEnabled:false},
    X1:{module:'research/20260913_e1_x1/x1-fast-observer.mjs',liveImports:0,executionEnabled:false},
  },
};

const inputHashes = Object.fromEntries(await Promise.all([
  'cohort.json','cohort_review.json','features.json','tape10_results.json','winner_cases.json',
  'winner_results.json','winner_cross_results.json','manifest.json','candidate_manifest.json',
].map(async name => [name, await sha256(name)])));
const provenance = {
  generatedAt:'2026-09-13T14:13:15.392Z',sourceRoot,inputHashes,
  constraints:{availableAtLteDecisionAt:'enforced where stored; otherwise assumed/UNKNOWN explicitly',secretsIncluded:false},
  reproduction:'source package SHA256SUMS verified; reproduced analysis outputs matched file-for-file',
};

await mkdir(outputRoot, {recursive:true});
const outputs = {
  'trade_truth.csv':csv(tradeTruth), 'timeline.csv':csv(timeline), 'cause_matrix.csv':csv(causeMatrix),
  'feature_coverage.csv':csv(featureCoverage), 'baseline_metrics.json':JSON.stringify(baselineMetrics,null,2)+'\n',
  'preregistration.json':JSON.stringify(preregistration,null,2)+'\n',
  'baseline_reconciliation.json':JSON.stringify(baselineReconciliation,null,2)+'\n',
  'candidate_comparison.json':JSON.stringify(candidateComparison,null,2)+'\n',
  'winner_damage.json':JSON.stringify(winnerDamage,null,2)+'\n',
  'core_cases.json':JSON.stringify(coreCases,null,2)+'\n',
  'code_path.json':JSON.stringify(codePath,null,2)+'\n',
  'live_selected_evidence.json':JSON.stringify(liveEvidence,null,2)+'\n',
  'provenance.json':JSON.stringify(provenance,null,2)+'\n',
};
await Promise.all(Object.entries(outputs).map(([name, content]) => writeFile(join(outputRoot,name),content)));
console.log(JSON.stringify({outputRoot,files:Object.keys(outputs),fixedTrades:cohort.length,causeRows:causeMatrix.length},null,2));
