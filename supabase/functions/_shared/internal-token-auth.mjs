// Authentication remains fail-closed. A failed credential dependency is retryable,
// rather than a permanent invalid-token result that disables a safety scheduler.
function equal(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function authenticateInternalToken({db,request,name,header}){
 const supplied=(request.headers.get(header)||'').trim();
 if(!supplied)return {allowed:false,status:401,error:'UNAUTHORIZED'};
 let result;
 try{result=await db.from('edge_internal_tokens').select('token').eq('name',name).maybeSingle();}
 catch{return {allowed:false,status:503,error:'AUTH_DEPENDENCY_UNAVAILABLE'};}
 if(result?.error)return {allowed:false,status:503,error:'AUTH_DEPENDENCY_UNAVAILABLE'};
 const expected=result?.data?.token;
 if(typeof expected!=='string'||!expected)return {allowed:false,status:503,error:'AUTH_TOKEN_NOT_CONFIGURED'};
 return equal(supplied,expected)?{allowed:true,status:200}:{allowed:false,status:401,error:'UNAUTHORIZED'};
}
