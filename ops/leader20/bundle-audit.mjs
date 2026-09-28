import fs from 'node:fs';
import path from 'node:path';
const names=new Set();
function visit(p){
 if(names.has(p))return;names.add(p);
 const c=fs.readFileSync(p,'utf8');
 for(const m of c.matchAll(/from ['"](\.\.?\/[^'"]+)['"]/g))
  visit(path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1])));
}
visit('supabase/functions/leader20-batch-audit/index.ts');
const files=[...names].map(name=>({name,content:fs.readFileSync(name,'utf8')}));
console.log(JSON.stringify(files));
