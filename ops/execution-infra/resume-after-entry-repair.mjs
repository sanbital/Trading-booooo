// Restore only the automatic pause raised while the repaired bot entry could not
// settle. The existing endpoint independently reconciles before changing control.
const project='etaajwpernzrcdrifdnw';
if(process.env.GITHUB_REPOSITORY!=='sanbital/Trading-booooo'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.EXPECTED_COMMIT!==process.env.GITHUB_SHA)throw Error('ENTRY_REPAIR_SOURCE_GUARD');
const query="select jsonb_build_object('settings',(select jsonb_build_object('mode',mode,'pause',pause_new_entries,'reason',pause_lock_reason,'withdrawal',withdrawal_mode,'manual',manual_intervention_required,'kill',scalp_kill_switch,'emergency',emergency_liquidation) from public.trading_settings where id=1),'order',(select jsonb_build_object('state',state,'exchange_order_id',exchange_order_id,'position_id',position_id) from public.v11_long_regime_orders where id='d0b1f1bb-9b0f-4a46-87f0-d33136540a90'),'runtime',(select jsonb_build_object('incident_id',incident_id,'generation',incident_generation,'live',live_enabled) from public.v11_long_regime_runtime where singleton)) proof;";
const r=await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`,{method:'POST',headers:{authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(20000)});
if(!r.ok)throw Error('ENTRY_REPAIR_CONTROL_READ');
const [{proof}]=await r.json(),s=proof.settings,o=proof.order,rt=proof.runtime;
if(s.mode!=='LIVE_LIMITED'||s.pause!==true||s.reason!=='P10_UNTRACKED_FUTURES_EXPOSURE'||['withdrawal','manual','kill','emergency'].some(k=>s[k]!==false)||
 o.state!=='FILLED'||o.exchange_order_id!=='908375043'||o.position_id!=='867a39a4-9495-4251-986a-731e83b91a1c'||rt.live!==true||rt.incident_id!=='60544c58-9756-4e2e-b5d4-58433b93779b'||Number(rt.generation)!==201)throw Error('ENTRY_REPAIR_RESUME_IDENTITY_GUARD');
const response=await fetch(`https://${project}.supabase.co/functions/v1/market-autotrader`,{method:'POST',headers:{'content-type':'application/json','x-autotrade-token':process.env.LEARNING_ACCESS_TOKEN,'x-region':'ap-northeast-1'},body:JSON.stringify({action:'resume'}),signal:AbortSignal.timeout(45000)});
const result=await response.json();
if(!response.ok||result.ok!==true)throw Error('ENTRY_REPAIR_SAFE_RESUME_REFUSED:'+String(result.error??response.status));
console.log(JSON.stringify({status:'SAFE_RESUME_ACCEPTED_CIRCUIT_RECOVERY_GUARDS_RETAINED',observed_at:new Date().toISOString()}));
