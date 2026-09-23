/** Local/source-only integration. Never deploys, touches secrets, or starts trading. */
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
