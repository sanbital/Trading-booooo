import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
test('full trajectory audit fits the widened bounded journal without rewriting history',async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href),db=new PGlite();
 try{
  await db.exec("create table public.gpt_final_entry_reviews (id int,record jsonb constraint gpt_final_entry_reviews_record_check check(jsonb_typeof(record)='object' and octet_length(record::text)<300000)); insert into public.gpt_final_entry_reviews values(1,'{\"historical\":true}');");
  await db.exec(readFileSync(new URL('../supabase/migrations/20260927075100_dynamic_continuity_audit_capacity.sql',import.meta.url),'utf8'));
  await db.query('insert into public.gpt_final_entry_reviews values(2,$1)',[JSON.stringify({raw:'x'.repeat(450000)})]);
  await assert.rejects(db.query('insert into public.gpt_final_entry_reviews values(3,$1)',[JSON.stringify({raw:'x'.repeat(1000000)})]),/record_check/);
  await assert.rejects(db.query("insert into public.gpt_final_entry_reviews values(4,'[]')"),/record_check/);
  assert.deepEqual((await db.query('select record from public.gpt_final_entry_reviews where id=1')).rows[0].record,{historical:true});
 }finally{await db.close();}
});
