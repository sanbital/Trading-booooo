import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as policy from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import * as exit from '../../supabase/functions/_shared/leader-exit-review.mjs';
import * as ops from '../../supabase/functions/_shared/leader-operations.mjs';
import * as settlement from '../../supabase/functions/_shared/leader-settlement.mjs';
import {createGatewayProtection} from '../../supabase/functions/_shared/leader-protection-adapter.mjs';
import {protectNewLeaderPosition} from '../../supabase/functions/_shared/leader-entry-protection.mjs';
const source=readFileSync(new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url),'utf8');
export function executorHarness({enabled=false,gateway,protection,fetch,env={},verifyLease=async()=>{}}={}){
 const ctx={...policy,...exit,...ops,...settlement,leaderPortfolioMatches:policy.portfolioMatches,protectNewLeaderPosition,
  createGatewayProtection:protection??createGatewayProtection,console,crypto,Date,Map,WeakMap,Set,Number,Math,Promise,String,Object,Array,JSON,Error,
  setTimeout,clearTimeout,TextEncoder,AbortController,Response,Request,fetch,
  Deno:{env:{get:k=>k==='V17_NATIVE_STOP'&&enabled?'true':env[k]??''},serve:fn=>{ctx.handle=fn;}},createClient:()=>ctx.db};
 vm.createContext(ctx);vm.runInContext(source.replace(/^import .*;\r?\n/gm,''),ctx);
 if(gateway)ctx.gateway=gateway;
 ctx.verifyExecutionLease=verifyLease;
 return ctx;
}
