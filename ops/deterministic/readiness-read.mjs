// Observe the same region as the production clock. Runner geography is not
// production market-data truth; never silently fall back to another region.
export async function readReadiness({project,slug,token,body,region,fetchImpl=fetch}){
 const modes={'v10-lane-executor':['account-recovery','ops-readiness'],'v10-lane-signal-generator':['diagnostic']};
 if(project!=='etaajwpernzrcdrifdnw'||region!=='ap-northeast-1'||!modes[slug]?.includes(body?.mode)||Object.keys(body).length!==1||!token)throw Error('READINESS_REQUEST_NOT_ALLOWED');
 const r=await fetchImpl(`https://${project}.supabase.co/functions/v1/${slug}`,{method:'POST',headers:{'content-type':'application/json','x-region':region,[slug==='v10-lane-executor'?'x-v10-executor-token':'x-v10-lane-token']:token},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('READINESS_ENDPOINT_HTTP_'+r.status);
 if(r.headers.get('x-sb-edge-region')!==region)throw Error('READINESS_REGION_CHANGED');
 const result=await r.json();if(result.ok!==true)throw Error('READINESS_ENDPOINT_REPORTED_FAILURE');return result;
}
