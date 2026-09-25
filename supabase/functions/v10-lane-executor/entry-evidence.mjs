/** Pure boundary adapters. Missing evidence is never converted into approval. */
import {LIVE_CHASE_MODE,liveChaseTimingValid} from '../_shared/leader-live-chase.mjs';
const number = (value) => typeof value === 'number' ||
  (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
const stamp = (value) => Number.isSafeInteger(number(value)) && number(value) > 0;

/** Validate the already-deployed continuation path; never infer it from a missing dip.
 * This is timing integrity only. CEC, GPT, account and execution guards still decide
 * admission. The selector's completed bars must prove the same trigger and prices.
 */
function continuationTimingValid(row, policy) {
  const s=row?.features?.v17Setup, source=row?.features?.b06133?.source;
  if (policy?.version!=='V17_GPT_CONTINUATION_ENTRY_2' ||
      s?.triggerMode!=='CONTINUATION_NO_PULLBACK' || s.pullbackObserved!==false ||
      s.pullbackLow!==null || !Array.isArray(source?.prebars)) return false;
  const trigger=number(s.triggerAt), ref=number(s.referencePrice), px=number(s.triggerClose),
    floor=number(policy.minReaccelPct), ceiling=number(policy.maxChasePct);
  if (!stamp(trigger) || trigger%60000!==0 || !(ref>0) || !Number.isFinite(ref) ||
      !(floor>0 && floor<=ceiling && ceiling<1) ||
      number(source.decisionAt)!==trigger || number(s.lastCandleOpenTime)!==trigger-60000 ||
      number(s.lastClose)!==px || !(px>=ref*(1+floor) && px<=ref*(1+ceiling))) return false;
  const bars=source.prebars, bar=bars.at(-1), prev=bars.at(-2);
  const valid=(b,t)=>!!b && number(b.openTime)===t && number(b.closeTime)===t+59999 &&
    [b.open,b.high,b.low,b.close].every(v=>Number.isFinite(number(v)) && number(v)>0) &&
    number(b.high)>=Math.max(number(b.open),number(b.close)) &&
    number(b.low)<=Math.min(number(b.open),number(b.close));
  if (!valid(bar,trigger-60000) || !valid(prev,trigger-120000) ||
      number(bar.close)!==px || !(px>number(bar.open) && px>number(prev.close))) return false;
  return Array.isArray(s.transitions) && s.transitions.some(t=>
    t?.to==='TRIGGERED' && t.reason==='V17_CONTINUATION_TRIGGERED' &&
    stamp(t.at) && number(t.at)>=trigger && number(t.at)<=number(s.expiresAt));
}

/** A setup's trigger clock replaces, rather than resets, the legacy signal clock. */
export function entryExecutionWindow(row, governed, legacyTtlMs, policy) {
  const close = number(row?.features?.signal5Close);
  const invalid = (reason) => ({valid:false, reason, featureAsOf:stamp(close)?close:null});
  if (!stamp(close) || !stamp(legacyTtlMs)) return invalid('SIGNAL_STALE_OR_FUTURE');
  if (!governed) return {valid:true, basis:'LEGACY_SIGNAL', featureAsOf:close,
    startsAt:close, expiresAt:close+legacyTtlMs};
  const s = row?.features?.v17Setup;
  if (!s || s.policyVersion !== policy.version || s.state !== 'TRIGGERED')
    return invalid('V17_SETUP_NOT_TRIGGERED');
  const symbol = String(row.symbol ?? '').toUpperCase();
  const continuation=s.triggerMode==='CONTINUATION_NO_PULLBACK',chase=s.triggerMode===LIVE_CHASE_MODE;
  // A LIVE momentum chase (2026-09-25) proves its own provenance: the chase bar the frozen
  // state machine recorded, the same bar in the selector's prebars, CHASE_EXPIRED then TRIGGERED.
  const timingValid=continuation?continuationTimingValid(row,policy):
    chase?liveChaseTimingValid(row,policy):
    s.triggerMode==null && s.pullbackObserved===true;
  if (!row.id || !symbol || s.signalId !== row.id || s.symbol !== symbol ||
      s.identity !== `${policy.version}:${symbol}:${row.id}:${close}` ||
      number(s.signal5Close) !== close || number(s.armedAt) !== close ||
      !(number(s.referencePrice)>0) || number(s.referencePrice)!==number(row.features.referenceClose) ||
      !stamp(s.triggerAt) || !stamp(s.triggerExpiresAt) || !stamp(s.expiresAt) ||
      number(s.expiresAt) !== close+policy.setupTtlMs ||
      number(s.triggerExpiresAt) !== number(s.triggerAt)+policy.entryTriggerTtlMs ||
      number(s.triggerAt) <= close || number(s.triggerAt) > number(s.expiresAt) ||
      !timingValid || !(number(s.triggerClose)>0))
    return invalid('V17_SETUP_INVALID_PRICE');
  return {valid:true, basis:continuation?'CONTINUATION_TRIGGER':chase?'LIVE_CHASE_TRIGGER':'PULLBACK_TRIGGER', featureAsOf:close,
    startsAt:number(s.triggerAt),
    expiresAt:Math.min(number(s.expiresAt),number(s.triggerExpiresAt))};
}

/** Normalize the gateway's {price,size} REST levels to the risk solver's [p,q]. */
export function normalizeEntryBook(quote, maxAgeMs, now=Date.now()) {
  const reasons = [];
  function side(name) {
    // An explicitly malformed normalized side must not be hidden by a raw fallback.
    const rows = quote?.[name] === undefined ? quote?.raw?.[name] : quote[name];
    if (!Array.isArray(rows) || !rows.length) { reasons.push(`NO_${name==='asks'?'ASK':'BID'}_DEPTH`); return []; }
    const out = [];
    for (const row of rows) {
      const p = number(Array.isArray(row)?row[0]:row?.price);
      const q = number(Array.isArray(row)?row[1]:row?.size);
      if (!(p>0 && q>0 && Number.isFinite(p) && Number.isFinite(q))) {
        reasons.push(`INVALID_${name.toUpperCase()}_DEPTH`); return [];
      }
      const prev = out.length ? Number(out.at(-1)[0]) : null;
      if (prev!==null && (name==='asks'?p<=prev:p>=prev)) {
        reasons.push(`UNSORTED_${name.toUpperCase()}_DEPTH`); return [];
      }
      out.push([String(p),String(q)]);
    }
    return out;
  }
  const asks=side('asks'), bids=side('bids');
  const requested=number(quote?.timing?.requested_at_ms), received=number(quote?.timing?.received_at_ms);
  const age=stamp(received)?now-received:NaN;
  if (!stamp(requested) || !stamp(received) || requested>received ||
      !Number.isSafeInteger(now) || !Number.isFinite(maxAgeMs) || maxAgeMs<0)
    reasons.push('QUOTE_TIME_UNKNOWN');
  else if (age<0) reasons.push('QUOTE_FROM_FUTURE');
  else if (age>maxAgeMs) reasons.push('QUOTE_STALE');
  const bid=number(quote?.best_bid), ask=number(quote?.best_ask);
  if (!(bid>0 && ask>0 && Number.isFinite(bid) && Number.isFinite(ask))) reasons.push('QUOTE_INVALID');
  else if (bid>=ask) reasons.push('CROSSED_BOOK');
  const same=(a,b)=>Math.abs(a-b)<=Math.max(1e-12,Math.abs(b)*1e-10);
  if (bids.length && !same(Number(bids[0][0]),bid)) reasons.push('BID_TOP_MISMATCH');
  if (asks.length && !same(Number(asks[0][0]),ask)) reasons.push('ASK_TOP_MISMATCH');
  if (quote?.bookGap===true || quote?.sequenceOk===false || quote?.valid===false || quote?.error)
    reasons.push('BOOK_EVIDENCE_INVALID');
  return {asks,bids,health:{bookHealthy:reasons.length===0,bookAgeMs:Number.isFinite(age)?age:null,
    maxBookAgeMs:maxAgeMs,barsFinal:true,resyncComplete:reasons.length===0,
    basis:'INDEPENDENT_REST_SNAPSHOT',reasons}};
}

/** *_pct is percent; CommissionRate/taker are fractions. No documentation default. */
export function gatewayTakerFeeRate(fees, symbol) {
  if (!fees || fees.exchange!=='binance_futures' || fees.market!==symbol ||
      fees.source!=='futures_commission_rate') return undefined;
  const fields=[['taker_pct',100],['takerCommissionRate',1],['taker',1]];
  const rates=[];
  for (const [field,scale] of fields) {
    if (fees[field]===undefined) continue;
    const rate=number(fees[field])/scale;
    if (!Number.isFinite(rate) || rate<0 || rate>=1) return undefined;
    rates.push(rate);
  }
  if (!rates.length || rates.some(x=>Math.abs(x-rates[0])>1e-12)) return undefined;
  return rates[0];
}

/** Only a fresh, explicit, authenticated one-way-mode observation is supported. */
export function supportedFuturesMode(mode, now=Date.now(), maxAgeMs=3000) {
  const o=mode?.observation;
  return Number.isSafeInteger(now) && Number.isFinite(maxAgeMs) && maxAgeMs>=0 &&
    mode?.exchange==='binance_futures' && mode?.account_scope==='futures' &&
    mode?.dual_side_position===false && mode?.position_mode==='ONE_WAY' &&
    typeof o?.id==='string' && o.id.length>0 && o.source==='BINANCE_POSITION_MODE_REST' &&
    stamp(o.requested_at_ms) && stamp(o.received_at_ms) &&
    o.requested_at_ms<=o.received_at_ms && now>=o.received_at_ms &&
    now-o.requested_at_ms<=maxAgeMs;
}

/**
 * Safe to persist: bounded prices/times only, never credentials or an entire response.
 *
 * Every field a drift or staleness refusal has to be ADJUDICATED from is recorded
 * here, because "the price moved" and "we measured against the wrong thing" look
 * identical in a bare reason string. Reading one of these rows must answer, without
 * any other source: which signal and symbol, at which stage, what the reference was,
 * what price was actually checked, what the book said and how old that reading was,
 * the drift and the ceiling it was compared against, and the exact trigger window
 * the check was inside or outside of.
 */
export function entryPriceEvidence(row, price, now, phase, quote, window, maxDriftPct, reason) {
  const ref=number(row?.features?.referenceClose), px=number(price);
  const nullable=(v)=>Number.isFinite(number(v))?number(v):null;
  const setup=row?.features?.v17Setup;
  const receivedAt=nullable(quote?.timing?.received_at_ms);
  return {stage:phase,finalAdmission:false,orderDispatched:false,reason:reason??null,
    signalId:row?.id==null?null:String(row.id),
    symbol:String(row?.symbol??'').toUpperCase()||null,
    setupState:typeof setup?.state==='string'?setup.state:null,
    evaluatedAt:now,referencePrice:nullable(ref),evaluatedPrice:nullable(px),
    triggerClose:nullable(setup?.triggerClose),
    priceBasis:quote?'ORDER_LIMIT':'SIGNAL_REFERENCE_ONLY',
    bestBid:nullable(quote?.best_bid),bestAsk:nullable(quote?.best_ask),
    quoteReceivedAt:receivedAt,
    quoteAgeMs:receivedAt===null||!Number.isSafeInteger(number(now))?null:number(now)-receivedAt,
    driftPct:ref>0&&px>0?px/ref-1:null,maxDriftPct,
    lowerAllowedPrice:ref>0?ref*(1-maxDriftPct):null,
    upperAllowedPrice:ref>0?ref*(1+maxDriftPct):null,
    triggerAt:nullable(setup?.triggerAt),triggerExpiresAt:nullable(setup?.triggerExpiresAt),
    executionWindow:window};
}
