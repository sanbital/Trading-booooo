/** Patches a LOCAL checkout only, never GitHub, Supabase, secrets or deployment. */
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,cpSync,existsSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const EXPECTED_BLOB='b3cb11693036b8761bbe2618508f33ba1738e5d1';
export const replacements=[
  {name:'runtime_import',from:'import {entryExecutionWindow,normalizeEntryBook,gatewayTakerFeeRate,supportedFuturesMode,entryPriceEvidence} from "./entry-evidence.mjs";',
    to:'import {entryExecutionWindow,normalizeEntryBook,gatewayTakerFeeRate,supportedFuturesMode,entryPriceEvidence} from "./entry-evidence.mjs";\nimport {gptFilterExecutable,gptFinalCheck,runWithGptReview} from "./gpt-final-review-adapter.mjs";'},
  {name:'candidate_queue_before_claim',from:'const runDeadline=Date.now()+ENTRY_RUN_BUDGET_MS;\nlet attempts=0;\nfor(const s of executable){',
    to:'const gptReviewed=await gptFilterExecutable(db,executable);\nif(executable.length&&!gptReviewed.candidates.length)entry={entered:false,reason:gptReviewed.reason};\nconst runDeadline=Date.now()+ENTRY_RUN_BUDGET_MS;\nlet attempts=0;\nfor(const s of gptReviewed.candidates){'},
  {name:'entry_final_confirmation',from:'await requireLeaderEntryControls(db);\nconst exitPolicy=rec(s.features?.exitPolicy);',
    to:'const gptEntryCheck=gptFinalCheck(db,s);\nif(!gptEntryCheck.allowed)return{entered:false,reason:gptEntryCheck.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL};\nattempt.gptFinalReview=gptEntryCheck.review??null;\nawait requireLeaderEntryControls(db);\nconst exitPolicy=rec(s.features?.exitPolicy);'},
  {name:'predispatch_no_io_confirmation',from:'await verifyExecutionLease(db);\nconst id=cid("v11e",s.id),rp=',
    to:'await verifyExecutionLease(db);\n// Pure final check; no GPT/network call after the execution quote.\nconst gptDispatchCheck=gptFinalCheck(db,s);\nif(!gptDispatchCheck.allowed)return{entered:false,reason:gptDispatchCheck.reason,releaseClaim:true,releaseScope:RELEASE_SCOPE.SYMBOL};\nconst id=cid("v11e",s.id),rp='},
  {name:'resume_only_after_original_lease_release',from:'return res(200,await runWithLease(db));',
    to:'return res(200,await runWithGptReview(db,runWithLease));'}
];
export function gitBlob(text){const b=Buffer.from(text);return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');}
export function transform(source){
  if(source.includes('gpt-final-review-adapter'))throw Error('ALREADY_PATCHED');
  for(const r of replacements){if(source.split(r.from).length!==2)throw Error('ANCHOR_NOT_UNIQUE:'+r.name);source=source.replace(r.from,r.to);}
  return source;
}
export function checkedTransform(source){if(gitBlob(source)!==EXPECTED_BLOB)throw Error('CURRENT_BASELINE_CHANGED_REVIEW_REQUIRED');return transform(source);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const root=process.argv[2],write=process.argv.includes('--write');
  if(!root)throw Error('Usage: node apply-current.mjs /path/to/local/Trading-booooo [--write]');
  const path=join(resolve(root),'supabase/functions/v10-lane-executor/index.ts');
  const original=readFileSync(path,'utf8'),patched=checkedTransform(original);
  const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  if(write){
    const backup=join(resolve(root),'development/gpt-final-review/original-index.ts.backup');
    if(existsSync(backup))throw Error('BACKUP_ALREADY_EXISTS');
    if(existsSync(path+'.gpt-final.tmp'))throw Error('PATCH_TEMP_ALREADY_EXISTS');
    for(const rel of ['supabase/functions/_shared/gpt-final-review','supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs']){
      const to=join(resolve(root),rel);if(existsSync(to))throw Error('MODULE_ALREADY_EXISTS:'+rel);
    }
    mkdirSync(dirname(backup),{recursive:true});writeFileSync(backup,original,{flag:'wx'});
    cpSync(join(packageRoot,'supabase/functions/_shared/gpt-final-review'),join(resolve(root),'supabase/functions/_shared/gpt-final-review'),{recursive:true});
    copyFileSync(join(packageRoot,'supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs'),join(resolve(root),'supabase/functions/v10-lane-executor/gpt-final-review-adapter.mjs'));
    writeFileSync(path+'.gpt-final.tmp',patched,{flag:'wx'});renameSync(path+'.gpt-final.tmp',path);
  }
  console.log(JSON.stringify({baseline_blob:EXPECTED_BLOB,new_blob:gitBlob(patched),local_written:write,
    modified_executor_regions:replacements.map(r=>r.name),production_deployed:false,sql_executed:false,api_called:false},null,2));
}
