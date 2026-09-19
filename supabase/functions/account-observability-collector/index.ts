import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { REVISION, snapshotEvidence } from "./core.ts";
const env = (n: string) => (Deno.env.get(n) || "").trim();
const reply = (s: number, body: unknown) => new Response(JSON.stringify(body), {status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
function equal(a: string,b: string) {let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++) d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;}
async function portfolioRead() {
  const url=(env("BINANCE_FUTURES_ORDER_GATEWAY_URL") || env("BINANCE_ORDER_GATEWAY_URL") || env("ORDER_GATEWAY_URL")).replace(/\/$/,"");
  const secret=env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET") || env("BINANCE_GATEWAY_SHARED_SECRET") || env("GATEWAY_SHARED_SECRET");
  if(!url || !secret) throw new Error("GATEWAY_CONFIG_MISSING");
  // Fixed read-only command: caller input can never choose an exchange command.
  const body=JSON.stringify({exchange:"binance_futures",action:"p10_portfolio"});
  const ts=String(Date.now()),nonce=crypto.randomUUID();
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${ts}\n${nonce}\n${body}`));
  const signature=[...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,"0")).join("");
  const r=await fetch(`${url}/v1/command`,{method:"POST",headers:{"content-type":"application/json","x-gateway-ts":ts,"x-gateway-nonce":nonce,"x-gateway-signature":signature},body,signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`PORTFOLIO_HTTP_${r.status}`);
  const data=await r.json();
  if(data?.ok!==true) throw new Error("PORTFOLIO_READ_FAILED");
  return {raw:data.result,capturedAt:new Date().toISOString()};
}
async function trackedRows(db: any,table: string,columns: string,states: string[],generic=false) {
  const rows: any[]=[];
  for(let page=0;page<20;page++) {
    let q=db.from(table).select(columns).in("state",states).order("id").range(page*500,page*500+499);
    if(generic) q=q.eq("exchange","binance_futures").eq("is_paper",false);
    const {data,error}=await q;
    if(error) throw new Error(`TRACKED_READ:${table}:${error.code||"ERROR"}`);
    rows.push(...data);
    if(data.length<500) return rows;
  }
  throw new Error(`TRACKED_READ_TRUNCATED:${table}`);
}
Deno.serve(async req=>{
  if(req.method!=="POST") return reply(405,{ok:false,error:"POST_ONLY"});
  const url=env("SUPABASE_URL"),key=env("SUPABASE_SERVICE_ROLE_KEY");
  if(!url || !key) return reply(500,{ok:false,error:"DB_CONFIG_MISSING"});
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    const supplied=req.headers.get("x-v10-executor-token")||"";
    const token=await db.from("edge_internal_tokens").select("token").eq("name","v10-lane-executor").maybeSingle();
    if(token.error || !supplied || !token.data?.token || !equal(supplied,token.data.token)) return reply(401,{ok:false,error:"UNAUTHORIZED"});
    const body=await req.json().catch(()=>({})),mode=body.mode||"collect";
    if(!["collect","diagnostic"].includes(mode)) return reply(400,{ok:false,error:"INVALID_MODE"});
    const [account,settings,generic,v11,v10]=await Promise.all([
      portfolioRead(),
      db.from("trading_settings").select("binance_futures_allocation_mode,binance_futures_allocation_usdt,binance_futures_reserve_usdt").eq("id",1).single(),
      trackedRows(db,"trading_positions","id,market,position_side,remaining_quantity",["OPEN","EXITING","RECONCILING","RECONCILIATION_FAILED"],true),
      trackedRows(db,"v11_long_regime_positions","id,symbol,side,remaining_quantity",["OPEN","CLOSE_SUBMITTED","RECONCILIATION_FAILED"]),
      trackedRows(db,"v10_lane_positions","id,symbol,side,remaining_quantity",["OPEN","CLOSE_SUBMITTED","RECONCILIATION_FAILED"]),
    ]);
    if(settings.error) throw new Error("ALLOCATION_SETTINGS_READ_FAILED");
    const evidence=snapshotEvidence(account.raw,settings.data,[...generic,...v11,...v10],account.capturedAt);
    let storedId: number|null=null;
    if(mode==="collect") {
      // Sole write target. No management enrollment, reconciliation RPC or trading switch.
      const saved=await db.from("trading_account_snapshots").insert(evidence.snapshot).select("id").maybeSingle();
      if(saved.error) throw new Error(`SNAPSHOT_WRITE:${saved.error.code||"ERROR"}`);
      storedId=saved.data?.id??null;
    }
    return reply(200,{ok:true,revision:REVISION,mode,captured_at:account.capturedAt,stored_id:storedId,stored:storedId!==null,snapshot:evidence.snapshot,unmatched_positions:evidence.unmatched_positions,db_positions_missing_on_exchange:evidence.db_positions_missing_on_exchange,orders_submitted:0,controls_changed:false});
  } catch(e) {
    // A failed or incomplete read never writes a zero snapshot or refreshes old evidence.
    return reply(503,{ok:false,revision:REVISION,error:e instanceof Error?e.message:"OBSERVATION_FAILED",orders_submitted:0,controls_changed:false});
  }
});
