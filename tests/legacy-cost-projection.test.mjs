import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('legacy cost projection preserves every provider allocation and follows late settlement without double charge',async t=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();t.after(()=>db.close());
 await db.exec(await read('test-support/leader20-ledger-schema.sql'));
 await db.exec(await read('supabase/migrations/20260928012054_leader20_batch_provider_ledger.sql'));
 const advice=usage=>({result:{arbitration:{deepseek:{model:'deepseek-flash',usage}}}});
 const samples=[
  ['unknown-gpt','gpt-5.4-mini-2026-03-17',.05,null,advice({prompt_tokens:20000,completion_tokens:2000})],
  ['unknown-ds','deepseek-flash',.03,null,{}],
  ['settled-dual','gpt-5.4-mini-2026-03-17',.06,.04,advice({prompt_tokens:20000,completion_tokens:2000})],
  ['settled-ds','deepseek-flash',.03,.012,{}],
  ['capped','gpt-5.4-mini-2026-03-17',.05,.001,advice({prompt_tokens:20000,completion_tokens:2000})],
  ['missing','gpt-5.4-mini-2026-03-17',.05,.02,{}],
  ['string-usage','gpt-5.4-mini-2026-03-17',.05,.02,advice({prompt_tokens:'20000',completion_tokens:2000})],
  ['null-record','gpt-5.4-mini-2026-03-17',.05,0,null],
  ['provider-ledger','gpt-5.4-mini-2026-03-17',null,.02,advice({prompt_tokens:20000,completion_tokens:2000})],
 ];
 for(const day of ['2026-08-31','2026-09-01','2026-09-28','2026-10-01'])for(const [id,model,reserved,settled,record] of samples)
  await db.query('insert into gpt_final_entry_reviews(job_key,model,budget_day,reserved_usd,settled_usd,record) values($1,$2,$3,$4,$5,$6)',[day+id,model,day,reserved,settled,JSON.stringify(record)]);
 const totals=()=>db.query("select d,ai_legacy_deepseek_used(d,true)::text daily,ai_legacy_deepseek_used(d)::text monthly,ai_provider_month_used('deepseek',d)::text ds,ai_provider_month_used('openai',d)::text gpt from unnest(array['2026-08-31','2026-09-01','2026-09-28','2026-10-01']::date[])d");
 const before=await totals();
 await db.exec(await read('supabase/migrations/20260928050558_leader20_legacy_cost_projection.sql'));
 assert.deepEqual((await totals()).rows,before.rows);
 const ds=async id=>(await db.query('select legacy_deepseek_usd::text v from gpt_final_entry_reviews where job_key=$1',[id])).rows[0].v;
 assert.equal(Number(await ds('2026-09-28settled-dual')),.0084);
 assert.equal(Number(await ds('2026-09-28capped')),.001);
 assert.equal(Number(await ds('2026-09-28unknown-gpt')),0);
 assert.equal(Number(await ds('2026-09-28unknown-ds')),.03);
 assert.equal(Number(await ds('2026-09-28provider-ledger')),0);
 await db.query("update gpt_final_entry_reviews set settled_usd=.04 where job_key='2026-09-28unknown-gpt'");
 assert.equal(Number(await ds('2026-09-28unknown-gpt')),.0084,'late known usage moves the provider split once');
 const settled=await totals();
 await db.query("update gpt_final_entry_reviews set settled_usd=.04 where job_key='2026-09-28unknown-gpt'");
 assert.deepEqual((await totals()).rows,settled.rows,'repeat settlement is not another charge');
 await assert.rejects(db.exec("update gpt_final_entry_reviews set legacy_deepseek_usd=0"),/generated|DEFAULT/i);
 await db.query("update gpt_final_entry_reviews set record='{}' where job_key='2026-09-28unknown-gpt'");
 assert.equal(Number(await ds('2026-09-28unknown-gpt')),0,'a source correction recomputes the projection');
 const sums=await db.query("select ai_provider_month_used('deepseek','2026-09-28')+ai_provider_month_used('openai','2026-09-28') total");
 assert.equal(Number(sums.rows[0].total),40.13311308,'provider projection adds no money to legacy total');
});
