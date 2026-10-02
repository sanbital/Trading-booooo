// READ ONLY: fixed SQL projection, GET-only exchange allowlist, encrypted output.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,randomBytes,randomUUID,publicEncrypt} from 'node:crypto';
import {verifyClosedNativeAbsence} from './closed-native-proof.mjs';
const apply=process.env.NATIVE_PROOF_APPLY==='true';
if(apply&&(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.NATIVE_PROOF_VERSION!=='CLOSED_NATIVE_ABSENCE_1'))throw Error('PRODUCTION_RECONCILIATION_GUARD');
const project='etaajwpernzrcdrifdnw',evidence={version:'NATIVE_STOP_READ_PROOF_1',commit:process.env.GITHUB_SHA,utc:new Date().toISOString()};
function seal(){
 mkdirSync('infra-evidence',{recursive:true});const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(JSON.stringify(evidence)),cipher.final()]);
 const encryptedKey=publicEncrypt({key:readFileSync('ops/execution-infra/evidence-public.pem'),oaepHash:'sha256'},key);
 writeFileSync('infra-evidence/native-proof.encrypted.json',JSON.stringify({version:1,key:encryptedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
}
async function platform(path,options={}){
 const response=await fetch(path,{...options,signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('PLATFORM_HTTP_'+response.status);return response.json();
}
async function managed(query){return platform('https://api.supabase.com/v1/projects/'+project+'/database/query',{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query})});}
let rpcKey;
try{
 evidence.readiness=await managed('select pg_postmaster_start_time() postmaster,now() utc');
 if(apply){
  const marker=await managed("select obj_description(to_regprocedure('public.v18_reconcile_closed_native_absence(uuid,timestamptz,jsonb)')) marker");
  if(!marker[0]?.marker?.startsWith('CLOSED_NATIVE_ABSENCE_1:'))throw Error('RECONCILIATION_MIGRATION_MISSING');
  const keys=await platform('https://api.supabase.com/v1/projects/'+project+'/api-keys?reveal=true',{headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}});
  rpcKey=keys.find(k=>k.name==='service_role')?.api_key;if(!rpcKey)throw Error('RPC_KEY_UNAVAILABLE');
 }
 const query=`select p.id,p.symbol,p.entry_at,p.closed_at,p.state,p.remaining_quantity,p.original_quantity,
 p.metadata->>'executionMode' execution_mode,(p.metadata->>'v17ManualPosition')::boolean manual,
 (p.metadata->>'exitAccountingPending')::boolean accounting_pending,(p.metadata->>'v18EntryAccountingPending')::boolean entry_accounting_pending,
 coalesce(p.metadata->'v18Exits','{}'::jsonb) receipts,o->>'clientId' client_id,(o->>'submittedAt')::bigint submitted_ms,
 jsonb_build_object('clientId',o->'clientId','submittedAt',o->'submittedAt','terminal',o->'terminal','ackAt',o->'ackAt',
  'algoId',o->'algoId','actualOrderId',o->'actualOrderId','appliedQuantity',o->'appliedQuantity','accountingPending',o->'accountingPending',
  'crossLifecycleExecution',o->'crossLifecycleExecution','spec',jsonb_build_object('params',o#>'{spec,params}')) stop
 from public.v11_long_regime_positions p cross join lateral jsonb_array_elements(p.metadata#>'{exitProtection,orders}') o
 where p.state='CLOSED' and coalesce(o->>'terminal','false')<>'true' order by p.closed_at limit 20`;
 evidence.ledger=await managed(query);seal();
 const app=process.env.FLY_BINANCE_APP_NAME;if(!/^[a-z0-9-]+$/.test(app))throw Error('APP_INVALID');
 const base='https://api.machines.dev/v1/apps/'+app,headers={authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json'};
 const machines=await platform(base+'/machines',{headers}),machine=machines.find(m=>m.state==='started');if(!machine)throw Error('NO_RUNNING_MACHINE');
 const script=`const crypto=require('node:crypto');(async()=>{
 const rows=JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(evidence.ledger)).toString('base64')}','base64').toString());
 const base=(process.env.BINANCE_FUTURES_BASE_URL||'https://fapi.binance.com').replaceAll(/[/]$/g,'');
 if(base!=='https://fapi.binance.com')throw Error('EXCHANGE_HOST_INVALID');
 const time=await fetch(base+'/fapi/v1/time',{method:'GET',signal:AbortSignal.timeout(4000)}).then(r=>r.json()),offset=time.serverTime-Date.now();
 const allow=new Set(['/fapi/v1/algoOrder','/fapi/v1/allAlgoOrders','/fapi/v1/allOrders','/fapi/v1/userTrades','/fapi/v1/openAlgoOrders','/fapi/v1/openOrders','/fapi/v2/positionRisk']);
 async function read(path,params){if(!allow.has(path))throw Error('GET_ALLOWLIST');const q=new URLSearchParams({...params,timestamp:String(Date.now()+offset),recvWindow:'5000'});
 q.set('signature',crypto.createHmac('sha256',process.env.BINANCE_SECRET_KEY).update(q.toString()).digest('hex'));
 try{const r=await fetch(base+path+'?'+q,{method:'GET',headers:{'X-MBX-APIKEY':process.env.BINANCE_API_KEY},signal:AbortSignal.timeout(4000)}),data=await r.json();return {ok:r.ok,http:r.status,data};}
 catch(e){return {ok:false,error:e.name==='TimeoutError'?'TIMEOUT':'READ_FAILED'};}}
 const result={utc:new Date().toISOString(),rows:[]};
 for(const row of rows){
 if(!/^tb-v17s-[a-f0-9]{27}$/.test(row.client_id)||!/^([\\p{L}\\p{N}]+)USDT$/u.test(row.symbol)||!Number.isSafeInteger(Number(row.submitted_ms)))throw Error('LEDGER_ID_INVALID');
 const start=Number(row.submitted_ms)-5000,end=Date.now()+offset;if(end-start>=7*86400000){result.rows.push({id:row.id,client_id:row.client_id,symbol:row.symbol,error:'RETENTION_WINDOW_TOO_LARGE'});continue;}
 const params={symbol:row.symbol,startTime:start,endTime:end,limit:1000};
 result.rows.push({id:row.id,client_id:row.client_id,symbol:row.symbol,start,end,
 lookup:await read('/fapi/v1/algoOrder',{clientAlgoId:row.client_id}),
 history:await read('/fapi/v1/allAlgoOrders',params),orders:await read('/fapi/v1/allOrders',params),trades:await read('/fapi/v1/userTrades',params)});
 }
 [result.openAlgos,result.openOrders,result.positions]=await Promise.all([read('/fapi/v1/openAlgoOrders',{}),read('/fapi/v1/openOrders',{}),read('/fapi/v2/positionRisk',{})]);
 result.observed_at_ms=Date.now()+offset;
 console.log(JSON.stringify(result));})().catch(()=>{console.log(JSON.stringify({ok:false,error:'PROOF_FAILED'}));process.exitCode=1});`;
 // Shell quoting is explicit; script/data never contain credentials.
 const shellQuote=s=>"'"+s.replaceAll("'", "'\"'\"'")+"'";
 const result=await platform(base+'/machines/'+machine.id+'/exec',{method:'POST',headers,body:JSON.stringify({cmd:'node -e '+shellQuote(script),timeout:55})});
 evidence.exchange=result.exit_code===0?JSON.parse(result.stdout):{ok:false,error:'EXEC_PROOF_FAILED',encrypted_detail:String(result.stderr??'').slice(0,3000)};evidence.machine={app,id:machine.id,region:machine.region};seal();
 if(evidence.exchange?.ok===false)throw Error('EXCHANGE_PROOF_INCOMPLETE');
 evidence.verification=[];const proofs=[];
 for(const ledger of evidence.ledger){
  const proof=evidence.exchange.rows.find(r=>r.id===ledger.id&&r.client_id===ledger.client_id);
  try{const verified=verifyClosedNativeAbsence({ledger,proof,global:evidence.exchange,now:Date.now()});proofs.push(verified);evidence.verification.push({id:ledger.id,client_id:ledger.client_id,eligible:true});}
  catch(e){evidence.verification.push({id:ledger.id,client_id:ledger.client_id,eligible:false,error:String(e.message)});}
 }
 seal();
 if(apply&&proofs.length){
  // Structured RPC arguments: no proof data is interpolated into SQL or a shell.
  const response=await fetch('https://'+project+'.supabase.co/rest/v1/rpc/v18_reconcile_closed_native_absence',{method:'POST',
   headers:{apikey:rpcKey,authorization:'Bearer '+rpcKey,'content-type':'application/json'},
   body:JSON.stringify({p_owner:randomUUID(),p_postmaster:evidence.readiness[0].postmaster,p_proofs:proofs}),signal:AbortSignal.timeout(10000)});
  evidence.reconciliation={http:response.status,result:await response.json()};seal();
  if(!response.ok)throw Error('PROOF_RECONCILIATION_NOT_APPLIED');
 }
 if(apply&&proofs.length<evidence.ledger.length){evidence.error='RECONCILIATION_BACKLOG_REMAINS';seal();process.exitCode=2;}
 console.log('Encrypted native stop proof:',evidence.ledger.length,'checked,',proofs.length,'eligible,',apply?'RECONCILIATION':'READ_ONLY');
}catch(e){evidence.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PROOF_UNAVAILABLE';seal();console.log(evidence.error);process.exitCode=1;}
