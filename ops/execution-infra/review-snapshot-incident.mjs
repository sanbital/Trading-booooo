import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes,createCipheriv,publicEncrypt} from 'node:crypto';
const project='etaajwpernzrcdrifdnw',version='REVIEW_SNAPSHOT_EPOCH_145_1';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.REVIEW_VERSION!==version||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA)throw Error('REVIEW_PRODUCTION_GUARD');
const ev={version,commit:process.env.GITHUB_SHA,utc:new Date().toISOString()};
function seal(){mkdirSync('infra-evidence',{recursive:true});const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(ev)),c.final()]);writeFileSync('infra-evidence/snapshot-review.encrypted.json',JSON.stringify({version:1,key:publicEncrypt({key:readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));}
async function request(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('REVIEW_HTTP_'+r.status);return r.json();}
const db=query=>request(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query})});
try{
 const fn=await request(`https://api.supabase.com/v1/projects/${project}/functions/v10-lane-executor`,{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}});
 if(fn.version!==Number(process.env.REVIEW_EXECUTOR_VERSION)||fn.version<190||fn.status!=='ACTIVE')throw Error('REVIEW_FIXED_EXECUTOR_REQUIRED');
 ev.before=await db("select pg_postmaster_start_time() postmaster,to_jsonb(r) runtime from public.v11_long_regime_runtime r where singleton");seal();
 const app='trading-booooo-sanbital-gateway',base=`https://api.machines.dev/v1/apps/${app}`,headers={authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json'};
 const machines=await request(base+'/machines',{headers}),machine=machines.find(m=>m.state==='started');if(!machine)throw Error('REVIEW_NO_RUNNING_GATEWAY');
 const script=`const c=require('node:crypto');(async()=>{const h=await fetch('http://127.0.0.1:8080/health').then(r=>r.json());if(h.deployment_commit!==${JSON.stringify(process.env.GITHUB_SHA)}||h.order_writer.required!==true)throw Error('BUILD');const secret=c.createHash('sha256').update('gateway:'+process.env.LEARNING_ACCESS_TOKEN).digest('hex');async function read(action){const body=JSON.stringify({exchange:'binance_futures',action}),ts=String(Date.now()),nonce=c.randomUUID(),sig=c.createHmac('sha256',secret).update(ts+'\\n'+nonce+'\\n'+body).digest('hex');const r=await fetch('http://127.0.0.1:8080/v1/command',{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':sig},body,signal:AbortSignal.timeout(4000)}),d=await r.json();if(!r.ok||!d.ok)throw Error('READ');return d.result}const [portfolio,openOrders]=await Promise.all([read('p10_portfolio'),read('v18_open_orders')]);console.log(JSON.stringify({portfolio,openOrders}));})().catch(()=>{console.log(JSON.stringify({error:'READ_FAILED'}));process.exitCode=1});`;
 const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 const proof=await request(base+'/machines/'+machine.id+'/exec',{method:'POST',headers,body:JSON.stringify({cmd:'node -e '+quote(script),timeout:10})});
 if(proof.exit_code!==0)throw Error('REVIEW_VENUE_PROOF_FAILED');
 const evidence=JSON.parse(proof.stdout);if(evidence.error)throw Error('REVIEW_VENUE_PROOF_FAILED');
 const a={version,commit:process.env.GITHUB_SHA,owner:randomUUID(),postmaster:ev.before[0].postmaster,evidence};ev.review=a;seal();
 const literal="'"+JSON.stringify(a).replaceAll("'","''")+"'";
 ev.result=await db(readFileSync('ops/execution-infra/review-snapshot-incident.sql','utf8').replace('__REVIEW_JSON__',literal));seal();
 if(ev.result[0]?.circuit_open!==true||ev.result[0]?.incident_generation!==146||ev.result[0]?.incident_kind!=='INCOMPLETE_OR_STALE_SNAPSHOT')throw Error('REVIEW_RETAINED_CIRCUIT_POSTCONDITION');
 console.log(JSON.stringify({utc:new Date().toISOString(),commit:ev.commit,result:ev.result,status:'CLASSIFIED_CIRCUIT_RETAINED_WAITING_ORIGINAL_RECOVERY'}));
}catch(e){ev.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'REVIEW_FAILED';seal();console.error(ev.error);process.exitCode=1;}
