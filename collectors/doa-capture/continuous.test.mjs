import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {normalizeSymbol} from './core.mjs';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE).href);
test('single-character base normalization matches active scanner symbols',()=>{
 for(const s of ['QUSDT','SPELLUSDT','JELLYJELLYUSDT'])assert.equal(normalizeSymbol(' '+s.toLowerCase()+' '),s);
 for(const s of ['USDT','Q/USDT','../QUSDT'])assert.equal(normalizeSymbol(s),null);
});
test('production capture: Q/SPELL/JELLY complete without a signal window; gaps/stale/future rejected; research caps isolated',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table public.v11_long_regime_signals(id uuid,symbol text,created_at timestamptz,status text,features jsonb);
 create table public.v11_long_regime_positions(id uuid,signal_id uuid,symbol text,entry_at timestamptz,entry_price numeric,state text,metadata jsonb);
 create table public.v17_market_scan_runs(captured_at timestamptz,details jsonb);
 grant select on public.v11_long_regime_signals,public.v11_long_regime_positions,public.v17_market_scan_runs to service_role;`);
 for(const n of ['20260925131209_doa_capture_live','20260925135156_doa_gpt_capture_context'])
  await db.exec(await readFile(new URL('../../supabase/migrations/'+n+'.sql',import.meta.url),'utf8'));
 await db.exec(`insert into doa_capture.control(id,enabled,gpt_context_enabled,protocol_sha256,starts_at,ends_at,requests,bytes_reserved)
 values(1,true,true,repeat('a',64),now()-interval '10 days',now()-interval '1 day',200000,500000000);
 insert into public.v17_market_scan_runs values(now(),' {"top10":[{"symbol":"QUSDT"},{"symbol":"SPELLUSDT"},{"symbol":"JELLYJELLYUSDT"}]}');`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20260926125702_continuous_capture_arbitration.sql',import.meta.url),'utf8'));
 await db.exec('set role service_role;');
 const rpc=async(action,body={})=>(await db.query('select public.doa_capture_rpc($1,$2::jsonb) r',[action,JSON.stringify({worker_id:'continuous-test',...body})])).rows[0].r;
 const watch=await rpc('watch');assert.equal(watch.enabled,true);assert.equal(watch.production_enabled,true);assert.ok(watch.watch.some(x=>x.symbol==='QUSDT'));
 const anchor=Math.floor(Date.now()/5000)*5000-5000,rows=[];
 for(const symbol of ['QUSDT','SPELLUSDT','JELLYJELLYUSDT'])for(let i=0;i<12;i++){
  const end=anchor-(11-i)*5000;rows.push({kind:'micro',symbol,at:new Date(end).toISOString(),payload:{
   interval_start:new Date(end-5000).toISOString(),interval_end:new Date(end).toISOString(),interval_ms:5000,
   bucket_complete:true,book_complete:true,trade_sequence_complete:true,coverage_25:true,mid:1+i*.001,spread_bps:2+i*.01,
   ask_25_usdt:10000,bid_25_usdt:11000,trade_count:10+i,buy_quote_5s:100+i,sell_quote_5s:60,
   displayed_ask_added_5s:50,displayed_ask_removed_5s:30,displayed_bid_added_5s:40,displayed_bid_removed_5s:20,
   buy_vwap_450:1.002+i*.001,sell_vwap_450:.998+i*.001,btc_return_1m:.002}});
 }
 await rpc('ingest',{batch_id:randomUUID(),rows});
 const context=async symbol=>(await db.query('select public.doa_gpt_capture_context($1,clock_timestamp()) r',[symbol])).rows[0].r;
 for(const symbol of ['QUSDT','SPELLUSDT','JELLYJELLYUSDT']){
  const c=await context(symbol);assert.equal(c.status,'AVAILABLE',JSON.stringify(c));assert.equal(c.buckets,12);assert.equal(c.trajectory.length,12);
  assert.equal(c.trajectory[0].d_mid_bps,null);assert.ok(c.trajectory[11].d_mid_bps>0);assert.equal(c.trajectory[11].trade_count,21);
 }
 assert.equal((await db.query('select count(*)::int n from doa_capture.observations')).rows[0].n,0,'research cap preserved');
 await db.exec(`reset role;update doa_capture.live_micro set received_at=now()+interval '1 minute' where symbol='QUSDT';set role service_role;`);
 assert.equal((await context('QUSDT')).reason,'INCOMPLETE_TRAJECTORY');
 await db.exec(`reset role;delete from doa_capture.live_micro where symbol='SPELLUSDT' and at=(select min(at) from doa_capture.live_micro where symbol='SPELLUSDT');set role service_role;`);
 assert.equal((await context('SPELLUSDT')).reason,'INCOMPLETE_TRAJECTORY');
 await db.exec(`reset role;update doa_capture.control set enabled=false;set role service_role;`);
 assert.equal((await context('JELLYJELLYUSDT')).reason,'DISABLED');
 await db.exec('reset role;set role anon;');await assert.rejects(context('QUSDT'),/permission denied/);
 }finally{await db.close();}
});
