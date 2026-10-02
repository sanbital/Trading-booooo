/** Where the shadow connects, and as whom. Only host/port/database and the pooler tenant
 * suffix are taken from SUPABASE_DB_URL; its user and password are never read. The login is
 * always the dedicated role shadow_le_writer with the per-request credential. */
export const ROLE='shadow_le_writer';
export function dbTarget(dbUrl,supabaseUrl){
  let ref=null;
  try{ref=new URL(String(supabaseUrl??'')).hostname.split('.')[0]||null;}catch{/* none */}
  let host=null,port=5432,database='postgres',suffix=null;
  try{
    const u=new URL(String(dbUrl??''));
    host=u.hostname||null;port=Number(u.port||5432);database=decodeURIComponent(u.pathname.replace(/^\//,''))||'postgres';
    const user=decodeURIComponent(u.username||'');
    suffix=user.includes('.')?user.slice(user.indexOf('.')+1):null;
  }catch{/* fall back to the project's direct host */}
  if(!host&&ref){host='db.'+ref+'.supabase.co';port=5432;}
  // Supavisor identifies the tenant by "<role>.<project_ref>"
  if(!suffix&&host&&/pooler\.supabase\.com$/.test(host))suffix=ref;
  return {host,port,database,username:suffix?ROLE+'.'+suffix:ROLE};
}
