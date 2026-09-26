// Runs only in the dedicated GitHub deployment job. Secrets never enter artifacts or CLI arguments.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const app='sanbital-doa-capture-20260925';
const sha=createHash('sha256').update(readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
function fly(args,input){const r=spawnSync('flyctl',args,{input,encoding:'utf8',maxBuffer:2000000});if(r.status!==0)throw Error('Fly command failed: '+args.slice(0,2).join(' ')+' '+r.stderr);return r.stdout;}
async function query(sql){
 const r=await fetch('https://api.supabase.com/v1/projects/etaajwpernzrcdrifdnw/database/query',{method:'POST',headers:{Authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query:sql}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('Supabase management query failed '+r.status);return await r.json();
}
if(process.env.GITHUB_REF!=='refs/heads/release/doa-capture-20260925')throw Error('WRONG_BRANCH');
const controls=await query('select protocol_sha256,enabled,ends_at from doa_capture.control where id=1');
if(controls[0]?.protocol_sha256!==sha || !controls[0]?.enabled || Date.parse(controls[0].ends_at)<=Date.now())throw Error('CONTROL_NOT_READY');
const tokens=await query("select token from public.edge_internal_tokens where name='doa-capture'");
const token=tokens[0]?.token;if(!/^[a-f0-9]{64}$/.test(token||''))throw Error('MISSING_DEDICATED_TOKEN');
console.log('::add-mask::'+token);
const apps=JSON.parse(fly(['apps','list','--json']));
if(!apps.some(x=>(x.Name||x.name)===app))fly(['apps','create',app,'--org','personal','--yes']);
const before=JSON.parse(fly(['machine','list','--app',app,'--json']));
if(before.length)throw Error('EXISTING_MACHINE_REQUIRES_EXPLICIT_REVIEW');
fly(['secrets','import','--stage','--app',app],'CAPTURE_TOKEN='+token+'\n');
const image='registry.fly.io/'+app+':'+process.env.GITHUB_SHA;
fly(['auth','docker']);
const push=spawnSync('docker',['push',image],{stdio:'inherit'});if(push.status!==0)throw Error('IMAGE_PUSH_FAILED');
fly(['machine','run',image,'--app',app,'--region','cdg','--name','doa-capture','--vm-cpu-kind','shared','--vm-cpus','1','--vm-memory','256','--restart','no','--rm','--autostart=false','--env','CAPTURE_ENDPOINT=https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest','--env','PROTOCOL_SHA256='+sha]);
const machines=JSON.parse(fly(['machine','list','--app',app,'--json']));
writeFileSync('capture-release.json',JSON.stringify({app,sha:process.env.GITHUB_SHA,protocol_sha256:sha,machines:machines.map(x=>({id:x.id,state:x.state,region:x.region}))},null,2));
console.log(readFileSync('capture-release.json','utf8'));
