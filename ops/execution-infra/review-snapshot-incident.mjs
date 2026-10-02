import {readSnapshotReviewProof} from './snapshot-review-proof.mjs';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID,randomBytes,createCipheriv,publicEncrypt} from 'node:crypto';
const project='etaajwpernzrcdrifdnw',version='REVIEW_SNAPSHOT_EPOCH_145_1';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.REVIEW_VERSION!==version||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA)throw Error('REVIEW_PRODUCTION_GUARD');
const ev={version,commit:process.env.GITHUB_SHA,utc:new Date().toISOString()};
function seal(){mkdirSync('infra-evidence',{recursive:true});const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(ev)),c.final()]);writeFileSync('infra-evidence/snapshot-review.encrypted.json',JSON.stringify({version:1,key:publicEncrypt({key:readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}));}
async function request(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});if(!r.ok){ev.transportFailure={http:r.status,encryptedResponse:await r.text()};throw Error('REVIEW_HTTP_'+r.status);}return r.json();}
const db=query=>request(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query})});
try{
 const fn=await request(`https://api.supabase.com/v1/projects/${project}/functions/v10-lane-executor`,{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}});
 if(fn.version!==Number(process.env.REVIEW_EXECUTOR_VERSION)||fn.version<190||fn.status!=='ACTIVE')throw Error('REVIEW_FIXED_EXECUTOR_REQUIRED');
 const keys=await request(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`,{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}}),key=keys.find(k=>k.name==='service_role')?.api_key;if(!key)throw Error('REVIEW_RPC_KEY_UNAVAILABLE');
 ev.before=await db("select pg_postmaster_start_time() postmaster,to_jsonb(r) runtime from public.v11_long_regime_runtime r where singleton");seal();
 const evidence=await readSnapshotReviewProof({app:process.env.FLY_BINANCE_APP_NAME,token:process.env.LEARNING_ACCESS_TOKEN,commit:process.env.REVIEW_GATEWAY_COMMIT});
 const a={version,expectedIncident:'4e0deb37-e159-4521-ad90-916f58fc1cc6',previousIncident:'3d38253a-77a8-4b6b-ae78-6b38d41987a1',commit:process.env.GITHUB_SHA,owner:randomUUID(),postmaster:ev.before[0].postmaster,evidence};ev.review=a;seal();
 const response=await fetch(`https://${project}.supabase.co/rest/v1/rpc/trading_review_snapshot_epoch145`,{method:'POST',headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({p_review:a}),signal:AbortSignal.timeout(3000)});
 if(!response.ok){ev.transportFailure={http:response.status,encryptedResponse:await response.text()};throw Error('REVIEW_RPC_HTTP_'+response.status);}
 ev.result=[await response.json()];seal();
 if(ev.result[0]?.circuit_open!==true||ev.result[0]?.incident_generation!==146||ev.result[0]?.incident_kind!=='INCOMPLETE_OR_STALE_SNAPSHOT')throw Error('REVIEW_RETAINED_CIRCUIT_POSTCONDITION');
 console.log(JSON.stringify({utc:new Date().toISOString(),commit:ev.commit,result:ev.result,status:'CLASSIFIED_CIRCUIT_RETAINED_WAITING_ORIGINAL_RECOVERY'}));
}catch(e){ev.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'REVIEW_FAILED';seal();console.error(ev.error);process.exitCode=1;}
