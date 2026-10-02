import vm from 'node:vm';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import {parse} from 'acorn';
export const executorPath=new URL('../../supabase/functions/v10-lane-executor/index.ts',import.meta.url);
export async function evaluateModule(path=executorPath,{env={},client={},extra={}}={}){
 const source=fs.readFileSync(path,'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),bindings={},served=[],cuts=[];
 for(const n of ast.body){
  if(n.type==='ImportDeclaration'){
   const module=n.source.value.startsWith('https:')?{createClient:()=>client}:await import(new URL(n.source.value,path));
   for(const spec of n.specifiers)bindings[spec.local.name]=spec.type==='ImportNamespaceSpecifier'?module:module[spec.imported?.name??'default'];
   cuts.push([n.start,n.end]);
  }else if(n.type==='ExportNamedDeclaration')cuts.push([n.start,n.declaration.start]);
 }
 let body=source;for(const [start,end] of cuts.sort((a,b)=>b[0]-a[0]))body=body.slice(0,start)+body.slice(end);
 const ctx={console,Response,Request,Headers,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,setTimeout,clearTimeout,
  crypto:webcrypto,fetch:async()=>{throw Error('NETWORK_FORBIDDEN_IN_TEST');},...bindings,...extra,
  Deno:{env:{get:n=>env[n]},serve:h=>served.push(h)}};
 vm.createContext(ctx);vm.runInContext(body,ctx,{filename:fileURLToPath(path)});
 return {ctx,served,source,value:expr=>vm.runInContext(expr,ctx)};
}
export function mockDb(handler){
 const writes=[];
 const db={rpc:async(name,args)=>handler({rpc:name,args,writes}),from(table){let op='select',patch=null;const filters=[];
  const b={select(){return b},eq(k,v){filters.push([k,v]);return b},is(k,v){filters.push([k,v]);return b},in(k,v){filters.push([k,v]);return b},
   order(){return b},limit(){return b},gte(){return b},lte(){return b},insert(p){op='insert';patch=p;return b},update(p){op='update';patch=p;return b},
   single(){return execute()},maybeSingle(){return execute()},then(a,z){return execute().then(a,z)}};
  async function execute(){if(op!=='select')writes.push({table,op,patch,filters});return handler({table,op,patch,filters,writes});}
  return b;
 }};return {db,writes};
}
