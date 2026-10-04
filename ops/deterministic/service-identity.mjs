import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
// Both baseline and repaired identities are immutable, explicitly reviewed pins.
// A deployment interrupted before its metadata CAS never becomes resume-ready.
export function serviceIdentity(request,sourceCommit=request.staged_source_commit){
 const baseline=request.staged_source_commit;
 if(!/^[a-f0-9]{40}$/.test(sourceCommit??''))throw Error('SERVICE_SOURCE_PIN_REQUIRED');
 const boundary=request.production_entry_boundary;
 if(boundary&&sourceCommit===boundary.source_commit){
  if(boundary.baseline_source_commit!==baseline||boundary.expected_versions?.['v10-lane-executor']!==195||
    boundary.expected_versions?.['v10-lane-signal-generator']!==53||!/^[a-f0-9]{64}$/.test(boundary.executor_bundle_sha256??'')||
    boundary.gateway_source_commit!==request.gateway_commits?.['trading-booooo'])throw Error('UNREVIEWED_SERVICE_IDENTITY');
  return {sourceCommit,versions:boundary.expected_versions,sources:{'v10-lane-executor':sourceCommit,'v10-lane-signal-generator':baseline}};
 }
 if(sourceCommit===baseline)return {sourceCommit,versions:request.expected_staged_versions,sources:Object.fromEntries(Object.keys(request.expected_versions).map(slug=>[slug,baseline]))};
 const repair=request.executor_latency_repair;
 if(!repair||sourceCommit!==repair.source_commit||repair.baseline_source_commit!==baseline||
   repair.baseline_versions?.['v10-lane-executor']!==192||repair.baseline_versions?.['v10-lane-signal-generator']!==53||
   repair.expected_versions?.['v10-lane-executor']!==193||repair.expected_versions?.['v10-lane-signal-generator']!==53)throw Error('UNREVIEWED_SERVICE_IDENTITY');
 return {sourceCommit,versions:repair.expected_versions,sources:{'v10-lane-executor':sourceCommit,'v10-lane-signal-generator':baseline}};
}
export function assertLatencySource(request,sourceRoot,{cwd=process.cwd(),run=spawnSync}={}){
 const repair=request.executor_latency_repair,identity=serviceIdentity(request,repair?.source_commit);
 const git=args=>{const r=run('git',args,{cwd,encoding:'utf8'});if(r.status!==0)throw Error('LATENCY_SOURCE_UNAVAILABLE');return r.stdout.trim();};
 const file='supabase/functions/v10-lane-executor/index.ts';
 if(git(['rev-parse',identity.sourceCommit+'^'])!==repair.baseline_source_commit||
   git(['diff','--name-only',repair.baseline_source_commit,identity.sourceCommit])!==file)throw Error('LATENCY_REPAIR_CHANGED_STRATEGY_OR_DEPENDENCY');
 const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 if(hash(path.join(cwd,file))!==hash(path.join(sourceRoot,file)))throw Error('LATENCY_REPAIR_RUNNER_SOURCE_MISMATCH');
 return identity;
}
