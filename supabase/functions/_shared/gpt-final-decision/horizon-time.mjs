import {HORIZONS} from './dynamic-flow.mjs';

export const HORIZON_TIME_VERSION='CAPTURE_HORIZON_SECONDS_1';
export const HORIZON_TIME_NOTE=`
TIME UNITS: the s prefix always means SECONDS: s5=5 seconds, s15=15 seconds,
s30=30 seconds, s60=60 seconds (one minute), s120=120 seconds (two minutes).
All five windows end at capture_context.end_ms; the full observed path is only two minutes.
s60 is NOT return_60m: return_60m is a separate sixty-MINUTE candle fact.
The prospective 30-60 minute upside/downside forecast is not an observed capture horizon.
Each why_buy_now.horizons summary describes ONLY its own seconds window. Put longer-term
candle comparisons in structural_strength, not in a capture-horizon summary.
한국어에서도 s60은 최근 60초(1분), s120은 최근 120초(2분)다. 한 시간으로 해석하지 마라.
Use horizon_definitions for the nominal seconds and actual recorded boundaries; never change their units.
For RECHECK these definitions describe current.capture_context; initial is the separate previous observation.
`;

// Labels clarify existing evidence; no numeric trajectory, timestamp or hash is rewritten.
export function horizonDefinitions(capture){
 const points=capture?.trajectory??[];
 return {version:HORIZON_TIME_VERSION,unit:'seconds',windows:Object.fromEntries(HORIZONS.map(seconds=>{
  const start=points.at(-seconds/5)?.start_ms??null,end=points.at(-1)?.end_ms??null;
  return ['s'+seconds,{label:`last ${seconds} seconds`,nominal_seconds:seconds,
   actual_seconds:capture?.dynamics?.horizons?.['s'+seconds]?.actual_seconds??null,
   bucket_count:seconds/5,start_ms:start,end_ms:end}];
 }))};
}

/** Narrow semantic check for explicit duration contradictions, not a strategy filter.
 * No-duration prose is allowed. Correct one-/two-minute equivalents are allowed.
 * These summaries are scoped to <=120 seconds; longer candle/forecast prose belongs elsewhere.
 */
export function horizonTimeMismatch(summary,seconds){
 if(typeof summary!=='string')return false; // The existing schema validates type/requiredness.
 const text=summary.normalize('NFKC');
 if(/\b(?:hours?|hrs?|hourly|days?|daily)\b|(?:\d+(?:\.\d+)?|한|두|세|네|일|이|삼|사|몇|여러)\s*시간|(?:\d+(?:\.\d+)?|한|두|세|네)\s*(?:일간|하루)|(?:^|[^\p{L}\p{N}_])\d+(?:\.\d+)?\s*h\b/iu.test(text))return true;
 for(const m of text.matchAll(/(\d+(?:\.\d+)?)\s*분|(?:^|[^\p{L}\p{N}_])(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|m\b)/giu))
  if(Number(m[1]??m[2])*60>seconds)return true;
 const words={one:1,two:2,three:3,five:5,ten:10,thirty:30,sixty:60,한:1,두:2,세:3,네:4,오:5,십:10,삼십:30,육십:60};
 for(const m of text.matchAll(/(?:^|[^\p{L}\p{N}_])(one|two|three|five|ten|thirty|sixty|한|두|세|네|오|십|삼십|육십)[ -]*(?:minutes?|분)/giu))
  if(words[m[1].toLowerCase()]*60>seconds)return true;
 return false;
}
