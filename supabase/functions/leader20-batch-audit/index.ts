// Order-free, internally authenticated measurement. No scheduler or trading writes.
// A bounded release verification window; never connected to a scheduler or orders.
const MEASUREMENT_OPEN_UNTIL=0; // Closed after the bounded, order-free release measurements.
import {buildBatch,callBatch,unpackSymbol,TIME_COLUMNS} from '../_shared/leader20/batch.mjs';
import {hash} from '../_shared/gpt-final-decision/snapshot-hash.mjs';
import {FD1_ENTRY_ENGINE} from '../_shared/gpt-final-decision/engine.mjs';
import {callDecision,MODEL} from '../_shared/gpt-final-decision/api.mjs';
import {batchFinalPayload,batchFinalDecision} from '../_shared/leader20/final.mjs';
const base=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
async function db(path:string,body?:unknown){
 const r=await fetch(base+'/rest/v1/'+path,{method:body===undefined?'GET':'POST',
  headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json'},
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const value=await r.json();if(!r.ok)throw Error(value?.message??'AUDIT_DB');return value;
}
Deno.serve(async req=>{
 try{
  const auth=(await db('edge_internal_tokens?name=eq.v10-lane-signal-generator&select=token&limit=1'))[0]?.token;
  if(!auth||req.headers.get('x-v10-lane-token')!==auth)return Response.json({error:'UNAUTHORIZED'},{status:401});
  if(Date.now()>=MEASUREMENT_OPEN_UNTIL)return Response.json({state:'AUDIT_CLOSED',reason:'VERIFICATION_WINDOW_ENDED',orders:0},{status:410});
  const body=await req.json();if(!['measure-latest','paired-latest','measure-final','replay-positive'].includes(body.mode))return Response.json({error:'MODE'},{status:400});
  const ctl=(await db('leader20_control?singleton=eq.true'))[0];
  const members=await db('leader20_members?epoch_id=eq.'+ctl.epoch_id+'&rank=lte.10&order=rank');
  let asOf=Date.now();
  const rows:any[]=[];
  const captureRow=async(m:any)=>{
   if(body.mode==='paired-latest'){
    const identity={symbol:m.symbol,signal_id:'audit:'+m.symbol+':'+asOf,trigger_at_ms:asOf,
     rank:m.rank,reference_close:null,day_return:null,judgments:{legacy_models:'OPTIONAL_ADVISORY_ONLY'},
     leader20:{version:'LEADER20_DYNAMIC_1',epoch_id:ctl.epoch_id,generation:ctl.generation}};
    const frozen=await FD1_ENTRY_ENGINE.prepare(identity,{fetchFn:fetch,now:Date.now,deadlineMs:Date.now()+18000});
    const c=frozen.packet.facts.capture_context;
    const receipts=(c?.trajectory??[]).map((x:any)=>x.received_at_ms).filter(Number.isFinite);
    const ingested=receipts.length?Math.max(...receipts):null;
    return {...m,frozen:frozen.packet,capture:c?.status==='AVAILABLE'?{...c,ingested_at_ms:ingested}:
     c??{status:'UNAVAILABLE',reason:'MISSING_CAPTURE'}};
   }
   return {...m,capture:await db('rpc/doa_context_for_role_v1',
    {p_symbol:m.symbol,p_as_of:new Date(asOf).toISOString(),p_role:'TRADE_CANDIDATE',p_position_id:null})};
  };
  if(body.mode==='replay-positive'){
   if(!Array.isArray(body.source_jobs)||body.source_jobs.length!==10||!body.source_jobs.every((x:any)=>/^[a-f0-9]{64}$/.test(x)))throw Error('TEN_STORED_SOURCES_REQUIRED');
   const sources=await db('gpt_final_entry_reviews?job_key=in.('+body.source_jobs.join(',')+')&select=job_key,symbol,decision,valid,purpose,record');
   if(sources.length!==10)throw Error('STORED_SOURCES_MISSING');
   for(const source of sources){
    if(source.purpose!=='PRODUCTION'||source.decision!=='BUY'||!source.valid)throw Error('SOURCE_NOT_HISTORICAL_BUY');
    const p=source.record.result?.final_packet??source.record.packet,c=p.facts.capture_context;
    const at=Number(source.record.result?.final_snapshot_at_ms??source.record.snapshot_at_ms);
    if(c?.status!=='AVAILABLE')throw Error('SOURCE_CAPTURE_UNAVAILABLE');
    const receipts=c.trajectory.map((x:any)=>x.received_at_ms).filter(Number.isFinite);
    rows.push({symbol:source.symbol+'@'+source.job_key.slice(0,8),rank:null,market_symbol:source.symbol,source_job:source.job_key,
     frozen:{...p,dynamic_as_of_ms:at},capture:{...c,ingested_at_ms:Math.max(...receipts)}});
   }
  }else if(body.mode==='paired-latest'){
   // Sequential preparation avoids exhausting the Edge runtime's outgoing
   // connection limit. Each historical snapshot retains its own original clock.
   for(const m of members)rows.push(await captureRow(m));
  }else rows.push(...await Promise.all(members.map(captureRow)));
  let packet:any;
  if(body.mode==='paired-latest'||body.mode==='replay-positive'){
   const pieces=await Promise.all(rows.map(async(row:any)=>{
    const at=row.frozen.dynamic_as_of_ms;
    const b=await buildBatch(rows.map((r:any)=>r===row?r:{...r,capture:{status:'UNAVAILABLE',reason:'OTHER_REPLAY_CLOCK'}}),
     {asOf:at,epochId:ctl.epoch_id,generation:ctl.generation});
    return {b,s:b.symbols.find((s:any)=>s.id===row.symbol),at};
   }));
   const columns=[...new Set(pieces.flatMap(x=>x.b.columns))].sort();
   packet={version:'TOP10_FROZEN_REPLAY_1',mode:'HISTORICAL_INDEPENDENT_CLOCKS',as_of_ms:null,
    epoch_id:ctl.epoch_id,generation:ctl.generation,columns,
    symbols:pieces.map(({b,s,at}:any)=>({...s,source_as_of_ms:at,matrix:unpackSymbol(b,s).map((p:any)=>columns.map(k=>{
     const v=p[k]??null;return v!==null&&TIME_COLUMNS.has(k)?v-s.time_origin_ms:v;
    }))}))};
   packet.batch_hash=await hash(packet);
  }else packet=await buildBatch(rows,{asOf,epochId:ctl.epoch_id,generation:ctl.generation});
  if(packet.symbols.every((s:any)=>s.state!=='READY'))return Response.json({error:'NO_VALID_DATA',symbols:packet.symbols,orders:0});
  const config=(await db('gpt_final_review_control?singleton=eq.true'))[0];
  const job=await hash({audit:'TOP10_BATCH_ORDER_FREE_1',batch:packet.batch_hash});
  const record={kind:'TOP10_BATCH_AUDIT',purpose:'VERIFICATION',authority:[],api_approval_ref:config.approval_ref,
   identity:{symbol:'TOP10'},packet,snapshot_at_ms:asOf,result:null};
  const claim=await db('rpc/gpt_final_review_claim',{p_job_key:job,p_record:record,
   p_cap_usd:config.daily_cap_usd,p_max_calls:config.max_calls_per_day,p_reserve_usd:.25});
  if(!claim.created)return Response.json({duplicate:true,job_key:job,orders:0});
  const result=await callBatch(packet,{apiKey:Deno.env.get('deepseek api')});
  const journal={...result,model_requested:'deepseek-flash',valid:result.results.every((r:any)=>r.valid),
   usage:result.usage?{...result.usage,input_tokens:result.input_tokens,output_tokens:result.output_tokens,
    input_tokens_details:{cached_tokens:result.cached_input_tokens}}:null};
  await db('rpc/gpt_final_review_complete',{p_job_key:job,p_owner:claim.row.owner,p_record:{...record,result:journal}});
  const pairs:any[]=[];
  if(body.mode==='replay-positive')for(const row of rows){
   const advice=result.results.find((r:any)=>r.id===row.symbol);
   pairs.push({symbol:row.market_symbol,source_job:row.source_job,historical_gpt:'BUY',
    deepseek:advice?.decision,valid:advice?.valid,reason:advice?.reason,
    missed_in_this_snapshot:advice?.decision!=='PASS',source_as_of_ms:row.frozen.dynamic_as_of_ms});
  }
  if(body.mode==='paired-latest'||body.mode==='measure-final'){
   // Replay the exact frozen packets, with their original clocks. These API calls
   // have no signals, lease, ticket, order or position writer. WAIT/SKIP controls
   // are included to measure misses; no candidate decision is changed to PASS.
   const comparisonRows=body.mode==='measure-final'?rows.filter((r:any)=>result.results.some((x:any)=>x.id===r.symbol&&x.valid&&x.decision==='PASS')).slice(0,1):rows;
   for(let start=0;start<comparisonRows.length;start+=1)await Promise.all(comparisonRows.slice(start,start+1).map(async(row:any)=>{
    const advice=result.results.find((x:any)=>x.id===row.symbol);
    if(row.capture.status!=='AVAILABLE'||!advice?.valid){pairs.push({symbol:row.symbol,skipped:'DATA_OR_ADVICE_INVALID'});return;}
    if(body.mode==='measure-final'){
     const prepared=await FD1_ENTRY_ENGINE.prepare({symbol:row.symbol,signal_id:'audit:'+job,trigger_at_ms:Date.now(),rank:row.rank,
      reference_close:row.capture.trajectory.at(-1).mid,day_return:null,judgments:{legacy_models:'OPTIONAL_ADVISORY_ONLY'},
      leader20:{version:'LEADER20_DYNAMIC_1',epoch_id:ctl.epoch_id,generation:ctl.generation}},
      {fetchFn:fetch,now:Date.now,deadlineMs:Date.now()+20000});
     row.frozen=prepared.packet;
    }
    const p=structuredClone(row.frozen);p.leader20.batch_advice=advice;
    p.snapshot_hash=await hash({...p,snapshot_hash:''});
    const child=await hash({audit:'TOP10_PAIRED_FROZEN_GPT_1',parent:job,symbol:row.symbol});
    const rec={kind:'TOP10_PAIRED_FROZEN_GPT',purpose:'VERIFICATION',authority:[],
     api_approval_ref:config.approval_ref,identity:{symbol:row.symbol},packet:p,
     paired_batch_job:job,snapshot_at_ms:p.dynamic_as_of_ms,result:null};
    let c;
    try{c=await db('rpc/gpt_final_review_claim',{p_job_key:child,p_record:rec,
     p_cap_usd:config.daily_cap_usd,p_max_calls:config.max_calls_per_day,p_reserve_usd:.25});}
    catch(e){pairs.push({symbol:row.symbol,skipped:String(e instanceof Error?e.message:e)});return;}
    if(!c.created){pairs.push({symbol:row.symbol,skipped:'ALREADY_REVIEWED'});return;}
    const options:any={apiKey:Deno.env.get('OPENAI_API_KEY'),payloadFn:batchFinalPayload,timeoutMs:20000};
    const g=body.mode==='measure-final'?await batchFinalDecision(p,options):await callDecision(p,options);
    await db('rpc/gpt_final_review_complete',{p_job_key:child,p_owner:c.row.owner,
     p_record:{...rec,result:{...g,model_requested:MODEL}}});
    pairs.push({symbol:row.symbol,job_key:child,deepseek:advice.decision,gpt:g.decision,
     valid:g.valid,error:g.error,cost_usd:g.api_cost_usd,usage:'usage' in g?g.usage:null,latency_ms:'latency_ms' in g?g.latency_ms:null,
     capture_end_ms:p.facts.capture_context.end_ms,matched_capture:advice.last_ms===p.facts.capture_context.end_ms});
   }));
  }
  return Response.json({job_key:job,as_of_ms:asOf,orders:0,batch_size:packet.symbols.length,
   ready:packet.symbols.filter((s:any)=>s.state==='READY').length,result,pairs});
 }catch(e){return Response.json({error:String(e instanceof Error?e.message:e).slice(0,200),orders:0},{status:500});}
});
