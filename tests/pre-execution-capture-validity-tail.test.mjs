import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql=fs.readFileSync(new URL('../supabase/migrations/20260930160500_pre_execution_capture_validity_tail.sql',import.meta.url),'utf8');

test('clock Top20 capture continues only through the immutable execution window',()=>{
  assert.match(sql,/entry_allowed:=coalesce\(\(funded or not certain\) and armed and in_path,false\)/);
  assert.match(sql,/validity_tail:=coalesce\(\(funded or not certain\) and armed and slot_ms is not null\s+and at_ms>=slot_ms\+1000 and at_ms<slot_ms\+120000,false\)/);
  assert.match(sql,/'enabled',entry_allowed/);
  assert.match(sql,/or entry_allowed or validity_tail\)\)/);
  assert.doesNotMatch(sql,/'enabled',\s*entry_allowed\s+or\s+validity_tail/);
});

test('capture-tail migration changes no trading authority or strategy surface',()=>{
  for(const forbidden of ['v11_long_regime_orders','OPEN_LONG','leverage','target_margin_per_slot','native','hard_stop'])
    assert.equal(sql.includes(forbidden),false,forbidden);
  assert.match(sql,/set local lock_timeout='2s'/);
  assert.match(sql,/set search_path=''/);
  assert.match(sql,/grant execute on function public\.doa_capture_rpc\(text,jsonb\) to service_role/);
});
