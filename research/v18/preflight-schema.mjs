/** Read-only deployment prerequisite. Never applies migrations or changes controls. */
const token=process.env.SUPABASE_ACCESS_TOKEN,project=process.env.SUPABASE_PROJECT_REF;
if(!token||!project)throw Error('V18_SCHEMA_PREFLIGHT_CREDENTIALS');
const query="select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name='v11_long_regime_positions' and column_name in ('entry_fee_usdt','realized_pnl_usdt')";
const response=await fetch('https://api.supabase.com/v1/projects/'+encodeURIComponent(project)+'/database/query',{
 method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error('V18_SCHEMA_PREFLIGHT_HTTP_'+response.status);
const rows=await response.json();
if(!Array.isArray(rows)||rows.length!==2||rows.some(r=>r.is_nullable!=='YES'))throw Error('V18_NULLABLE_ACCOUNTING_MIGRATION_REQUIRED');
console.log('V18 nullable accounting prerequisite verified.');
