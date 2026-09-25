async function digest(s){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));}
export function createHandler({getToken,invoke}) {return async req=>{
 const respond=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
 if(req.method!=='POST')return respond({error:'METHOD'},405);
 const token=req.headers.get('x-doa-capture-token')||'';
 if(!/^[a-f0-9]{64}$/.test(token))return respond({error:'UNAUTHORIZED'},401);
 try{
  const expected=await getToken();if(!expected)return respond({error:'UNAUTHORIZED'},401);
  const [a,b]=await Promise.all([digest(token),digest(expected)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  if(diff)return respond({error:'UNAUTHORIZED'},401);
  if(+(req.headers.get('content-length')||0)>500000)return respond({error:'BODY_CAP'},413);
  const reader=req.body?.getReader();let bytes=0;const chunks=[];
  if(reader)for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>500000){await reader.cancel();return respond({error:'BODY_CAP'},413);}chunks.push(r.value);}
  const data=new Uint8Array(bytes);let off=0;for(const c of chunks){data.set(c,off);off+=c.length;}
  const body=JSON.parse(new TextDecoder().decode(data));
  if(!['watch','ingest','status'].includes(body.action))return respond({error:'ACTION'},400);
  return respond(await invoke(body.action,body));
 }catch{return respond({error:'CAPTURE_REQUEST_FAILED'},503);}
};}
