from pathlib import Path
import shutil,json,hashlib,sys
root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
shared=root/'supabase/functions/_shared/gpt-final-review'
expected={'contract.mjs':'79d992e29054d91e272ae55b25b2b0d2b3282ac2','coordinator.mjs':'dac8c61ec31758a84bc90f056dd553e05ed4345c','market.mjs':'08ac5a98e4ca9cb67a00033913a9044ad2c21e57','openai.mjs':'5e86982d2882a5ab1ffcbac85e5d2c6d157b4d50','prompt.mjs':'e04e958df2946d49ad3a3d18397fb50c7544c8ba','supabase-store.mjs':'c5e6e01078a3c5bcc077e1353fd1a1bc3c1891ba'}
for name,sha in expected.items():
 b=(shared/name).read_bytes();actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
 if actual!=sha: raise SystemExit('BASELINE_MODULE_CHANGED:'+name)
def change(path,old,new):
 s=path.read_text();assert s.count(old)==1,(path.name,old[:70],s.count(old));path.write_text(s.replace(old,new))
# Compact transport expands to the unchanged canonical evidence validator.
p=shared/'contract.mjs'
change(p,"export const VERSION = 'GPT_FINAL_ENTRY_REVIEW_2';","export const VERSION = 'GPT_FINAL_ENTRY_REVIEW_3_LATENCY';")
insert=r'''
/** Short transport keys and numeric evidence references only reduce serialization.
 * Expand back into the original strict contract before ANY verdict can be used. */
const refSchema={type:'integer',minimum:0,maximum:255};
const compactEvidence=obj({p:refSchema,v:{type:['number','boolean','null']},u:str(40),n:str(80)});
export const WIRE_OUTPUT_SCHEMA=obj({c:str(80),h:str(64),
  d:{type:'string',enum:['PASS','VETO','ABSTAIN']},
  a:{type:'string',enum:['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE']},
  k:{type:'array',minItems:1,maxItems:8,items:obj({i:{type:'string',enum:[...FACTORS,'CURRENT_REACCELERATION']},
    v:{type:'string',enum:['SUPPORTED','CONTRADICTED','UNKNOWN']},e:{type:'array',maxItems:6,items:refSchema}})},
  s:{type:'array',maxItems:3,items:compactEvidence},o:{type:'array',maxItems:3,items:compactEvidence},
  m:{type:'array',maxItems:24,items:refSchema},n:str(120)});
export function evidenceReferences(packet){
  const paths=[];
  for(const root of ['original_model/metrics','original_model/factors','current_market/metrics']){
    const [a,b]=root.split('/');
    for(const key of Object.keys(packet?.[a]?.[b]??{}).sort()){
      const path='/'+root+'/'+key;evidenceAt(packet,path);paths.push(path);
    }
  }
  ensure(paths.length>0&&paths.length<=256,'EVIDENCE_REFERENCE_COUNT');return paths;
}
export function compactInput(packet){
  const input={...packet,evidence_refs:evidenceReferences(packet)};
  ensure(new TextEncoder().encode(JSON.stringify(input)).length<=LIMITS.inputBytes,'INPUT_TOO_LARGE');return input;
}
export function toWireAnswer(answer,packet){
  const refs=evidenceReferences(packet),ref=p=>{const i=refs.indexOf(p);ensure(i>=0,'EVIDENCE_REFERENCE_UNKNOWN');return i;};
  const ev=e=>({p:ref(e.field_path),v:e.observed_value,u:e.unit,n:e.interpretation});
  return {c:answer.candidate_id,h:answer.snapshot_hash,d:answer.decision,a:answer.assessment,
    k:answer.checked_claims.map(c=>({i:c.claim_id,v:c.verdict,e:c.evidence_paths.map(ref)})),
    s:answer.supporting_evidence.map(ev),o:answer.opposing_evidence.map(ev),m:answer.missing_fields.map(ref),n:answer.summary};
}
export function expandWireAnswer(wire,packet){
  validateShape(wire,WIRE_OUTPUT_SCHEMA);const refs=evidenceReferences(packet);
  const path=i=>{ensure(Number.isSafeInteger(i)&&i>=0&&i<refs.length,'EVIDENCE_REFERENCE_INVALID');return refs[i];};
  const ev=e=>({field_path:path(e.p),observed_value:e.v,unit:e.u,interpretation:e.n});
  return {candidate_id:wire.c,snapshot_hash:wire.h,decision:wire.d,assessment:wire.a,
    checked_claims:wire.k.map(c=>({claim_id:c.i,verdict:c.v,evidence_paths:c.e.map(path)})),
    supporting_evidence:wire.s.map(ev),opposing_evidence:wire.o.map(ev),missing_fields:wire.m.map(path),summary:wire.n};
}
'''
change(p,"export function validateShape(v,s,p='$') {",insert+"\nexport function validateShape(v,s,p='$') {")
change(p,"ensure(ts.includes(t),`TYPE:${p}`);","ensure(ts.includes(t)||(t==='number'&&ts.includes('integer')&&Number.isSafeInteger(v)),`TYPE:${p}`);\n  if(t==='number'){ensure(v>=(s.minimum??-Infinity)&&v<=(s.maximum??Infinity),`NUMBER:${p}`);}")
change(p,"export function parseApiResponse(raw) {","export function parseApiResponse(raw,packet=null) {")
change(p,"ensure(chunks.length===1,'API_OUTPUT_COUNT');return JSON.parse(chunks[0]);","ensure(chunks.length===1,'API_OUTPUT_COUNT');const parsed=JSON.parse(chunks[0]);\n  return packet?expandWireAnswer(parsed,packet):parsed;")
p=shared/'prompt.mjs'
change(p,"export const SYSTEM_PROMPT = `","export const SYSTEM_PROMPT = `짧은 전송 형식만 사용한다. c=candidate_id, h=snapshot_hash, d=decision, a=assessment, k=checked_claims, s=supporting_evidence, o=opposing_evidence, m=missing_fields, n=summary다.\nk의 각 항목은 i=claim_id, v=verdict, e=근거 참조 번호 배열이다. s와 o의 각 항목은 p=근거 참조 번호, v=observed_value, u=unit, n=interpretation이다.\n근거 참조 번호는 evidence_refs 배열의 영 기준 인덱스다. 반드시 그 경로의 실제 입력값과 단위를 그대로 인용한다.\n원래 조건 검토와 현재 재가속 검토는 생략하지 않는다. 각 조건의 근거 참조는 필요한 최소 개수만 쓴다.\nPASS의 수치 근거는 서로 다른 두 개 이상이며 최신 시장 근거를 포함한다. s와 o는 각각 최대 세 개다. 요약은 짧은 한 문장, 해석은 짧은 한 구절만 쓴다.\n")
p=shared/'openai.mjs'
change(p,'MODEL,LIMITS,OUTPUT_SCHEMA,ensure,parseApiResponse,validateAnswer','MODEL,LIMITS,WIRE_OUTPUT_SCHEMA,compactInput,ensure,parseApiResponse,validateAnswer')
change(p,"service_tier:'default',","service_tier:'default',prompt_cache_key:'boo-final-review-v3-latency',")
change(p,"JSON.stringify(packet)","JSON.stringify(compactInput(packet))")
change(p,"name:'current_entry_final_review_v2',strict:true,schema:OUTPUT_SCHEMA","name:'entry_final_review_v3_compact',strict:true,schema:WIRE_OUTPUT_SCHEMA")
change(p,'parseApiResponse(raw),packet','parseApiResponse(raw,packet),packet')
p=shared/'coordinator.mjs'
change(p,'LIMITS,OUTPUT_SCHEMA,canonical','LIMITS,OUTPUT_SCHEMA,WIRE_OUTPUT_SCHEMA,canonical')
change(p,'this.pending=new Map();','this.pending=new Map();this.readyHints=new Map();this.yieldArmed=false;')
change(p,'schema:OUTPUT_SCHEMA,limits:LIMITS','schema:OUTPUT_SCHEMA,wireSchema:WIRE_OUTPUT_SCHEMA,limits:LIMITS')
change(p,"this.tickets.delete(String(s?.id));","this.tickets.delete(String(s?.id));\n    for(const [k,h] of this.readyHints)if(h.signalId===String(s?.id))this.readyHints.delete(k);")
change(p,"await this.store.save(key,owner,'DONE',record);return record.result?.valid===true;",r'''await this.store.save(key,owner,'DONE',record);
    // Mark ready only after durable save and complete raw-response validation.
    // This hint can shorten observation waiting, but a new lease cycle still
    // rereads and validates the journal before it creates an entry ticket.
    const checked=await this.validateStored({record},record.identity_json,record.expires_at_ms,record.binding).catch(()=>null);
    if(checked?.allowed)this.readyHints.set(key,{signalId:record.identity.signal_id,validUntil:checked.ticket.validUntil});
    return record.result?.valid===true;''')
