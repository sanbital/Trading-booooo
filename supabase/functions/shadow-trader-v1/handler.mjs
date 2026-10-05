import {
  VERSION, TREND, SQUEEZE, STRATEGIES, INTERVAL_MS, number, fundingDistribution, parseKlines,
  candleState, chartFeatures, technicalFeatures, derivativeFeatures, evaluateCandidate,
  microstructure, microDecision, positionDecision, candidateOutcome, publicBinancePath,
} from './engine.mjs';

const PROJECT = 'etaajwpernzrcdrifdnw';
const TOKEN_NAME = 'shadow-trader-v1';
const FAPI = 'https://fapi.binance.com';
const READ_TABLES = new Set([
  'edge_internal_tokens', 'shadow_strategy_configs', 'shadow_runtime_state', 'shadow_strategy_runs',
  'shadow_trade_candidates', 'shadow_candidate_outcomes', 'shadow_positions', 'shadow_trade_outcomes', 'manual_trade_ledger',
  'manual_trade_outcomes', 'manual_position_observations',
]);
const WRITE_TABLES = new Set(['shadow_strategy_runs', 'shadow_trade_candidates', 'shadow_candidate_outcomes', 'shadow_trade_snapshots']);
const RPCS = new Set([
  'shadow_claim_runtime_v1', 'shadow_release_runtime_v1', 'shadow_open_position_v1',
  'shadow_record_position_tick_v1', 'shadow_refresh_comparisons_v1',
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const constantTimeEqual = (left, right) => {
  const a = String(left || '');
  const b = String(right || '');
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
};
const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function mapLimit(items, limit, task) {
  const output = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await task(items[index], index);
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => output);
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) query.set(key, String(value));
  return query.toString();
}

