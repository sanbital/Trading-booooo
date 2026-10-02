import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function decisionGraph(){
 const pending=['supabase/functions/v10-lane-executor/index.ts','supabase/functions/v10-lane-signal-generator/index.ts'],seen=new Set(),remote=new Set(),providers=[],sql=[];
 while(pending.length){const p=pending.pop();if(seen.has(p))continue;seen.add(p);const text=fs.readFileSync(path.join(root,p),'utf8'),ast=parse(text,{sourceType:'module',ecmaVersion:'latest'});
  for(const n of ast.body)if(n.type==='ImportDeclaration'){
   if(n.source.value.startsWith('.'))pending.push(path.relative(root,path.resolve(root,path.dirname(p),n.source.value)));
   else remote.add(n.source.value);
  }
  // A provider call, packet builder, wait adapter or historical authority is forbidden
  // in the entire bundle, including an uncalled import brought into an entrypoint.
  if(/api\.openai\.com|api\.deepseek\.com|gpt-final|gpt_hold|gpt_final|ai_call_ledger|ai_budget|leader20\/runtime|_production-v51|model_arbitration|provider_fallback/i.test(text))providers.push(p);
  for(const match of text.matchAll(/\.rpc\(["']([^"']+)/g))sql.push(match[1]);
 }
 return {local_files:[...seen].sort(),external_imports:[...remote],provider_dependency_files:providers,rpcs:[...new Set(sql)].sort()};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(decisionGraph(),null,2));
