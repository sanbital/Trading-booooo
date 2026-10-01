import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const m=JSON.parse(readFileSync('deployment-evidence/production-v183-baseline.json'));
if(m.production_version!==183||Object.keys(m.files).length!==93)throw Error('BASELINE_IDENTITY');
for(const [path,expected]of Object.entries(m.files)){
 if(path.startsWith('/')||path.split('/').includes('..'))throw Error('BASELINE_PATH');
 const actual=createHash('sha256').update(readFileSync('supabase/functions/'+path)).digest('hex');
 if(actual!==expected)throw Error('BASELINE_SOURCE_MISMATCH:'+path);
}
console.log('93 production v183 source files match preserved SHA-256 manifest.');
