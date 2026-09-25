/** Run only saved point-in-time packets; no market reconstruction or outcome input.
 * Usage: node replay.mjs inputs.json output.jsonl EXACT_EXISTING_KEY_ENV_NAME
 * Input rows: {job_key,packet,snapshot_at_ms,source_commit,prompt_hash,schema_hash}.
 * Results are research observations; this program never changes production policy.
 */
import {readFile,open} from 'node:fs/promises';
import {sharedReview,callCounter,fuse,MODEL_CANDIDATES} from '../../supabase/functions/_shared/gpt-final-decision/parallel.mjs';
import {recheckPayload,validateRecheck} from '../../supabase/functions/_shared/gpt-final-decision/recheck.mjs';
import {payloadFor,callDecision,hash} from '../../supabase/functions/_shared/gpt-final-decision/api.mjs';
const [input,output,keyName]=process.argv.slice(2);
if(!input||!output||!keyName)throw Error('Usage: replay.mjs inputs.json output.jsonl EXISTING_KEY_ENV_NAME');
const key=process.env[keyName];
if(!key)throw Error('DEEPSEEK_KEY_MISSING');
if(!process.env.OPENAI_API_KEY)throw Error('OPENAI_KEY_MISSING');
const rows=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(rows))throw Error('INPUT_ARRAY_REQUIRED');
const seen=new Set();
for(const r of rows){
  if(!r.job_key||seen.has(r.job_key)||!r.source_commit||!r.packet||!Number.isSafeInteger(r.snapshot_at_ms))throw Error('INPUT_PROVENANCE');
  seen.add(r.job_key);
}
rows.sort((a,b)=>a.snapshot_at_ms-b.snapshot_at_ms||a.job_key.localeCompare(b.job_key));
// Exclusive output prevents accidental duplicate billing/overwriting an earlier run.
const file=await open(output,'wx');
try{
  for(const row of rows){
    const rc=row.packet.task==='RECHECK',inputPayload=rc?recheckPayload:payloadFor;
    const shared=await sharedReview(row.packet,{snapshotAtMs:row.snapshot_at_ms,inputPayload});
    // Research only: saved historical snapshot time and real API call times stay separate.
    // One GPT request shared by the two model comparisons; no duplicate GPT billing or
    // stochastic GPT-baseline differences between the candidate models.
    const started=Date.now(),timeoutMs=rc?4000:8000;
    const requests=[callDecision(shared.packet,{apiKey:process.env.OPENAI_API_KEY,timeoutMs,
      ...(rc?{payloadFn:recheckPayload,validate:validateRecheck}:{})}),
      ...MODEL_CANDIDATES.map(candidate=>callCounter(shared,{apiKey:key,...candidate,timeoutMs}))];
    const settled=await Promise.allSettled(requests);
    const get=i=>settled[i].status==='fulfilled'?settled[i].value:{valid:false,error:'PROVIDER_ERROR',decision:'ABSTAIN'};
    const gpt=get(0);
    await file.write(JSON.stringify({job_key:row.job_key,source_commit:row.source_commit,
      historical_prompt_hash:row.prompt_hash,historical_schema_hash:row.schema_hash,
      replay_payload_hash:await hash(inputPayload(shared.packet)),snapshot_hash:shared.snapshot_hash,
      snapshot_at_ms:row.snapshot_at_ms,replay_started_at_ms:started,gpt,
      candidates:MODEL_CANDIDATES.map((candidate,i)=>({candidate,counter:get(i+1),fusion:fuse(gpt,get(i+1),row.packet.task)}))})+'\n');
  }
}finally{await file.close();}
