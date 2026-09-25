// LE-SHADOW-1 order-free proof: static inspection of the function's whole local import graph
// (what `supabase functions deploy` bundles) plus the fetch allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQL} from '../supabase/functions/leader-emerging-shadow/store.mjs';
import {createGuard,binanceWeight,GuardError} from '../supabase/functions/leader-emerging-shadow/guard.mjs';
import {ALT1_PROMPT} from '../supabase/functions/leader-emerging-shadow/prompt.mjs';
import {dbTarget} from '../supabase/functions/leader-emerging-shadow/dbtarget.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ENTRY=resolve(ROOT,'supabase/functions/leader-emerging-shadow/index.ts');

/** Local import graph from the entrypoint (static and dynamic string imports). */
function graph(entry){
  const seen=new Map(),external=new Set(),stack=[entry];
  while(stack.length){
    const f=stack.pop();if(seen.has(f))continue;
    const src=readFileSync(f,'utf8');seen.set(f,src);
    for(const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)){
      const spec=m[1]??m[2]??m[3];
      if(spec.startsWith('.')){const p=resolve(dirname(f),spec);assert.ok(existsSync(p),'missing import '+spec);stack.push(p);}
      else external.add(spec);
    }
  }
  return {files:[...seen.keys()].map(f=>relative(ROOT,f)).sort(),sources:[...seen.values()],external:[...external].sort()};
}
const G=graph(ENTRY),BUNDLE=G.sources.join('\n');

test('bundle = only the shadow directory plus the listed pure production modules', ()=>{
  const allowed=new Set(['supabase/functions/_shared/leader-momentum-v17.mjs','supabase/functions/_shared/leader-slot-sizing.mjs',
    'supabase/functions/_shared/leader-b06133-entry.mjs','supabase/functions/_shared/gpt-final-review/contract.mjs',
    'supabase/functions/_shared/gpt-final-decision/market.mjs','supabase/functions/_shared/gpt-final-decision/facts.mjs',
    'supabase/functions/_shared/leader-cec0040.mjs','supabase/functions/_shared/leader-exit-review.mjs']);
  for(const f of G.files)assert.ok(f.startsWith('supabase/functions/leader-emerging-shadow/')||allowed.has(f),'unexpected module in bundle: '+f);
  assert.deepEqual(G.external,['npm:postgres@3.4.5']);
  assert.ok(!G.files.some(f=>/v10-lane-executor|v10-lane-signal-generator|v30-front-shadow|gateway|coordinator|supabase-store|openai\.mjs|engine\.mjs|recheck\.mjs|api\.mjs|prompt\.mjs$/.test(f)&&!f.includes('leader-emerging-shadow/')),'forbidden module');
});

test('bundle contains no order / lease / CEC-RPC / production-GPT-ledger / gateway / service-key string', ()=>{
  for(const s of ['/v1/command','create_order','v11_cec0040_decide','gpt_final_review_claim','verifyExecutionLease','v19_',
    'SERVICE_ROLE','service_role_key','/fapi/v1/order','/fapi/v2/','listenKey','/fapi/v1/leverage','/fapi/v1/marginType','X-MBX-APIKEY'])
    assert.ok(!BUNDLE.includes(s),'forbidden string in bundle: '+s);
  assert.ok(!/ORDER_GATEWAY|GATEWAY_SHARED_SECRET/.test(BUNDLE),'gateway env name in bundle');
  // Operator-approved exception: the shadow entrypoint may read the existing production OpenAI
  // project key as a fallback. It may not expose, persist or reference that key anywhere else.
  assert.equal((BUNDLE.match(/\bOPENAI_API_KEY\b/g)||[]).length,1,'production OpenAI key fallback must have exactly one reference');
  const idx=readFileSync(ENTRY,'utf8');
  assert.ok(/Deno\.env\.get\('OPENAI_API_KEY_SHADOW'\)\|\|Deno\.env\.get\('OPENAI_API_KEY'\)/.test(idx),'approved key fallback shape');
  assert.ok(!/console\.(log|error)[^\n]*OPENAI_API_KEY|OPENAI_API_KEY[^\n]*(insert|update|jsonb)/i.test(BUNDLE),'OpenAI key must not be logged or persisted');
  assert.ok(!/SUPABASE_SERVICE_ROLE|supabase-js|createClient/.test(BUNDLE),'service-role client in bundle');
});

