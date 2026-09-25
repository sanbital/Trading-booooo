/** FD1 research observation inside leader-emerging-shadow. Only reads completed production
 * GPT packets; only writes shadow_le.fd1_thesis_reviews. No exchange, order, lease, or
 * production ledger calls. One budgeted, non-retried GPT request per claimed job. */
import {MODEL} from './v2/contract.mjs';
import {costOf,parseOutput,standDown,hashOf} from './gpt.mjs';

export const FD1_AUDIT_VERSION='LE_FD1_THESIS_SHADOW_3';
export const FD1_AUDIT_MAX_CALLS_DAY=60;
export const FD1_AUDIT_MAX_USD_DAY=.30;
const n=x=>x===null||x===undefined?null:Number.isFinite(Number(x))?Number(x):null;
const fin=x=>typeof x==='number'&&Number.isFinite(x);
const iso=x=>new Date(x).toISOString();
const fetchReview=`select r.job_key,r.symbol,r.signal_id,r.decision,r.created_at,r.record->'packet' as packet,
  r.record->'packet'->>'task' as task
  from public.gpt_final_entry_reviews r
  where r.purpose='PRODUCTION' and r.state='DONE'
    and r.record->'packet'->>'task' in ('RECHECK','HOLD')
    and r.created_at > now()-interval '30 minutes'
    and not exists (select 1 from shadow_le.fd1_thesis_reviews a where a.job_key=r.job_key)
  order by r.created_at limit $1::int`;
const claimReview=`with lk as materialized (select pg_advisory_xact_lock(hashtext('shadow_le.fd1_thesis_reviews'))),
  budget as materialized (select count(*) as calls,coalesce(sum(coalesce(cost_usd,0.012)),0) as usd
    from shadow_le.fd1_thesis_reviews,lk
    where created_at >= date_trunc('day',now() at time zone 'utc') at time zone 'utc'),
  claimed as (insert into shadow_le.fd1_thesis_reviews(job_key,task,symbol,signal_id,production_decision,snapshot_at,
      input_features,version,state)
    select $1::text,$2::text,$3::text,$4::text,$5::text,$6::timestamptz,$7::jsonb,$8::text,'CLAIMED'
    from budget where calls < $9::int and usd + .012 <= $10::numeric
    on conflict(job_key) do nothing returning job_key)
  select job_key from claimed`;
const finishReview=`update shadow_le.fd1_thesis_reviews set state='DONE',shadow_decision=$2::text,
  trend_valid=$3::boolean,entry_valid=$4::boolean,micro_only=$5::boolean,evidence=$6::jsonb,
  reason=$7::text,model=$8::text,prompt_hash=$9::text,schema_hash=$10::text,request_id=$11::text,
  latency_ms=$12::int,cost_usd=$13::numeric,error=$14::text,finished_at=now()
  where job_key=$1::text and state='CLAIMED' returning job_key`;

export const FD1_SQL=Object.freeze({fetchReview,claimReview,finishReview});
export const FD1_PROMPT=`너는 실제 주문에 영향을 주지 않는 독립 연구용 GPT다. 입력은 생산 GPT 판단 당시의 완료된 패킷이며 생산 GPT의 결론은 제공되지 않는다.
RECHECK: 10초 안팎의 스프레드·호가·체결 변화가 일시적 micro noise인지, 가격+체결+유동성+상위 추세 중 독립적인 근거가 함께 무너진 trend invalidation인지 구분하라. 스프레드 또는 depth 한 가지 악화만으로 SKIP하지 마라. 다만 유동성 실행 불가능이나 복합 악화는 SKIP할 수 있다. 정보가 부족하면 ABSTAIN. WAIT_RECHECK는 제안만 기록하며 주문이나 후속 호출을 일으키지 않는다.
HOLD: 종목 자체의 상위 추세가 살아 있는지(trend_valid)와 내 진입이 여전히 유효한지(entry_valid)를 별도로 판정하라. MFE/peak 부재 자체만으로 청산하지 마라. peak 생성 실패와 음의 현재 수익, trigger 재이탈, taker 매수 감소나 BTC 대비 약화가 복합적으로 관측되면 EXIT_ENTRY_FAILURE을 고려하라. 이미 충분히 상승한 포지션은 약한 1분봉 하나로 청산하지 마라. 시간만 지났다는 이유로 청산하지 마라.
오직 입력에 있는 관측값을 인용하고 미래 결과를 추측하지 마라. e에는 facts, initial_facts, change, pre_dispatch에 실제로 있는 숫자 필드의 정확한 키 또는 점(.)으로 연결된 경로만 기록한다. e가 빈 배열이면 ABSTAIN. 결과는 주어진 JSON schema로 반환한다.`;

export const FD1_SCHEMA={type:'object',additionalProperties:false,required:['decision','trend_valid','entry_valid','micro_only','e','reason'],
  properties:{decision:{type:'string',enum:['PASS','WAIT_RECHECK','SKIP','HOLD','EXIT_ENTRY_FAILURE','EXIT_TREND_FAILURE','ABSTAIN']},
    trend_valid:{type:['boolean','null']},entry_valid:{type:['boolean','null']},micro_only:{type:['boolean','null']},
    e:{type:'array',items:{type:'string'},maxItems:8},reason:{type:'string',maxLength:240}}};

