/** Authorized BTC sensor release: existing public collector image only, then read-only soak. */
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateMarketSensor} from '../../supabase/functions/_shared/gpt-final-decision/market-sensor.mjs';
const app='sanbital-doa-capture-20260925',project='etaajwpernzrcdrifdnw';
if(process.env.GITHUB_REF!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))throw Error('RELEASE_REF');
const sha=process.env.GITHUB_SHA,image='registry.fly.io/'+app+':'+sha;
const protocol=createHash('sha256').update(readFileSync('collectors/doa-capture/PROTOCOL.md')).digest('hex');
async function query(query){const r=await fetch('https://api.supabase.com/v1/projects/'+project+'/database/query',{
 method:'POST',headers:{authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('DATABASE_HTTP_'+r.status);return r.json();}
async function machine(path='',method='GET',body,nonce){const r=await fetch('https://api.machines.dev/v1/apps/'+app+'/machines'+path,{
 method,headers:{authorization:'Bearer '+process.env.FLY_API_TOKEN,'content-type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},
 ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('MACHINE_HTTP_'+r.status);return r.json();}
const safe=m=>({id:m.id,state:m.state,region:m.region,instance_id:m.instance_id,image:m.image_ref,guest:m.config.guest});
const ready=(await query("select enabled,production_enabled,protocol_sha256,to_regprocedure('public.doa_market_sensor_context_v1(text,timestamptz)') is not null sensor_ready, (select md5(pg_get_functiondef(oid)) from pg_proc where proname='doa_gpt_capture_context_v3') trade_hash from doa_capture.control where id=1"))[0];
if(!ready?.enabled||!ready.production_enabled||ready.protocol_sha256!==protocol||!ready.sensor_ready||ready.trade_hash!=='16c234ccede07d0eaf698a02ee98b08d')throw Error('DATABASE_CONTRACT_NOT_READY');
const list=await machine();if(list.length!==1)throw Error('EXPECTED_ONE_COLLECTOR');const before=await machine('/'+list[0].id),cfg=before.config;
if(cfg.env?.CAPTURE_ENDPOINT!=='https://'+project+'.supabase.co/functions/v1/doa-capture-ingest'||cfg.env?.PROTOCOL_SHA256!==protocol||cfg.services?.length||cfg.mounts?.length||cfg.auto_destroy===true||
 !String(cfg.image).startsWith('registry.fly.io/'+app+':'))throw Error('UNEXPECTED_CAPTURE_CONFIG');
const evidence={source_commit:sha,protocol_sha256:protocol,trade_validator_md5:ready.trade_hash,before:safe(before),test_orders:0,trading_config_changes:0,samples:[]};
const save=()=>writeFileSync('market-sensor-release.json',JSON.stringify(evidence,null,2));save();
if(spawnSync('flyctl',['auth','docker'],{encoding:'utf8'}).status!==0)throw Error('REGISTRY_AUTH_FAILED');
if(spawnSync('docker',['push',image],{stdio:'inherit'}).status!==0)throw Error('IMAGE_PUSH_FAILED');
const lease=await machine('/'+before.id+'/lease','POST',{description:'sensor-'+sha.slice(0,12),ttl:60});const nonce=lease.data?.nonce;if(!nonce)throw Error('LEASE_MISSING');
try{const current=await machine('/'+before.id);if(current.instance_id!==before.instance_id)throw Error('CONCURRENT_COLLECTOR_DEPLOYMENT');
 await machine('/'+before.id,'POST',{current_version:before.instance_id,config:{...cfg,image}},nonce);
}finally{await machine('/'+before.id+'/lease','DELETE',undefined,nonce);}
evidence.after=safe(await machine('/'+before.id));save();
let stableSince=null,verified=false;
for(let i=0;i<100;i++){
 await new Promise(r=>setTimeout(r,15000));
 const [row]=(await query(`with cutoff as materialized(select clock_timestamp() t), sensor as materialized(select public.doa_market_sensor_context_v1('BTCUSDT',t) c from cutoff)
 select extract(epoch from cutoff.t)*1000 as_of_ms,c.metrics-'live_contexts' metrics,
 extract(epoch from cutoff.t-c.heartbeat_at) heartbeat_age_s,sensor.c sensor,
 (select jsonb_agg(jsonb_build_object('symbol',k,'roles',v,'status',ctx->>'status','reason',ctx->>'reason','buckets',ctx->'buckets'))
 from jsonb_each(c.metrics->'watch_roles') w(k,v)
 cross join lateral (select public.doa_gpt_capture_context_v3(k,cutoff.t) ctx) x where k<>'BTCUSDT') trade_contexts,
 (select jsonb_agg(jsonb_build_object('symbol',p.symbol,'id',p.id,'context',public.doa_context_for_role_v1(p.symbol,cutoff.t,'OPEN_POSITION',p.id)-'trajectory')) from public.v11_long_regime_positions p where p.state='OPEN') open_positions,
 public.doa_context_for_role_v1('BTCUSDT',cutoff.t,'TRADE_CANDIDATE')-'trajectory' btc_trade
 from doa_capture.control c cross join cutoff cross join sensor where c.id=1`));
 const sensor=validateMarketSensor(row.sensor,Math.floor(Number(row.as_of_ms))),last=sensor.market_sensor_trajectory?.at(-1);
 const sample={at:new Date(Number(row.as_of_ms)).toISOString(),metrics:row.metrics,heartbeat_age_s:row.heartbeat_age_s,
 sensor:{...sensor,market_sensor_trajectory:undefined},last_point:last,trade_contexts:row.trade_contexts,open_positions:row.open_positions,btc_trade:row.btc_trade};
 evidence.samples.push(sample);console.log(JSON.stringify({at:sample.at,status:sensor.status,reason:sensor.reason,watched:row.metrics.watched,synced:row.metrics.synced,return_1m:sensor.btc_return_1m,latency_ms:sensor.max_event_latency_ms,coverage:sensor.depth_coverage_bps,trade_unavailable:row.trade_contexts?.filter(x=>x.status!=='AVAILABLE'),open:row.open_positions}));
 const good=sensor.status==='AVAILABLE'&&row.metrics.version==='DOA-CAPTURE-6-MARKET-SENSOR'&&row.metrics.source_commit===sha&&row.metrics.watched===row.metrics.synced&&row.heartbeat_age_s<25;
 if(good){stableSince??=Number(row.as_of_ms);if(Number(row.as_of_ms)-stableSince>=600000){verified=true;save();break;}}else stableSince=null;
 save();
}
evidence.verified=verified;evidence.stable_since=stableSince;evidence.after=safe(await machine('/'+before.id));
const {image:oldImage,...oldConfig}=cfg,{image:newImage,...newConfig}=(await machine('/'+before.id)).config;
if(JSON.stringify(oldConfig)!==JSON.stringify(newConfig))throw Error('COLLECTOR_CONFIG_DRIFT');
evidence.image_only_update=true;save();if(!verified)throw Error('TEN_MINUTE_SENSOR_SOAK_INCOMPLETE');
