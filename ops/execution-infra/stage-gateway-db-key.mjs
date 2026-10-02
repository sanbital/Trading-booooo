import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
/** Called only by the authorized deploy workflow. Stages a DB credential without
 * restarting a Machine or changing either feature flag. Never prints key/body/CLI output.
 */
export async function stageGatewayDatabaseKey({env=process.env,fetchImpl=fetch,run=spawnSync}={}) {
 const project=env.SUPABASE_PROJECT_REF,app=env.FLY_DATABASE_KEY_APP;
 if(project!=='etaajwpernzrcdrifdnw'||!['trading-booooo','trading-booooo-sanbital-gateway'].includes(app)) throw Error('DB_KEY_PRODUCTION_TARGET_MISMATCH');
 if(!env.SUPABASE_ACCESS_TOKEN||!env.FLY_API_TOKEN) throw Error('DB_KEY_DEPLOY_CREDENTIALS_MISSING');
 const response=await fetchImpl(`https://api.supabase.com/v1/projects/${project}/api-keys?reveal=true`,{
  headers:{authorization:'Bearer '+env.SUPABASE_ACCESS_TOKEN},signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('DB_KEY_LOOKUP_UNAVAILABLE');
 const keys=await response.json(),key=Array.isArray(keys)?keys.find(k=>k.name==='service_role')?.api_key:null;
 if(typeof key!=='string'||!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw Error('DB_KEY_LEGACY_SERVICE_ROLE_MISSING');
 // stdin avoids embedding secrets in process arguments. Both streams are captured
 // and discarded; an error never logs a raw subprocess or Management API body.
 const result=run('flyctl',['secrets','import','--stage','-a',app],{
  input:`SUPABASE_SERVICE_ROLE_KEY=${key}\n`,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 if(result.status!==0)throw Error('DB_KEY_STAGE_FAILED');
 return {staged:true,flagsChanged:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 stageGatewayDatabaseKey().then(()=>console.log('Database credential staged; feature flags unchanged.'))
  .catch(()=>{console.error('Database credential staging failed; deployment must stop.');process.exitCode=1;});
}
