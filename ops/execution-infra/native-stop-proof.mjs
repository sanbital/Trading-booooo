// READ ONLY: fixed SQL projection, GET-only exchange allowlist, encrypted output.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,randomBytes,publicEncrypt} from 'node:crypto';
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
try{
 const query=`select p.id,p.symbol,p.entry_at,p.closed_at,p.state,p.remaining_quantity,o->>'clientId' client_id,
 (o->>'submittedAt')::bigint submitted_ms,o->>'submitError' submit_error
 from public.v11_long_regime_positions p cross join lateral jsonb_array_elements(p.metadata#>'{exitProtection,orders}') o
 where p.state='CLOSED' and coalesce(o->>'terminal','false')<>'true' order by p.closed_at limit 20`;
 evidence.ledger=await platform('https://api.supabase.com/v1/projects/'+project+'/database/query',{method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query})});seal();
 const app=process.env.FLY_BINANCE_APP_NAME;if(!/^[a-z0-9-]+$/.test(app))throw Error('APP_INVALID');
 const base='https://api.machines.dev/v1/apps/'+app,headers={authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json'};
 const machines=await platform(base+'/machines',{headers}),machine=machines.find(m=>m.state==='started');if(!machine)throw Error('NO_RUNNING_MACHINE');
 const script=`const crypto=require('node:crypto');(async()=>{
 const rows=JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(evidence.ledger)).toString('base64')}','base64').toString());
 const base=(process.env.BINANCE_FUTURES_BASE_URL||'https://fapi.binance.com').replaceAll(/[/]$/g,'');
 if(base!=='https://fapi.binance.com')throw Error('EXCHANGE_HOST_INVALID');
 const time=await fetch(base+'/fapi/v1/time',{signal:AbortSignal.timeout(4000)}).then(r=>r.json()),offset=time.serverTime-Date.now();
 const allow=new Set(['/fapi/v1/algoOrder','/fapi/v1/allAlgoOrders','/fapi/v1/allOrders','/fapi/v1/userTrades','/fapi/v1/openAlgoOrders','/fapi/v2/positionRisk']);
 async function read(path,params){if(!allow.has(path))throw Error('GET_ALLOWLIST');const q=new URLSearchParams({...params,timestamp:String(Date.now()+offset),recvWindow:'5000'});
 q.set('signature',crypto.createHmac('sha256',process.env.BINANCE_SECRET_KEY).update(q.toString()).digest('hex'));
 try{const r=await fetch(base+path+'?'+q,{headers:{'X-MBX-APIKEY':process.env.BINANCE_API_KEY},signal:AbortSignal.timeout(4000)}),data=await r.json();return {ok:r.ok,http:r.status,data};}
 catch(e){return {ok:false,error:e.name==='TimeoutError'?'TIMEOUT':'READ_FAILED'};}}
 const result={utc:new Date().toISOString(),rows:[],openAlgos:await read('/fapi/v1/openAlgoOrders',{}),positions:await read('/fapi/v2/positionRisk',{})};
 for(const row of rows){
 if(!/^tb-v17s-[a-f0-9]{27}$/.test(row.client_id)||!/^([\\p{L}\\p{N}]+)USDT$/u.test(row.symbol)||!Number.isSafeInteger(Number(row.submitted_ms)))throw Error('LEDGER_ID_INVALID');
 const start=Number(row.submitted_ms)-5000,end=Date.now()+offset;if(end-start>=7*86400000)throw Error('RETENTION_WINDOW_TOO_LARGE');
 const params={symbol:row.symbol,startTime:start,endTime:end,limit:1000};
 result.rows.push({id:row.id,client_id:row.client_id,symbol:row.symbol,start,end,
 lookup:await read('/fapi/v1/algoOrder',{clientAlgoId:row.client_id}),
 history:await read('/fapi/v1/allAlgoOrders',params),orders:await read('/fapi/v1/allOrders',params),trades:await read('/fapi/v1/userTrades',params)});
 }
 console.log(JSON.stringify(result));})().catch(()=>{console.log(JSON.stringify({ok:false,error:'PROOF_FAILED'}));process.exitCode=1});`;
 // Shell quoting is explicit; script/data never contain credentials.
 const shellQuote=s=>"'"+s.replaceAll("'", "'\"'\"'")+"'";
 const result=await platform(base+'/machines/'+machine.id+'/exec',{method:'POST',headers,body:JSON.stringify({cmd:'node -e '+shellQuote(script),timeout:55})});
 evidence.exchange=result.exit_code===0?JSON.parse(result.stdout):{ok:false,error:'EXEC_PROOF_FAILED',encrypted_detail:String(result.stderr??'').slice(0,3000)};evidence.machine={app,id:machine.id,region:machine.region};seal();
 if(evidence.exchange?.ok===false)throw Error('EXCHANGE_PROOF_INCOMPLETE');
 console.log('Encrypted read-only native stop proof collected:',evidence.ledger.length,'ledger rows');
}catch(e){evidence.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PROOF_UNAVAILABLE';seal();console.log(evidence.error);process.exitCode=1;}
