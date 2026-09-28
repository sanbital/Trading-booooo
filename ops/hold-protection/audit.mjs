import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {frozenReview,arbitrationPayload,finalEvidenceTransport,reviewsFor} from '../../supabase/functions/_shared/gpt-final-decision/dual.mjs';
import {technicalFacts} from '../../supabase/functions/_shared/gpt-final-decision/technical.mjs';
import {bars} from '../../supabase/functions/_shared/gpt-final-decision/facts.mjs';
import {reconstructCapture} from './replay-captures.mjs';
import {emergencyProtection} from '../../supabase/functions/_shared/gpt-final-decision/emergency-protection.mjs';
const read=n=>JSON.parse(gunzipSync(readFileSync(new URL('../../tests/fixtures/'+n+'.json.gz',import.meta.url))));
const hbar=read('hbar-production-20260929'),candles=read('hbar-completed-candles-20260929'),rows=read('hold-replay-captures-20260929');
const bytes=x=>Buffer.byteLength(JSON.stringify(x)),sections=x=>Object.entries(x??{}).map(([section,value])=>({section,bytes:bytes(value)})).sort((a,b)=>b.bytes-a.bytes);
const requests=[];
for(const row of hbar.filter(x=>x.record.packet.task==='HOLD')){
 const r=row.record,p=r.packet,f=await frozenReview(p,{snapshotAtMs:p.dynamic_as_of_ms}),a=r.result.arbitration;
 const payload=finalEvidenceTransport(arbitrationPayload(f,f,reviewsFor(a.first,a.deepseek))).payload;
 const before=r.result.request_bytes,after=bytes(payload),maxOutput=payload.max_output_tokens;
 requests.push({job_key:row.job_key,error_before:r.result.error,input_bytes_before:before,input_bytes_after:after,bound_bytes:130000,
  provider_model:r.result.model,max_output_tokens:maxOutput,parent_reserved_usd:r.reserved_usd,
  final_reservation_before:r.result.error==='FD_REQUEST_COST_BOUND'?0:'see paid ledger',final_actual_cost_before:r.result.error==='FD_REQUEST_COST_BOUND'?0:r.result.api_cost_usd,
  conservative_input_token_upper_bound_before:before+4096,conservative_input_token_upper_bound_after:after+4096,
  conservative_max_cost_before:(before+4096)*.75/1e6+maxOutput*4.5/1e6,conservative_max_cost_after:(after+4096)*.75/1e6+maxOutput*4.5/1e6,
  note:'Token count is the existing conservative admission bound (UTF-8 bytes + 4096), not tokenizer usage. Rejected FINAL was never reserved/dispatched; FIRST may have been billed.',
  original_market_sections:sections(a.final_input??a.initial_input),original_position_sections:sections(p.position),after_payload_sections:sections(payload),
  after_user_sections:sections(JSON.parse(payload.input[1].content)),physical_provider_ledger:row.provider_ledger});
}
const groups=Object.groupBy(rows,x=>x.position_id),replay=[];let validWindows=0;
for(const [id,unsorted] of Object.entries(groups)){
 const points=unsorted.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),entry=Number(points[0].entry_price),pnl=Number(points[0].realized_pnl_usdt);
 let peak=entry,first=null;
 for(let i=0;i<points.length;i++){
  peak=Math.max(peak,Number(points[i].payload.mid));if(i<24)continue;
  const c=reconstructCapture(points.slice(i-24,i+1));if(c?.status!=='AVAILABLE')continue;
  validWindows++;const now=Math.max(c.end_ms,c.ingested_at_ms),last=c.trajectory.at(-1),bid=last.mid*(1-last.spread_bps/20000);
  const protection=emergencyProtection({capture:c,now,bid,peak,hardFloor:entry*.975,technicalFailure:{error:'REPLAY_TECHNICAL_FAILURE'}});
  if(!first&&protection){const floors={};
   for(const seconds of [15,30,60,120]){
    const floor=Math.min(...c.trajectory.slice(-seconds/5).map(x=>x.mid*(1-x.spread_bps/20000)));
    const later=points.slice(i).find(x=>Number(x.payload.mid)*(1-Number(x.payload.spread_bps)/20000)<=floor+1e-12);
    floors[seconds]={floor,first_cross_at:later?.at??null,return_at_floor:floor/entry-1};
   }
   first={at:points[i].at,now,capture_end:c.end_ms,entry,peak,bid,action:protection.action,level:protection.level,floors};
  }
 }
 replay.push({position_id:id,symbol:points[0].symbol,recorded_pnl:pnl,entry_at:points[0].entry_at,closed_at:points[0].closed_at,recorded_rows:points.length,first_failure:first});
}
const technical=technicalFacts(bars(candles.one,60000,candles.asOf),bars(candles.five,300000,candles.asOf));
const report={source_main:'08665eb98f7bbe251896609f35a84bd0d0c9a081',source_executor_version:155,source_executor_hash:'5579ad81a2b5d56c712abe7fca97901e972179fc96de86787e5d9d66ae037b22',
 requests,technical:{at:candles.asOf,...technical},calibration:{positions:replay.length,valid_windows:validWindows,recorded_rows:rows.length,results:replay,
 limitation:'Six recorded positions (two winners/four losers). Recorded sampled bid floors, not simulated fills or a profitability guarantee. Gapped windows excluded. No future evidence enters the trigger; later outcomes only score candidates.'},
 fixtures:Object.fromEntries(['hbar-production-20260929','hbar-completed-candles-20260929','hold-replay-captures-20260929','soon-hold-20260929'].map(n=>[n,createHash('sha256').update(readFileSync(new URL('../../tests/fixtures/'+n+'.json.gz',import.meta.url))).digest('hex')]))};
writeFileSync(new URL('./audit.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({requests:requests.map(x=>({key:x.job_key,before:x.input_bytes_before,after:x.input_bytes_after,cost:x.conservative_max_cost_after})),technicals:technical.values,calibration:report.calibration},null,2));