/** Point-in-time packet: no production decision, model answer, future outcome or positions ledger. */
export function fd1Packet(r){
  const p=r.packet??{},v=p.facts?.values??{};
  if(r.task==='RECHECK')return {version:FD1_AUDIT_VERSION,task:'RECHECK',symbol:r.symbol,
    facts:v,initial_facts:p.initial?.facts??null,change:p.change??null,
    current_ref:p.current_ref??null,pre_dispatch:p.pre_dispatch??null,
    trigger_reasons:p.trigger_reasons??[],quality:p.facts?.quality??null};
  return {version:FD1_AUDIT_VERSION,task:'HOLD',symbol:r.symbol,facts:v,
    position_stage:p.position?.stop_stage??null,quality:p.facts?.quality??null};
}
function validate(a,p){
  if(!a||!['boolean','object'].includes(typeof a.trend_valid)||!['boolean','object'].includes(typeof a.entry_valid))throw Error('INVALID_FLAGS');
  const choices=p.task==='RECHECK'?['PASS','WAIT_RECHECK','SKIP','ABSTAIN']:['HOLD','EXIT_ENTRY_FAILURE','EXIT_TREND_FAILURE','ABSTAIN'];
  if(!choices.includes(a.decision)||!Array.isArray(a.e)||a.e.length>8||typeof a.reason!=='string'||a.reason.length>240)throw Error('INVALID_ANSWER');
  const known=new Set();
  const visit=(v,path='',depth=0)=>{
    if(!v||typeof v!=='object'||depth>4)return;
    for(const [key,value] of Object.entries(v)){
      const next=path?path+'.'+key:key;
      if(fin(value)){known.add(key);known.add(next);}
      else if(value&&typeof value==='object'&&!Array.isArray(value))visit(value,next,depth+1);
    }
  };
  for(const key of ['facts','initial_facts','change','pre_dispatch','current_ref','quality'])visit(p[key],key);
  const invalid=a.e.filter(x=>typeof x!=='string'||!known.has(x));
  const supported=a.e.filter(x=>typeof x==='string'&&known.has(x));
  if(a.decision!=='ABSTAIN'&&supported.length===0)throw Error('UNSUPPORTED_EVIDENCE:'+invalid.slice(0,2).join(',').slice(0,72));
  a={...a,e:supported,ignored_evidence:invalid};
  if(a.decision==='SKIP'&&a.micro_only===true)throw Error('MICRO_ONLY_SKIP');
  if(a.decision==='EXIT_ENTRY_FAILURE'&&a.entry_valid!==false)throw Error('ENTRY_STILL_VALID');
  return a;
}
export async function runFd1Audit({db,store,guard,apiKey,now=Date.now,limit=3}){
  const out={ok:true,mode:'fd1audit',patch:FD1_AUDIT_VERSION,processed:[],gpt_calls:0,orders:0};
  const health=await store.gptHealth();
  const gate=!apiKey?'SHADOW_KEY_MISSING':standDown(health);
  if(gate){out.gate=gate;return out;}
  const rows=await db.query(fetchReview,[Math.min(3,Math.max(1,limit))]);
  const promptHash=await hashOf(FD1_PROMPT),schemaHash=await hashOf(FD1_SCHEMA);
  for(const r of rows){
    const p=fd1Packet(r),snapshot=Date.parse(r.created_at);
    // Reject old packets before claiming, not after using their later outcome.
    if(!fin(snapshot)||now()-snapshot>30*60_000){out.processed.push({task:r.task,state:'STALE'});continue;}
    const features={...p,source_job_key:r.job_key,snapshot_at:iso(snapshot),production_decision_excluded_from_gpt:true};
    const claimed=await db.query(claimReview,[r.job_key,r.task,r.symbol,r.signal_id??null,r.decision??null,
      iso(snapshot),JSON.stringify(features),FD1_AUDIT_VERSION,FD1_AUDIT_MAX_CALLS_DAY,FD1_AUDIT_MAX_USD_DAY]);
    if(!claimed.length){out.processed.push({task:r.task,state:'DUPLICATE_OR_BUDGET'});continue;}
    const body={model:MODEL,store:false,tools:[],truncation:'disabled',service_tier:'default',reasoning:{effort:'none'},
      max_output_tokens:350,input:[{role:'system',content:FD1_PROMPT},{role:'user',content:JSON.stringify(p)}],
      text:{verbosity:'low',format:{type:'json_schema',name:'fd1_thesis_shadow',strict:true,schema:FD1_SCHEMA}}};
    const started=now(),controller=new AbortController();let timer,decision='ABSTAIN',answer=null,cost=null,error=null,requestId=null;
    try{
      timer=setTimeout(()=>controller.abort(),8500);out.gpt_calls++;
      const response=await guard.fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,
        headers:{'content-type':'application/json',authorization:'Bearer '+apiKey},body:JSON.stringify(body)});
      requestId=response.headers?.get?.('x-request-id')??null;
      const data=await response.json();cost=costOf(data);
      if(!response.ok||data.model!==MODEL)throw Error('GPT_HTTP_OR_MODEL');
      answer=validate(parseOutput(data),p);decision=answer.decision;
      if(answer.ignored_evidence.length)error='IGNORED_UNSUPPORTED_EVIDENCE:'+answer.ignored_evidence.slice(0,2).join(',').slice(0,64);
    }catch(e){error=String(e?.message??e).slice(0,100);}
    finally{clearTimeout(timer);}
    await db.query(finishReview,[r.job_key,decision,answer?.trend_valid??null,answer?.entry_valid??null,
      answer?.micro_only??null,JSON.stringify(answer?.e??[]),answer?.reason??null,MODEL,promptHash,schemaHash,
      requestId,Math.max(0,Math.round(now()-started)),cost??.012,error]);
    out.processed.push({task:r.task,state:'DONE',decision,error});
  }
  return out;
}
