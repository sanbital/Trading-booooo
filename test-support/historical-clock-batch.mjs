import {readFileSync} from 'node:fs';
import * as capture from '../supabase/functions/_shared/gpt-final-decision/capture-context.mjs';
import * as dynamic from '../supabase/functions/_shared/gpt-final-decision/dynamic-flow.mjs';
import * as hash from '../supabase/functions/_shared/gpt-final-decision/snapshot-hash.mjs';
import * as clock from '../supabase/functions/_shared/leader20/clock.mjs';
import * as transport from '../supabase/functions/_shared/leader20/paid-transport.mjs';
// Historical SQL migrations asserted a 20-member packet. Production now explicitly
// rejects such clock packets. Keep historical replay separate; never alter the live
// Top10 builder to make an old fixture pass. These exports are test-only.
const exportsOf=(source,bindings)=>{
  const names=[...source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map(m=>m[1]);
  const code=source.replace(/^import[^;]+;\s*/gm,'').replace(/\bexport\s+/g,'');
  return new Function(...Object.keys(bindings),code+`;return {${names.join(',')}};`)(...Object.values(bindings));
};
// Copied from commit 1f42b3a314076db81b74b5662b9184826ecdfb45; works in shallow CI clones.
const historical=readFileSync(new URL('./fixtures/historical-20-batch.source.txt',import.meta.url),'utf8');
const batch=exportsOf(historical,{...capture,...dynamic,...hash});
export const buildHistorical20Batch=batch.buildBatch;
const runtime=readFileSync(new URL('../supabase/functions/_shared/leader20/batch-runtime.mjs',import.meta.url),'utf8');
export const runHistorical20EntryBatch=exportsOf(runtime,{...clock,...batch,...transport,...hash}).runEntryBatch;