test('bundle has no write to any production table (supabase-js style or SQL)', ()=>{
  const prod='(v11_long_regime_\\w*|trading_settings|gpt_final_\\w*|v17_operator_control|v11_cec0040_\\w*|v11_\\w*|v17_\\w*|market_regime_observations|edge_internal_tokens)';
  assert.ok(!new RegExp(`from\\(\\s*['"\`]${prod}['"\`]\\s*\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`).test(BUNDLE),'supabase-js write');
  assert.ok(!new RegExp(`(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate)\\s+(public\\.)?${prod}\\b`,'i').test(BUNDLE),'SQL write to production');
  assert.ok(!/\.(insert|update|upsert)\(/.test(BUNDLE),'no supabase-js write API at all');
});

test('every SQL statement: writes only into shadow_le, functions only shadow_le.*, production only SELECTed', ()=>{
  const READ_OK=new Set(['market_regime_observations','v17_market_scan_runs','v11_cec0040_state','v11_long_regime_signals','v11_long_regime_orders',
    'v11_long_regime_positions','gpt_final_entry_reviews','gpt_final_review_daily_budget']);
  for(const [name,q] of Object.entries(SQL)){
    for(const m of q.matchAll(/\b(insert\s+into|update|delete\s+from|merge\s+into|truncate)\s+([a-z_][\w.]*)/gi))
      assert.ok(m[2].startsWith('shadow_le.'),name+': write outside shadow_le: '+m[0]);
    for(const m of q.matchAll(/\bpublic\.(\w+)/g))assert.ok(READ_OK.has(m[1]),name+': production object not allowed: '+m[1]);
    for(const m of q.matchAll(/\b([a-z_]+)\.([a-z_0-9]+)\s*\(/g))
      assert.ok(m[1]==='shadow_le','name '+name+': function outside shadow_le: '+m[0]);
    assert.ok(!/\bset\s+role|\bgrant\b|\bcreate\b|\balter\b|\bdrop\b/i.test(q),name+': DDL/role statement');
    // postgres.js serializes a parameter it sees typed json/jsonb with JSON.stringify: a pre-serialized
    // string would arrive as a JSON scalar. Every JSON parameter therefore goes through ::text first.
    assert.ok(!/\$\d+::jsonb?\b/.test(q),name+': JSON parameter must be $N::text::jsonb');
  }
});

test('the only DB login is shadow_le_writer; SUPABASE_DB_URL user/password are never used', ()=>{
  const t=dbTarget('postgresql://postgres.abcd:S3CRET@aws-0-x.pooler.supabase.com:6543/postgres','https://abcd.supabase.co');
  assert.deepEqual(t,{host:'aws-0-x.pooler.supabase.com',port:6543,database:'postgres',username:'shadow_le_writer.abcd'});
  assert.ok(!JSON.stringify(t).includes('S3CRET'));
  const d=dbTarget('postgresql://postgres:S3CRET@db.abcd.supabase.co:5432/postgres','https://abcd.supabase.co');
  assert.equal(d.username,'shadow_le_writer');assert.equal(d.host,'db.abcd.supabase.co');
  assert.deepEqual(dbTarget(undefined,'https://abcd.supabase.co'),{host:'db.abcd.supabase.co',port:5432,database:'postgres',username:'shadow_le_writer'});
  const idx=readFileSync(ENTRY,'utf8');
  assert.ok(/password:credential/.test(idx)&&!/\.password\b/.test(idx),'password must be the request credential');
  assert.ok(/OPENAI_API_KEY_SHADOW/.test(idx)&&/OPENAI_API_KEY/.test(idx));
});

test('ALT1 prompt: no "already rose is not a reason" sentence; asks the cost-explicit 60-120 minute question', ()=>{
  for(const s of ['이미 많이 올랐다','사유가 아니다','SKIP 사유가 아니다','원래 강한 상승 종목을 산다'])assert.ok(!ALT1_PROMPT.includes(s),s);
  assert.ok(ALT1_PROMPT.includes('60~120분')&&ALT1_PROMPT.includes('breakeven_bps'));
  assert.ok(ALT1_PROMPT.includes('이 후보와 무관'));
});

// ---------------------------------------------------------------- fetch allowlist
const okResponse=(used=10)=>async()=>new Response('[]',{status:200,headers:{'x-mbx-used-weight-1m':String(used)}});
test('allowlist: permitted Binance GET endpoints and OpenAI POST /v1/responses only', async()=>{
  const seen=[],g=createGuard({fetchFn:async(u,i)=>{seen.push([u,i.method]);return okResponse()();}});
  for(const p of ['/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=5','/fapi/v1/depth?symbol=BTCUSDT&limit=5','/fapi/v1/exchangeInfo',
    '/fapi/v1/ticker/price','/fapi/v1/premiumIndex?symbol=BTCUSDT','/fapi/v1/premiumIndexKlines?symbol=BTCUSDT&interval=1m&limit=3',
    '/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=13'])await g.fetch('https://fapi.binance.com'+p,{method:'GET'});
  await g.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'});
  assert.equal(seen.length,8);
  const bad=[['https://fapi.binance.com/fapi/v1/order?symbol=BTCUSDT',{method:'GET'}],
    ['https://fapi.binance.com/fapi/v1/order',{method:'POST',body:'x'}],
    ['https://fapi.binance.com/fapi/v2/account',{}],['https://fapi.binance.com/fapi/v2/positionRisk',{}],
    ['https://fapi.binance.com/fapi/v1/listenKey',{method:'POST'}],['https://fapi.binance.com/fapi/v1/leverage',{method:'POST'}],
    ['https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT',{}],['https://fapi.binance.com/fapi/v1/time',{}],
    ['https://fapi1.binance.com/fapi/v1/klines?symbol=BTCUSDT',{}],['https://fapi2.binance.com/fapi/v1/depth?symbol=BTCUSDT',{}],
    ['https://api.binance.com/api/v3/order',{method:'POST'}],['http://fapi.binance.com/fapi/v1/klines',{}],
    ['https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&signature=abc&timestamp=1',{}],
    ['https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT',{headers:{'X-MBX-APIKEY':'k'}}],
    ['https://api.openai.com/v1/chat/completions',{method:'POST'}],['https://api.openai.com/v1/responses',{method:'GET'}],
    ['https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',{method:'POST'}],
    ['https://gateway.example.com/v1/command',{method:'POST'}]];
  for(const [u,i] of bad)await assert.rejects(g.fetch(u,i),e=>e instanceof GuardError&&e.code==='FETCH_NOT_ALLOWED',u);
  assert.equal(seen.length,8,'no forbidden request reached the network');
});

test('weights: documented request weights, per-cycle cap 100, abort at used weight 1200, 418/429 day halt', async()=>{
  const q=o=>new URLSearchParams(o);
  assert.equal(binanceWeight('/fapi/v1/klines',q({limit:110})),2);assert.equal(binanceWeight('/fapi/v1/klines',q({limit:5})),1);
  assert.equal(binanceWeight('/fapi/v1/klines',q({limit:241})),2);assert.equal(binanceWeight('/fapi/v1/depth',q({limit:100})),5);
  assert.equal(binanceWeight('/fapi/v1/depth',q({limit:5})),2);assert.equal(binanceWeight('/fapi/v1/ticker/price',q({})),2);
  const g=createGuard({fetchFn:okResponse()});
  for(let i=0;i<20;i++)await g.fetch('https://fapi.binance.com/fapi/v1/depth?symbol=AUSDT&limit=100');
  await assert.rejects(g.fetch('https://fapi.binance.com/fapi/v1/klines?symbol=AUSDT&limit=5'),e=>e.code==='CYCLE_WEIGHT_CAP');
  const h=createGuard({fetchFn:okResponse(1200)});
  await assert.rejects(h.fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'),e=>e.code==='SHARED_IP_WEIGHT_HIGH');
  await assert.rejects(h.fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'),e=>e.code==='BINANCE_ABORTED');
  for(const s of [418,429]){
    const k=createGuard({fetchFn:async()=>new Response('{}',{status:s})});
    await assert.rejects(k.fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'),e=>e.code==='BINANCE_DAY_HALT');
    assert.equal(k.state.dayHalt,'BINANCE_HTTP_'+s);
  }
});
