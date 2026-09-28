// Order-free, internally authenticated measurement. No scheduler or trading writes.
// Closed after the three 2026-09-28 samples failed release gates. No paid calls in v2.
const MEASUREMENT_OPEN=false;
import {buildBatch,callBatch} from '../_shared/leader20/batch.mjs';
import {hash} from '../_shared/gpt-final-decision/snapshot-hash.mjs';
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
  if(!MEASUREMENT_OPEN)return Response.json({state:'AUDIT_CLOSED',reason:'BUDGET_AND_GROUNDING_GATES_FAILED',orders:0},{status:410});
  const body=await req.json();if(body.mode!=='measure-latest')return Response.json({error:'MODE'},{status:400});
  const ctl=(await db('leader20_control?singleton=eq.true'))[0];
  const members=await db('leader20_members?epoch_id=eq.'+ctl.epoch_id+'&rank=lte.10&order=rank');
  const asOf=Date.now();
  const rows=await Promise.all(members.map(async(m:any)=>({...m,capture:await db('rpc/doa_context_for_role_v1',
   {p_symbol:m.symbol,p_as_of:new Date(asOf).toISOString(),p_role:'TRADE_CANDIDATE',p_position_id:null})})));
  const packet=await buildBatch(rows,{asOf,epochId:ctl.epoch_id,generation:ctl.generation});
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
  return Response.json({job_key:job,as_of_ms:asOf,orders:0,batch_size:packet.symbols.length,
   ready:packet.symbols.filter((s:any)=>s.state==='READY').length,result});
 }catch(e){return Response.json({error:String(e instanceof Error?e.message:e).slice(0,200),orders:0},{status:500});}
});
