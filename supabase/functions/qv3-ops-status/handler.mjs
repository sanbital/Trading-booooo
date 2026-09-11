const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const equal=(a,b)=>{if(!a||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
export function createOpsHandler({url,key,gatewayUrl,gatewaySecret,fetchFn=fetch,now=Date.now}){
  async function command(action){
    if(!['p10_portfolio','v18_open_orders','symbol_info'].includes(action))throw Error('READ_ONLY_ACTION');
    const cmd={exchange:'binance_futures',action,...(action==='symbol_info'?{market:'4USDT'}:{})};
    const raw=JSON.stringify(cmd),ts=String(now()),nonce=crypto.randomUUID();
    const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(gatewaySecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(`${ts}\n${nonce}\n${raw}`)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const r=await fetchFn(`${gatewayUrl.replace(/\/$/,'')}/v1/command`,{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':sig},body:raw,signal:AbortSignal.timeout(10000)});
    const d=await r.json();return {httpStatus:r.status,ok:r.ok&&d.ok===true,version:d.version??null,result:d.result??null,error:d.ok===true?null:String(d.error??'FAILED').slice(0,180)};
  }
  return async req=>{
    if(req.method!=='POST')return reply(405,{ok:false});
    if(url!=='https://etaajwpernzrcdrifdnw.supabase.co'||!key||!gatewayUrl||!gatewaySecret)return reply(503,{ok:false,error:'ENV'});
    try{
      const r=await fetchFn(`${url}/rest/v1/edge_internal_tokens?select=token&name=eq.v16-futures-position-diagnostic&limit=1`,{method:'GET',headers:{apikey:key,authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000)});
      const rows=await r.json();if(!r.ok||!equal(req.headers.get('x-v16-diagnostic-token')||'',String(rows[0]?.token??'')))return reply(401,{ok:false,error:'UNAUTHORIZED'});
      const b=await req.json();if(b?.mode!=='snapshot'||Object.keys(b).some(x=>x!=='mode'))return reply(400,{ok:false,error:'INVALID_MODE'});
      const startedAt=now();
      const healthResponse=await fetchFn(`${gatewayUrl.replace(/\/$/,'')}/health`,{method:'GET',signal:AbortSignal.timeout(5000)});
      const h=await healthResponse.json();
      const reads=await Promise.allSettled(['p10_portfolio','v18_open_orders','symbol_info'].map(command));
      const output=Object.fromEntries(reads.map((x,i)=>[['portfolio','openOrders','symbol4USDT'][i],x.status==='fulfilled'?x.value:{ok:false,error:'READ_FAILED'}]));
      return reply(200,{ok:true,readOnlyTrading:true,startedAt: new Date(startedAt).toISOString(),finishedAt:new Date(now()).toISOString(),
        health:{httpStatus:healthResponse.status,version:h.version,opsPatch:h.ops_patch,schedulerEnabled:h.scheduler_enabled,intervals:h.intervals,capabilities:h.capabilities},...output,
        gatewaySourceHashVerified:false,positionModeVerified:false});
    }catch{return reply(503,{ok:false,error:'OPERATING_STATUS_READ_FAILED'});}
  };
}