export function createHandler({ url, key, fetchFn = fetch, now = Date.now, uuid = () => crypto.randomUUID() }) {
  const dbHeaders = (extra = {}) => ({
    apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra,
  });

  async function dbRequest(method, table, params = {}, body = null, prefer = null) {
    const readable = method === 'GET' && READ_TABLES.has(table);
    const writable = method !== 'GET' && WRITE_TABLES.has(table);
    if (!readable && !writable) throw new Error('DB_SCOPE_BLOCKED');
    const query = queryString(params);
    const result = await fetchFn(`${url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method, headers: dbHeaders(prefer ? { prefer } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000),
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    const text = await result.text();
    let data = text;
    try { data = text ? JSON.parse(text) : []; } catch { /* preserve bounded error text */ }
    if (!result.ok) throw new Error(`DB_${table}_${result.status}:${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 180)}`);
    return data;
  }

  async function rpc(name, body) {
    if (!RPCS.has(name)) throw new Error('RPC_SCOPE_BLOCKED');
    const result = await fetchFn(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: dbHeaders(), redirect: 'error', signal: AbortSignal.timeout(12_000), body: JSON.stringify(body),
    });
    const text = await result.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* preserve bounded error text */ }
    if (!result.ok) throw new Error(`RPC_${name}_${result.status}:${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 180)}`);
    return data;
  }

  async function market(path, params = {}, retries = 2) {
    publicBinancePath(path);
    const query = queryString(params);
    let failure = 'PUBLIC_MARKET_UNAVAILABLE';
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fetchFn(`${FAPI}${path}${query ? `?${query}` : ''}`, {
          method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        const text = await result.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
        if (result.ok) return data;
        failure = `PUBLIC_MARKET_${result.status}`;
        if (![418, 429].includes(result.status) && result.status < 500) break;
      } catch (error) { failure = String(error?.message || error); }
      if (attempt < retries) await sleep(200 * (attempt + 1));
    }
    throw new Error(failure);
  }

  async function authorized(request) {
    const rows = await dbRequest('GET', 'edge_internal_tokens', { select: 'token', name: `eq.${TOKEN_NAME}`, limit: 1 });
    const expected = String(rows?.[0]?.token || '');
    const actual = String(request.headers.get('x-shadow-trader-token') || '');
    return expected.length >= 32 && constantTimeEqual(actual, expected);
  }

  async function loadConfigs() {
    const rows = await dbRequest('GET', 'shadow_strategy_configs', {
      select: '*', version: 'eq.V1', enabled: 'eq.true', order: 'strategy_key.asc',
    });
    if (!Array.isArray(rows) || rows.length !== 2 || STRATEGIES.some((strategy) => !rows.some((row) => row.strategy_key === strategy && row.shadow_only === true && row.order_capability === false))) {
      throw new Error('SHADOW_CONFIG_INVALID');
    }
    return Object.fromEntries(rows.map((row) => [row.strategy_key, row]));
  }

  async function fetchStageTwo(symbol, decisionAt, premium) {
    const end = (width) => Math.floor(decisionAt / width) * width - 1;
    const [raw1, raw5, raw15, raw1h, oi, premiumKlines] = await Promise.all([
      market('/fapi/v1/klines', { symbol, interval: '1m', limit: 121, endTime: end(INTERVAL_MS['1m']) }),
      market('/fapi/v1/klines', { symbol, interval: '5m', limit: 90, endTime: end(INTERVAL_MS['5m']) }),
      market('/fapi/v1/klines', { symbol, interval: '15m', limit: 60, endTime: end(INTERVAL_MS['15m']) }),
      market('/fapi/v1/klines', { symbol, interval: '1h', limit: 60, endTime: end(INTERVAL_MS['1h']) }),
      market('/futures/data/openInterestHist', { symbol, period: '5m', startTime: decisionAt - 75 * 60_000, endTime: decisionAt, limit: 30 }),
      market('/fapi/v1/premiumIndexKlines', { symbol, interval: '1m', limit: 30, endTime: end(INTERVAL_MS['1m']) }),
    ]);
    const candles = {
      m1: parseKlines(raw1, '1m', decisionAt), m5: parseKlines(raw5, '5m', decisionAt),
      m15: parseKlines(raw15, '15m', decisionAt), h1: parseKlines(raw1h, '1h', decisionAt),
    };
    const chart = chartFeatures(candles.m1, candles.m5);
    const technical = technicalFeatures(candles.m1);
    const derivatives = derivativeFeatures({ premium, oiHistory: oi, basisKlines: premiumKlines, decisionAt });
    return {
      chart, technical, derivatives,
      candles: {
        m1: candleState(candles.m1), m5: candleState(candles.m5),
        m15: candleState(candles.m15), h1: candleState(candles.h1),
      },
      mark_price: derivatives.mark_price, index_price: derivatives.index_price,
    };
  }

  async function fetchMicro(symbol, decisionAt, notional) {
    const [depth, trades, premium] = await Promise.all([
      market('/fapi/v1/depth', { symbol, limit: 100 }),
      market('/fapi/v1/aggTrades', { symbol, limit: 500 }),
      market('/fapi/v1/premiumIndex', { symbol }),
    ]);
    const micro = microstructure({ depth, trades, decisionAt, notional });
    return { micro, mark_price: number(premium?.markPrice), index_price: number(premium?.indexPrice), funding_rate: number(premium?.lastFundingRate) };
  }

  async function insertCandidates(rows) {
    if (!rows.length) return;
    for (let index = 0; index < rows.length; index += 100) {
      await dbRequest('POST', 'shadow_trade_candidates', { on_conflict: 'run_id,strategy_key,market' }, rows.slice(index, index + 100), 'resolution=ignore-duplicates,return=minimal');
    }
  }

  async function runScan({ runId, decisionAt, configs, positions }) {
    const [exchangeInfo, tickers, premiums, recentManual] = await Promise.all([
      market('/fapi/v1/exchangeInfo'), market('/fapi/v1/ticker/24hr'), market('/fapi/v1/premiumIndex'),
      dbRequest('GET', 'manual_trade_ledger', {
        select: 'market,executed_at,side,event_type,source_classification',
        executed_at: `gte.${iso(decisionAt - 20 * 60_000)}`, order: 'executed_at.desc', limit: 200,
      }),
    ]);
    const eligible = new Set((Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
      .filter((row) => row?.status === 'TRADING' && row?.contractType === 'PERPETUAL' && row?.quoteAsset === 'USDT')
      .map((row) => String(row.symbol)));
    const tickerRows = (Array.isArray(tickers) ? tickers : []).filter((row) =>
      eligible.has(String(row.symbol)) && number(row.priceChangePercent) !== null && number(row.lastPrice) > 0);
    const rankedTickers = tickerRows.sort((a, b) => number(b.priceChangePercent) - number(a.priceChangePercent) || String(a.symbol).localeCompare(String(b.symbol)));
    const top20 = rankedTickers.slice(0, 20);
    const funding = fundingDistribution(Array.isArray(premiums) ? premiums : [], eligible, configs[SQUEEZE].parameters);
    const fundingRows = funding.rows.filter((row) => row.outlier).slice(0, Number(configs[SQUEEZE].parameters.candidate_limit) || 20);
    const premiumBySymbol = new Map((Array.isArray(premiums) ? premiums : []).map((row) => [String(row.symbol), row]));
    const tickerBySymbol = new Map(tickerRows.map((row) => [String(row.symbol), row]));
    const tickerRankBySymbol = new Map(rankedTickers.map((row, index) => [String(row.symbol), index + 1]));
    const fundingBySymbol = new Map(funding.rows.map((row) => [row.symbol, row]));
    const stageOne = [
      ...top20.map((row, index) => ({ strategy: TREND, symbol: String(row.symbol), rank: index + 1 })),
      ...fundingRows.map((row, index) => ({ strategy: SQUEEZE, symbol: row.symbol, rank: index + 1 })),
    ];
    const symbols = [...new Set([...stageOne.map((row) => row.symbol), ...positions.map((row) => row.market)])];
    const stageTwoRows = await mapLimit(symbols, 6, async (symbol) => {
      try { return [symbol, await fetchStageTwo(symbol, decisionAt, premiumBySymbol.get(symbol))]; }
      catch (error) { return [symbol, { error: String(error?.message || error).slice(0, 160) }]; }
    });
    const facts = new Map(stageTwoRows);
    const open = new Set(positions.map((row) => `${row.strategy_key}:${row.market}`));
    const candidateRows = [];
    const stageCounts = {
      trend_candidates: top20.length, trend_chart_pass: 0, trend_indicator_pass: 0, trend_shortlisted: 0,
      squeeze_candidates: fundingRows.length, squeeze_chart_pass: 0, squeeze_indicator_pass: 0, squeeze_shortlisted: 0,
      data_skip: 0, manual_candidate_rejections: 0,
    };
    for (const item of stageOne) {
      const fetched = facts.get(item.symbol);
      const config = configs[item.strategy];
      const ticker = tickerBySymbol.get(item.symbol);
      const fundingRow = fundingBySymbol.get(item.symbol);
      const base = {
        run_id: runId, strategy_key: item.strategy, strategy_version: 'V1', market: item.symbol,
        candidate_decision_at: iso(decisionAt), expires_at: iso(decisionAt + Number(config.parameters.candidate_ttl_seconds || 300) * 1000),
        reference_price: number(ticker?.lastPrice) ?? number(premiumBySymbol.get(item.symbol)?.markPrice),
        outcome_due_at: iso(decisionAt + 121 * 60_000),
        candidate_rank: item.rank, funding_percentile: fundingRow?.percentile ?? null, funding_median: funding.median,
        funding_mad: funding.mad, funding_robust_z: fundingRow?.robust_z ?? null,
        market_features: { price_change_percent_24h: number(ticker?.priceChangePercent), quote_volume_24h: number(ticker?.quoteVolume), rank_at_decision: item.rank },
      };
      if (!fetched || fetched.error) {
        stageCounts.data_skip++;
        candidateRows.push({ ...base, stage: 'DATA_UNAVAILABLE', decision: 'SKIP', rejection_reasons: ['DATA_UNAVAILABLE'], stage_scores: {}, chart_features: {}, derivative_features: { error: fetched?.error || 'MISSING' } });
        continue;
      }
      const outcome = evaluateCandidate(item.strategy, { chart: fetched.chart, technical: fetched.technical, derivatives: fetched.derivatives, funding: fundingRow });
      const prefix = item.strategy === TREND ? 'trend' : 'squeeze';
      if (outcome.stage !== 'CHART_STRUCTURE_FAIL') stageCounts[`${prefix}_chart_pass`]++;
      if (outcome.stage === 'SHORTLISTED') stageCounts[`${prefix}_indicator_pass`]++;
      let stage = outcome.stage;
      let decision = outcome.decision;
      let reasons = outcome.reasons;
      if (outcome.stage === 'SHORTLISTED' && open.has(`${item.strategy}:${item.symbol}`)) { stage = 'RISK_BLOCKED'; decision = 'SKIP'; reasons = ['ALREADY_POSITIONED']; }
      if (stage === 'SHORTLISTED') stageCounts[`${prefix}_shortlisted`]++;
      candidateRows.push({
        ...base, stage, decision, rejection_reasons: reasons, stage_scores: outcome.scores,
        chart_features: fetched.chart, derivative_features: fetched.derivatives,
        market_features: { ...base.market_features, technical: fetched.technical, candles: fetched.candles },
      });
    }

    const selected = new Set(stageOne.map((row) => `${row.strategy}:${row.symbol}`));
    const manualSymbols = [...new Set((Array.isArray(recentManual) ? recentManual : [])
      .filter((row) => String(row.side || '').toUpperCase() === 'BUY' && String(row.source_classification || 'MANUAL').toUpperCase() === 'MANUAL')
      .map((row) => String(row.market || ''))
      .filter((symbol) => eligible.has(symbol)))];
    for (const symbol of manualSymbols) {
      const ticker = tickerBySymbol.get(symbol);
      const fundingRow = fundingBySymbol.get(symbol);
      const common = {
        run_id: runId, strategy_version: 'V1', market: symbol, candidate_decision_at: iso(decisionAt),
        expires_at: iso(decisionAt), reference_price: number(ticker?.lastPrice) ?? number(premiumBySymbol.get(symbol)?.markPrice),
        outcome_due_at: iso(decisionAt + 121 * 60_000), decision: 'SKIP', stage_scores: {}, chart_features: {}, derivative_features: {},
        market_features: { price_change_percent_24h: number(ticker?.priceChangePercent), quote_volume_24h: number(ticker?.quoteVolume), manual_trade_audit: true },
      };
      if (!selected.has(`${TREND}:${symbol}`)) {
        candidateRows.push({ ...common, strategy_key: TREND, candidate_rank: tickerRankBySymbol.get(symbol) ?? null, stage: 'NOT_TOP20', rejection_reasons: ['NOT_TOP20'] });
        stageCounts.manual_candidate_rejections++;
      }
      if (!selected.has(`${SQUEEZE}:${symbol}`)) {
        candidateRows.push({
          ...common, strategy_key: SQUEEZE, stage: 'FUNDING_NOT_EXTREME', rejection_reasons: ['FUNDING_NOT_EXTREME'],
          funding_percentile: fundingRow?.percentile ?? null, funding_median: funding.median,
          funding_mad: funding.mad, funding_robust_z: fundingRow?.robust_z ?? null,
        });
        stageCounts.manual_candidate_rejections++;
      }
    }
    await insertCandidates(candidateRows);
    return {
      facts, stageCounts,
      universeSummary: { eligible_symbols: eligible.size, ticker_symbols: tickerRows.length, top20: top20.map((row) => row.symbol), funding_sample_count: funding.count, funding_median: funding.median, funding_mad: funding.mad, funding_outliers: fundingRows.map((row) => row.symbol) },
    };
  }

  async function updateCandidate(candidate, values) {
    await dbRequest('PATCH', 'shadow_trade_candidates', { id: `eq.${candidate.id}` }, { ...values, updated_at: new Date().toISOString() }, 'return=minimal');
  }

  async function recordCandidateMicro(candidate, runId, decisionAt, snapshot, decision) {
    const micro = snapshot.microstructure || {};
    const derivatives = snapshot.derivatives || {};
    const technical = snapshot.technical || {};
    await dbRequest('POST', 'shadow_trade_snapshots', { on_conflict: 'snapshot_key' }, {
      snapshot_key: `CANDIDATE:${candidate.id}:${Math.floor(decisionAt / 5000) * 5}`,
      candidate_id: candidate.id, run_id: runId, strategy_key: candidate.strategy_key, market: candidate.market,
      snapshot_type: decision.executable ? 'ENTRY_DECISION' : 'MICRO_WAIT', captured_at: iso(decisionAt),
      price: micro.mid, mark_price: snapshot.mark_price, index_price: snapshot.index_price,
      funding_rate: derivatives.funding_rate, basis: derivatives.basis, basis_bps: derivatives.basis_bps,
      basis_slope: derivatives.basis_slope, basis_acceleration: derivatives.basis_acceleration,
      open_interest: derivatives.open_interest, open_interest_value: derivatives.open_interest_value,
      oi_change_pct: derivatives.oi_change_1h_pct, macd: technical.macd_hist, dif: technical.dif, dea: technical.dea,
      volume: technical.volume, volume_acceleration: technical.volume_acceleration, obv: technical.obv,
      taker_buy: micro.taker_buy, taker_sell: micro.taker_sell, best_bid: micro.best_bid, best_ask: micro.best_ask,
      spread_bps: micro.spread_bps, bid_depth: micro.bid_depth, ask_depth: micro.ask_depth,
      book_imbalance: micro.book_imbalance, estimated_slippage_bps: micro.estimated_slippage_bps,
      candle_1m: snapshot.candles?.m1 || {}, candle_5m: snapshot.candles?.m5 || {},
      candle_15m: snapshot.candles?.m15 || {}, candle_1h: snapshot.candles?.h1 || {},
      chart_state: snapshot.chart || {}, technical_state: technical, derivative_state: derivatives,
      microstructure: micro, raw_snapshot: { ...snapshot, decision },
    }, 'resolution=ignore-duplicates,return=minimal');
  }

  async function matureCandidates(decisionAt) {
    const due = await dbRequest('GET', 'shadow_trade_candidates', {
      select: 'id,strategy_key,market,candidate_decision_at,reference_price,stage,decision,rejection_reasons',
      outcome_status: 'eq.PENDING', outcome_due_at: `lte.${iso(decisionAt)}`,
      order: 'outcome_due_at.asc', limit: 50,
    });
    const results = { due: due.length, completed: 0, deferred: 0, invalid: 0 };
    await mapLimit(due, 4, async (candidate) => {
      const referencePrice = number(candidate.reference_price);
      const candidateAt = Date.parse(candidate.candidate_decision_at);
      if (!(referencePrice > 0) || !Number.isSafeInteger(candidateAt)) {
        results.invalid++;
        await updateCandidate(candidate, { outcome_status: 'ERROR' });
        return;
      }
      try {
        const startTime = Math.ceil(candidateAt / 60_000) * 60_000;
        const endTime = Math.min(decisionAt - 1, startTime + 120 * 60_000 - 1);
        const raw = await market('/fapi/v1/klines', {
          symbol: candidate.market, interval: '1m', startTime, endTime, limit: 120,
        });
        const candles = parseKlines(raw, '1m', decisionAt);
        const outcome = candidateOutcome({ referencePrice, decisionAt: candidateAt, candles, evaluatedAt: decisionAt });
        await dbRequest('POST', 'shadow_candidate_outcomes', { on_conflict: 'candidate_id' }, {
          candidate_id: candidate.id, strategy_key: candidate.strategy_key, market: candidate.market,
          candidate_decision_at: candidate.candidate_decision_at, reference_price: referencePrice,
          evaluated_at: iso(decisionAt), ...outcome,
          was_entered: candidate.decision === 'BUY' || candidate.stage === 'ENTERED',
          terminal_stage: candidate.stage, rejection_reasons: candidate.rejection_reasons || [],
        }, 'resolution=ignore-duplicates,return=minimal');
        await updateCandidate(candidate, { outcome_status: 'COMPLETE' });
        results.completed++;
      } catch {
        // Public market gaps never affect production. Leave PENDING for a later retry.
        results.deferred++;
      }
    });
    return results;
  }

  async function runMicro({ runId, decisionAt, configs, scanFacts }) {
    const [candidates, positions] = await Promise.all([
      dbRequest('GET', 'shadow_trade_candidates', {
        select: '*', stage: 'in.(SHORTLISTED,MICRO_WAIT)', expires_at: `gte.${iso(decisionAt)}`,
        order: 'candidate_rank.asc,candidate_decision_at.asc', limit: 100,
      }),
      dbRequest('GET', 'shadow_positions', { select: '*', status: 'eq.OPEN', order: 'entry_at.asc', limit: 100 }),
    ]);
    const symbols = [...new Set([...candidates.map((row) => row.market), ...positions.map((row) => row.market)])];
    const notionalBySymbol = new Map();
    for (const symbol of symbols) {
      const candidate = candidates.find((row) => row.market === symbol);
      const position = positions.find((row) => row.market === symbol);
      const candidateNotional = candidate ? Number(configs[candidate.strategy_key].parameters.virtual_notional_quote) : 0;
      const positionNotional = position ? Number(position.remaining_quantity) * Number(position.entry_price) : 0;
      notionalBySymbol.set(symbol, Math.max(1, candidateNotional, positionNotional));
    }
    const microRows = await mapLimit(symbols, 6, async (symbol) => {
      try { return [symbol, await fetchMicro(symbol, decisionAt, notionalBySymbol.get(symbol))]; }
      catch (error) { return [symbol, { error: String(error?.message || error).slice(0, 160) }]; }
    });
    const micros = new Map(microRows);
    const openCounts = new Map(STRATEGIES.map((strategy) => [strategy, positions.filter((row) => row.strategy_key === strategy).length]));
    let totalOpen = positions.length;
    const results = { candidates: candidates.length, entries: 0, micro_wait: 0, exits: 0, partial_exits: 0, holds: 0, data_skip: 0 };

    for (const candidate of candidates) {
      const observed = micros.get(candidate.market);
      if (!observed || observed.error) { results.data_skip++; continue; }
      const config = configs[candidate.strategy_key];
      const decision = microDecision(candidate.strategy_key, observed.micro, config.parameters);
      const microRecord = { ...observed.micro, mark_price: observed.mark_price, index_price: observed.index_price, funding_rate: observed.funding_rate };
      const source = scanFacts?.get(candidate.market);
      const technical = source?.technical ?? candidate.market_features?.technical ?? {};
      const chart = source?.chart ?? candidate.chart_features ?? {};
      const derivatives = { ...(source?.derivatives ?? candidate.derivative_features ?? {}), funding_rate: observed.funding_rate ?? source?.derivatives?.funding_rate };
      const candles = source?.candles ?? candidate.market_features?.candles ?? {};
      const snapshot = { at: iso(decisionAt), mark_price: observed.mark_price, index_price: observed.index_price, candles, chart, technical, derivatives, microstructure: microRecord };
      await recordCandidateMicro(candidate, runId, decisionAt, snapshot, decision);
      if (!decision.executable) {
        results.micro_wait++;
        await updateCandidate(candidate, {
          stage: 'MICRO_WAIT', decision: 'WAIT', rejection_reasons: decision.reasons,
          microstructure: microRecord, best_bid: observed.micro.best_bid, best_ask: observed.micro.best_ask,
          spread_bps: observed.micro.spread_bps, bid_depth: observed.micro.bid_depth, ask_depth: observed.micro.ask_depth,
          book_imbalance: observed.micro.book_imbalance, estimated_slippage_bps: observed.micro.estimated_slippage_bps,
        });
        continue;
      }
      const maxStrategy = Number(config.parameters.max_open_positions || 2);
      const maxTotal = Number(config.parameters.max_total_shadow_positions || 4);
      if ((openCounts.get(candidate.strategy_key) || 0) >= maxStrategy || totalOpen >= maxTotal) {
        await updateCandidate(candidate, { stage: 'RISK_BLOCKED', decision: 'SKIP', rejection_reasons: ['RISK_BLOCKED'], microstructure: microRecord });
        continue;
      }
      const notional = Number(config.parameters.virtual_notional_quote);
      const entryPrice = decision.virtual_fill_price;
      const quantity = notional / entryPrice;
      const entrySlippage = Math.max(0, (entryPrice - observed.micro.mid) * quantity);
      const entryFee = entryPrice * quantity * Number(config.fee_bps_per_fill) / 10_000;
      const opened = await rpc('shadow_open_position_v1', {
        p_candidate_id: candidate.id, p_run_id: runId, p_at: iso(decisionAt), p_entry_price: entryPrice,
        p_reference_price: observed.micro.mid, p_quantity: quantity, p_margin_quote: Number(config.margin_quote),
        p_notional_quote: notional, p_leverage: Number(config.leverage), p_entry_fee: entryFee,
        p_entry_slippage: entrySlippage, p_snapshot: snapshot,
      });
      if (opened?.opened) {
        results.entries++;
        totalOpen++;
        openCounts.set(candidate.strategy_key, (openCounts.get(candidate.strategy_key) || 0) + 1);
      }
    }

    for (const position of positions) {
      const observed = micros.get(position.market);
      if (!observed || observed.error) { results.data_skip++; continue; }
      const config = configs[position.strategy_key];
      const fresh = scanFacts?.get(position.market);
      const prior = position.latest_facts || {};
      const snapshot = {
        at: iso(decisionAt), mark_price: observed.mark_price, index_price: observed.index_price,
        candles: fresh?.candles ?? prior.candles ?? {}, chart: fresh?.chart ?? prior.chart ?? {},
        technical: fresh?.technical ?? prior.technical ?? {},
        derivatives: { ...(fresh?.derivatives ?? prior.derivatives ?? {}), funding_rate: observed.funding_rate ?? fresh?.derivatives?.funding_rate },
        microstructure: { ...observed.micro, mark_price: observed.mark_price, index_price: observed.index_price, funding_rate: observed.funding_rate },
      };
      const choice = positionDecision({ strategy: position.strategy_key, position, snapshot, at: decisionAt, parameters: { ...config.parameters, fee_bps_per_fill: config.fee_bps_per_fill, partial_exit_fraction: config.partial_exit_fraction } });
      let quantity = 0;
      let exitPrice = null;
      let fee = 0;
      if (choice.action === 'PARTIAL_EXIT') quantity = Number(position.remaining_quantity) * Number(choice.fraction);
      else if (choice.action === 'FULL_EXIT' || choice.action === 'HARD_STOP') quantity = Number(position.remaining_quantity);
      if (quantity > 0) {
        exitPrice = observed.micro.sell_vwap ?? observed.micro.best_bid;
        fee = exitPrice * quantity * Number(config.fee_bps_per_fill) / 10_000;
      }
      const applied = await rpc('shadow_record_position_tick_v1', {
        p_position_id: position.id, p_run_id: runId, p_at: iso(decisionAt), p_action: choice.action,
        p_reference_price: observed.micro.mid, p_exit_price: exitPrice, p_exit_quantity: quantity || null,
        p_exit_fee: fee, p_exit_reason: choice.reason, p_snapshot: { ...snapshot, decision: choice },
      });
      if (applied?.applied) {
        if (choice.action === 'PARTIAL_EXIT') results.partial_exits++;
        else if (choice.action === 'FULL_EXIT' || choice.action === 'HARD_STOP') results.exits++;
        else results.holds++;
      }
    }
    return results;
  }

  return async (request) => {
    if (request.method !== 'POST') return response(405, { ok: false, error: 'POST_ONLY', shadow_only: true, order_capability: false });
    if (url !== `https://${PROJECT}.supabase.co` || !key) return response(503, { ok: false, error: 'PROJECT_ENV_INVALID', shadow_only: true, order_capability: false });
    try {
      if (!await authorized(request)) return response(401, { ok: false, error: 'UNAUTHORIZED', shadow_only: true, order_capability: false });
    } catch { return response(401, { ok: false, error: 'UNAUTHORIZED', shadow_only: true, order_capability: false }); }
    const body = await request.json().catch(() => null);
    if (!body || body.action !== 'tick' || Object.keys(body).some((key) => key !== 'action')) return response(400, { ok: false, error: 'INVALID_ACTION', shadow_only: true, order_capability: false });

    let owner = null;
    let runId = null;
    try {
      const server = await market('/fapi/v1/time');
      const decisionAt = number(server?.serverTime);
      if (!Number.isSafeInteger(decisionAt) || Math.abs(decisionAt - now()) > 10_000) throw new Error('BINANCE_CLOCK_INVALID');
      owner = uuid();
      const claim = await rpc('shadow_claim_runtime_v1', { p_owner: owner, p_tick_at: iso(decisionAt) });
      if (!claim?.acquired) return response(200, { ok: true, skipped: true, reason: claim?.reason || 'LEASE_BUSY', version: VERSION, shadow_only: true, order_capability: false });
      const configs = await loadConfigs();
      const tickAt = Math.floor(decisionAt / 5000) * 5000;
      const runKey = `${VERSION}:${tickAt}`;
      const runKind = claim.scan_due ? 'SCAN' : 'MICRO';
      const inserted = await dbRequest('POST', 'shadow_strategy_runs', { on_conflict: 'run_key', select: 'id' }, {
        run_key: runKey, tick_at: iso(tickAt), scan_slot: claim.scan_slot || null, run_kind: runKind, status: 'RUNNING', shadow_only: true, order_capability: false,
      }, 'resolution=ignore-duplicates,return=representation');
      if (!Array.isArray(inserted) || !inserted.length) {
        await rpc('shadow_release_runtime_v1', { p_owner: owner, p_ok: true, p_error: null });
        return response(200, { ok: true, skipped: true, reason: 'DUPLICATE_TICK', version: VERSION, shadow_only: true, order_capability: false });
      }
      runId = inserted[0].id;
      const positions = await dbRequest('GET', 'shadow_positions', { select: '*', status: 'eq.OPEN', order: 'entry_at.asc', limit: 100 });
      let scan = null;
      if (claim.scan_due) scan = await runScan({ runId, decisionAt, configs, positions });
      const micro = await runMicro({ runId, decisionAt, configs, scanFacts: scan?.facts });
      const maturity = claim.scan_due ? await matureCandidates(decisionAt) : null;
      if (claim.scan_due) await rpc('shadow_refresh_comparisons_v1', { p_since: iso(decisionAt - 7 * 86_400_000) });
      const stageCounts = { ...(scan?.stageCounts || {}), ...micro, ...(maturity ? { candidate_outcomes: maturity } : {}) };
      await dbRequest('PATCH', 'shadow_strategy_runs', { id: `eq.${runId}` }, {
        status: 'COMPLETED', stage_counts: stageCounts, universe_summary: scan?.universeSummary || {}, finished_at: iso(now()),
      }, 'return=minimal');
      await rpc('shadow_release_runtime_v1', { p_owner: owner, p_ok: true, p_error: null });
      return response(200, { ok: true, version: VERSION, run_id: runId, run_kind: runKind, decision_at: iso(decisionAt), stage_counts: stageCounts, shadow_only: true, order_capability: false });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      if (runId) await dbRequest('PATCH', 'shadow_strategy_runs', { id: `eq.${runId}` }, { status: 'ERROR', error: message, finished_at: iso(now()) }, 'return=minimal').catch(() => {});
      if (owner) await rpc('shadow_release_runtime_v1', { p_owner: owner, p_ok: false, p_error: message }).catch(() => {});
      console.error('SHADOW_TRADER_TICK_FAILED', message);
      return response(503, { ok: false, error: message, version: VERSION, shadow_only: true, order_capability: false, production_impact: 'NONE' });
    }
  };
}
