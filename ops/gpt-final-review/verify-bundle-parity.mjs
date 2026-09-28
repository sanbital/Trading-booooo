// Compares EVERY file of a downloaded Edge Function bundle with the checked-out
// repository and prints a deterministic bundle digest (sha256 over path+sha256 lines).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
const [downloadRoot,repoRoot='.',slug,mode]=process.argv.slice(2).map((x,i)=>i<2?resolve(x):x);
assert.ok(mode===undefined||mode==='--normalize-line-endings','unknown comparison mode');
assert.ok(downloadRoot&&slug,'usage: verify-bundle-parity.mjs <download> <repo> <slug>');
const files=[];(function walk(d){for(const n of readdirSync(d)){const p=join(d,n);statSync(p).isDirectory()?walk(p):files.push(p);}})(downloadRoot);
const marker=sep+'functions'+sep,rows=[],lineEndingOnly=[];
for(const f of files){
  const i=f.lastIndexOf(marker);if(i<0)continue;
  const rel='supabase/functions/'+f.slice(i+marker.length).split(sep).join('/');
  const local=join(repoRoot,rel);
  assert.ok(existsSync(local),'downloaded file missing from repository: '+rel);
  const deployed=readFileSync(f),source=readFileSync(local);
  if(mode==='--normalize-line-endings'&&!deployed.equals(source)){
    assert.match(rel,/\.(?:ts|mjs|js|json)$/,'newline normalization requires a text source: '+rel);
    assert.equal(deployed.toString('utf8').replaceAll('\r\n','\n'),source.toString('utf8').replaceAll('\r\n','\n'),'production source mismatch: '+rel);
    lineEndingOnly.push(rel);
  }else assert.deepEqual(deployed,source,'production source mismatch: '+rel);
  rows.push(rel+' '+createHash('sha256').update(deployed).digest('hex'));
}
rows.sort();
assert.ok(rows.some(r=>r.startsWith(`supabase/functions/${slug}/index.ts `)),'entrypoint not in bundle');
console.log(JSON.stringify({verified:true,slug,fileCount:rows.length,lineEndingOnly,bundleDigest:createHash('sha256').update(rows.join('\n')).digest('hex'),files:rows},null,2));
