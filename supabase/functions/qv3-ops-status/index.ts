import {createOpsHandler} from './handler.mjs';
const env=(k:string)=>(Deno.env.get(k)||'').trim();
Deno.serve(createOpsHandler({url:env('SUPABASE_URL'),key:env('SUPABASE_SERVICE_ROLE_KEY'),
 gatewayUrl:env('BINANCE_FUTURES_ORDER_GATEWAY_URL')||env('BINANCE_ORDER_GATEWAY_URL')||env('ORDER_GATEWAY_URL'),
 gatewaySecret:env('BINANCE_FUTURES_GATEWAY_SHARED_SECRET')||env('BINANCE_GATEWAY_SHARED_SECRET')||env('GATEWAY_SHARED_SECRET')}));