change(p,'parseApiResponse(z.raw_response),r.packet','parseApiResponse(z.raw_response,r.packet),r.packet')
change(p,'  /** Called only AFTER runWithLease has returned, never from the order path. */',r'''  /** Pure scheduling hint. No database/network wait on the protection loop. */
  consumeReadyYield(){
    if(this.config.mode!=='ENFORCE'||!this.yieldArmed||!this.authorized())return false;
    const now=this.now();
    for(const [key,hint] of this.readyHints){
      if(now>=hint.validUntil){this.readyHints.delete(key);continue;}
      if(this.tracked.has(key)){this.yieldArmed=false;return true;}
    }
    return false;
  }
  /** Called only AFTER runWithLease has returned, never from the order path. */''')
p=root/'supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs'
change(p,"  return {candidates,reason:reviews.some(r=>r.reason==='GPT_REVIEW_PENDING')?'GPT_REVIEW_PENDING':reviews.at(-1)?.reason??'GPT_NO_CANDIDATE',reviews};", "  const pending=reviews.some(r=>r.reason==='GPT_REVIEW_PENDING');\n  c.yieldArmed=candidates.length===0&&pending;\n  return {candidates,reason:pending?'GPT_REVIEW_PENDING':reviews.at(-1)?.reason??'GPT_NO_CANDIDATE',reviews};")
change(p,'export function gptFinalCheck(db,s)',"export function gptReviewReadyToResume(db){return coordinatorFor(db).consumeReadyYield();}\nexport function gptFinalCheck(db,s)")
(shared/'candle-cache.mjs').write_text(r'''/** Per-isolate, public candle-only request coalescing. No credentials or verdicts. */
const caches=new WeakMap();
export function cacheFor(fetchFn){
  if(!caches.has(fetchFn))caches.set(fetchFn,new CandleReadCache());
  return caches.get(fetchFn);
}
export class CandleReadCache {
  constructor({ttlMs=1000,maxEntries=64}={}){this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.entries=new Map();}
  async read(key,load,now=Date.now){
    const at=now();let row=this.entries.get(key);
    if(row&&at-row.startedAt>=0&&((row.value&&at-row.value.receivedAt<=this.ttlMs)||(!row.value&&at-row.startedAt<=2500)))
      return structuredClone(await row.promise);
    if(row)this.entries.delete(key);
    while(this.entries.size>=this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    row={startedAt:at,promise:null,value:null};
    row.promise=Promise.resolve().then(load).then(value=>{
      if(!Number.isSafeInteger(value?.requestedAt)||!Number.isSafeInteger(value?.receivedAt)||value.receivedAt<value.requestedAt||!Array.isArray(value.rows))
        throw Error('CANDLE_CACHE_INPUT_INVALID');
      row.value=structuredClone(value);return row.value;
    }).catch(error=>{if(this.entries.get(key)===row)this.entries.delete(key);throw error;});
    this.entries.set(key,row);return structuredClone(await row.promise);
  }
}
''')
p=shared/'market.mjs'
change(p,"const MIN=60000;","import {cacheFor} from './candle-cache.mjs';\nconst MIN=60000;")
change(p,"    const abort=AbortSignal.timeout(ms);", "    const load=async()=>{\n    const abort=AbortSignal.timeout(ms);")
change(p,"    return {rows:JSON.parse(text),requestedAt:requested,receivedAt:now()};","    return {rows:JSON.parse(text),requestedAt:requested,receivedAt:now()};\n    };\n    // A caller-specific cancellation must not cancel another caller's shared read.\n    return signal?load():cacheFor(fetchFn).read(url,load,now);")
p=root/'development/gpt-final-review/tests/helpers.mjs'
change(p,'decisionIdentity,MODEL','decisionIdentity,MODEL,toWireAnswer')
change(p,'rawResponse(mutate(answer(p,decision)))','rawResponse(toWireAnswer(mutate(answer(p,decision)),p))')
(root/'development/gpt-final-review/wire-executor-latency-v3.mjs').write_text(r'''/** Local/source-only integration. Never deploys, touches secrets, or starts trading. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const EXPECTED_EXECUTOR_BLOB='80b79fb449ad01e4534bfa1076b75a142f887650';
export const FAST_HOOKS=[
 {from:'import {gptFilterExecutable,gptFinalCheck,runWithGptReview} from "./gpt-final-review-adapter.mjs";',
  to:'import {gptFilterExecutable,gptFinalCheck,runWithGptReview,gptReviewReadyToResume} from "./gpt-final-review-adapter.mjs";'},
 {from:'    nextAt=Math.max(nextAt+1000,Date.now()+1);\n  }\n  if(!summary.endedReason',
  to:'    // Only after this observation and every detected protection action finish.\n    // A ready hint cannot trade: release the normal lease, then re-run all guards.\n    if(gptReviewReadyToResume(db)){summary.endedReason="GPT_REVIEW_READY";break;}\n    nextAt=Math.max(nextAt+1000,Date.now()+1);\n  }\n  if(!summary.endedReason'}
];
export const blob=s=>{const b=Buffer.from(s);return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
export function transformFast(source){
 if(blob(source)!==EXPECTED_EXECUTOR_BLOB)throw Error('EXECUTOR_BASELINE_CHANGED');
 let out=source;
 for(const h of FAST_HOOKS){if(out.split(h.from).length!==2)throw Error('FAST_HOOK_NOT_UNIQUE');out=out.replace(h.from,h.to);}
 let restored=out;for(const h of [...FAST_HOOKS].reverse())restored=restored.replace(h.to,h.from);
 if(restored!==source)throw Error('BASELINE_RESTORE_FAILED');return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const path=resolve(process.argv[2]??'supabase/functions/v10-lane-executor/index.ts'),out=transformFast(readFileSync(path,'utf8'));
 if(!process.argv.includes('--write')){console.log('Source preview only; add --write to update this local checkout.');process.exit(0);}
 writeFileSync(path,out);console.log(JSON.stringify({executor_blob:blob(out),reversible_hooks:2,production_deployed:false,orders:0}));
}
''')
print('runtime and transport changes built')
