import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

/** Compare deployed bytes to the immutable source of that deployment, even when
 * the release runner contains a subsequently reviewed service repair. */
export function serviceSourceRoot(commit,{cwd=process.cwd(),temp=process.env.RUNNER_TEMP,run=spawnSync}={}){
 if(!/^[a-f0-9]{40}$/.test(commit??'')||!temp)throw Error('SERVICE_SOURCE_PIN_REQUIRED');
 const dir=fs.mkdtempSync(path.join(temp,'deterministic-service-source-')),archive=path.join(dir,'source.tar');
 const git=run('git',['archive','--format=tar','--output='+archive,commit,'supabase/functions'],{cwd,encoding:'utf8'});
 if(git.status!==0)throw Error('SERVICE_SOURCE_COMMIT_UNAVAILABLE');
 const tar=run('tar',['-xf',archive,'-C',dir],{encoding:'utf8'});
 if(tar.status!==0)throw Error('SERVICE_SOURCE_ARCHIVE_FAILED');
 fs.unlinkSync(archive);return dir;
}
