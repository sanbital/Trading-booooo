import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function assertControlResult(command,result) {
 if(result?.ok!==true||result.error||['DB_DEGRADED','BUSY','FAILED'].includes(result.status))
  throw Error(result?.status==='DB_DEGRADED'?'CONTROL_DB_DEGRADED_NOT_APPLIED':'CONTROL_RESULT_NOT_SUCCESSFUL');
 const expected={pause_new_entries:true,resume_new_entries:false,start_paper:false,start_live_limited:false};
 if(Object.hasOwn(expected,command)&&result.settings?.pause_new_entries!==expected[command])
  throw Error('CONTROL_PERMISSION_NOT_CONFIRMED');
 return {command,ok:true,mode:result.settings?.mode,pause_new_entries:result.settings?.pause_new_entries};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {console.log(JSON.stringify(assertControlResult(process.argv[2],JSON.parse(readFileSync(process.argv[3],'utf8')))));}
 catch(error) {console.error(JSON.stringify({ok:false,error:/^[A-Z_]+$/.test(error.message)?error.message:'CONTROL_RESPONSE_INVALID'}));process.exitCode=1;}
}
