/** Venue book integrity, independent of strategy. */
const number=value=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const stamp=value=>Number.isSafeInteger(number(value))&&number(value)>0;
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
  const stream=quote?.timing?.source==='BINANCE_DEPTH_STREAM';
  const event=number(quote?.timing?.book_captured_at_ms),validated=number(quote?.timing?.validated_at_ms);
  const age=stamp(received)?(stream?Math.max(now-received,now-event):now-received):NaN;
  const timeOrder=stream?stamp(event)&&stamp(validated)&&requested<=validated&&received<=validated&&event<=received&&
    validated<=now&&Number.isSafeInteger(quote?.raw?.book_update_id)&&quote.raw.book_update_id>0&&
    Number.isSafeInteger(quote?.raw?.book_generation)&&quote.raw.book_generation>0:requested<=received;
  if (!stamp(requested) || !stamp(received) || !timeOrder ||
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
    basis:stream?'SEQUENCED_STREAM':'INDEPENDENT_REST_SNAPSHOT',reasons}};
}


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
