-- Retain the current function body/ownership/ACL and every capacity, exact-slot,
-- frozen-capture and duplicate check. Only tolerate scheduler delivery jitter.
-- Admission stops at 60s; the original entry_window expiry remains slot + 120s.
do $migration$
declare source text; old_guard text := 'at_time>=slot_at+interval ''30 seconds''';
begin
 select pg_get_functiondef('public.leader20_batch_claim(jsonb,text,boolean)'::regprocedure) into source;
 if strpos(source,old_guard)=0 or
    (length(source)-length(replace(source,old_guard,'')))/length(old_guard)<>1 then
  raise exception 'CLOCK_BATCH_ADMISSION_BASELINE_CHANGED';
 end if;
 execute replace(source,old_guard,'at_time>=slot_at+interval ''60 seconds''');
end $migration$;
