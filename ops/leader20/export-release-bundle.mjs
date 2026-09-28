import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const [slug,ref]=process.argv.slice(2),names=new Set();
const read=p=>ref?execFileSync('git',['show',ref+':'+p],{encoding:'utf8',maxBuffer:8*1024*1024}):fs.readFileSync(p,'utf8');
function visit(p){
 if(names.has(p))return;names.add(p);
 const c=read(p);
 for(const m of c.matchAll(/(?:from\s+|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g))
  visit(path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1])));
}
visit(`supabase/functions/${slug}/index.ts`);
for(const name of [`supabase/functions/${slug}/deno.json`,`supabase/functions/${slug}/deno.jsonc`]){
 if(fs.existsSync(name))names.add(name);
}
const files=[...names].sort().map(name=>({name,content:read(name)}));
if(process.env.BASELINE_BUNDLE){
 const remote=JSON.parse(fs.readFileSync(process.env.BASELINE_BUNDLE,'utf8'));
 const map=new Map(files.map(x=>[x.name,x.content.replaceAll('\r\n','\n')]));
 const differences=remote.files.filter(f=>map.get('supabase/'+f.name)!==f.content.replaceAll('\r\n','\n')).map(f=>f.name);
 console.log(JSON.stringify({slug,remoteFiles:remote.files.length,differences}));
}else if(process.env.BUNDLE_OUTPUT){
 fs.writeFileSync(process.env.BUNDLE_OUTPUT,JSON.stringify(files));
 console.log(JSON.stringify({slug,files:files.length,characters:JSON.stringify(files).length}));
}else console.log(JSON.stringify(files));
