// A fixed gateway maintenance release. All DB and exchange operations are reads.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const phase=process.argv[2],app=process.env.FLY_BINANCE_APP_NAME;
assert.ok(['before','after'].includes(phase));assert.equal(app,'trading-booooo');
const machine='1850353b930168',root='release-evidence';mkdirSync(root,{recursive:true});
const save=(name,data)=>writeFileSync(`${root}/${name}.json`,JSON.stringify(data,null,2));
function run(cmd,args,extra={}){try{return execFileSync(cmd,args,{encoding:'utf8',timeout:45000,stdio:['pipe','pipe','pipe'],...extra}).trim();}catch{throw Error(`${cmd}_FAILED`);}}
const uri=new URL(process.env.SUPABASE_DB_URL);
assert.ok(['postgres:','postgresql:'].includes(uri.protocol));
const env={...process.env,PGHOST:uri.hostname,PGPORT:uri.port||'5432',PGUSER:decodeURIComponent(uri.username),PGPASSWORD:decodeURIComponent(uri.password),PGDATABASE:decodeURIComponent(uri.pathname.slice(1)),PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=10000'};
if(uri.searchParams.has('sslmode'))env.PGSSLMODE=uri.searchParams.get('sslmode');
const db=JSON.parse(run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{env,input:`begin read only;
select jsonb_build_object('at',clock_timestamp(),'pause',(select pause_new_entries from trading_settings where id=1),'lock',(select pause_lock_reason from trading_settings where id=1),'circuit',(select circuit_open from v11_long_regime_runtime where singleton),'incident',(select incident_id from v11_long_regime_runtime where singleton),'open',(select count(*) from v11_long_regime_positions where state='OPEN'),'pending',(select count(*) from v11_long_regime_orders where state in ('PLANNED','DISPATCHED','RECONCILIATION_FAILED','RECONCILIATION_PENDING'))); commit;`}));
save(`controls-${phase}`,db);assert.equal(db.incident,'823464bf-b61b-4738-874c-a79196ca6443');assert.equal(db.pause,true);assert.equal(db.circuit,true);assert.equal(db.open,0);assert.equal(db.pending,0);
const token=process.env.LEARNING_ACCESS_TOKEN;assert.ok(token?.length>=32);
const secret=createHash('sha256').update(`gateway:${token}`).digest('hex'),url=`https://${app}.fly.dev`;
async function command(action){
 assert.ok(['p10_portfolio','v18_open_orders','symbol_info'].includes(action));
 const body=JSON.stringify({exchange:'binance_futures',action,...(action==='symbol_info'?{market:'4USDT'}:{})}),ts=String(Date.now()),nonce=randomUUID();
 const signature=createHmac('sha256',secret).update(`${ts}\n${nonce}\n${body}`).digest('hex');
 const r=await fetch(`${url}/v1/command`,{method:'POST',headers:{'content-type':'application/json','x-gateway-ts':ts,'x-gateway-nonce':nonce,'x-gateway-signature':signature},body,signal:AbortSignal.timeout(15000)});
 const d=await r.json();return{status:r.status,...d};
}
const [portfolio,orders,symbol]=await Promise.all(['p10_portfolio','v18_open_orders','symbol_info'].map(command));
const health=await fetch(`${url}/health`,{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
save(`reads-${phase}`,{at:new Date().toISOString(),portfolio,orders,symbol,health:{version:health.version,patch:health.ops_patch,scheduler:health.scheduler_enabled}});
assert.equal(health.scheduler_enabled,false);assert.equal(health.ops_patch,'V18-OPS-ISOLATION-3');
assert.equal(portfolio.ok,true);assert.equal(portfolio.result.positions_complete,true);assert.deepEqual(portfolio.result.positions,[]);
assert.equal(orders.ok,true);assert.equal(orders.result.complete,true);assert.deepEqual(orders.result.orders,[]);assert.deepEqual(orders.result.algos,[]);
const files=['server.mjs','v17-stop-commands.mjs','v17-shadow-worker.mjs','v17-shadow-host.mjs','leader-exit-r3.mjs','leader-exit-r4.mjs'];
const sha=s=>createHash('sha256').update(s).digest('hex');
const hashes=Object.fromEntries(files.map(name=>{let content=readFileSync(`gateway/${name}`,'utf8');if(name==='server.mjs'&&phase==='before'){
 const fixed='[\\p{L}\\p{N}]{1,24}USDT',old='[\\p{L}\\p{N}]{2,24}USDT';assert.equal(content.split(fixed).length,2);content=content.replace(fixed,old);
 }return[name,sha(content)];}));
const output=run('flyctl',['ssh','console','--app',app,'--machine',machine,'--quiet','--command',`sha256sum ${files.map(x=>'/app/'+x).join(' ')}`]);
const remote=Object.fromEntries(output.split('\n').map(x=>x.match(/^([a-f0-9]{64})\s+\/app\/(\S+)$/)).filter(Boolean).map(x=>[x[2],x[1]]));
save(`hashes-${phase}`,{expected:hashes,remote});assert.deepEqual(remote,hashes,'REMOTE_SOURCE_MISMATCH');
const status=JSON.parse(run('flyctl',['machine','status',machine,'--app',app,'--json']));
save(`machine-${phase}`,{id:status.id,state:status.state,region:status.region,image:status.config?.image??status.image_ref,instanceId:status.instance_id});
if(phase==='before'){assert.equal(symbol.status,400);assert.equal(symbol.error,'only Binance USDT symbols are allowed');}
else{assert.equal(symbol.status,200);assert.equal(symbol.ok,true);assert.equal(symbol.result.symbol,'4USDT');const b=JSON.parse(readFileSync(`${root}/controls-before.json`));assert.equal(db.incident,b.incident);assert.equal(db.lock,b.lock);}
console.log(JSON.stringify({phase,sourceFilesVerified:files.length,symbolStatus:symbol.status,positions:0,orders:0,algos:0,pause:db.pause,circuit:db.circuit,image:status.config?.image??status.image_ref}));
