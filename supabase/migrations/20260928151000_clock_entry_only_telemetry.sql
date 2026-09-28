-- A position HOLD/EXIT review retains the entry batch as historical evidence.
-- It must never extend that batch's ENTRY decision timing or completion count.
-- Journal-only correction; no trading authority or position behavior changes.
do $migration$
declare source text; marker text:='w:=j#>''{record,packet,leader20,entry_window}'';';
 filter text:=' and r.record#>>''{packet,task}''=''ENTRY'' and coalesce(r.record->>''kind'',''FD1_ENTRY'')=''FD1_ENTRY''';
begin
 select pg_get_functiondef('public.leader20_clock_journal()'::regprocedure) into source;
 if strpos(source,marker)=0 or strpos(source,'r.purpose=''PRODUCTION''')=0 then raise exception 'CLOCK_JOURNAL_BASELINE_CHANGED';end if;
 source:=replace(source,marker,'if j#>>''{record,packet,task}'' is distinct from ''ENTRY'' or coalesce(j#>>''{record,kind}'',''FD1_ENTRY'')<>''FD1_ENTRY'' then return new;end if;
  '||marker);
 source:=replace(source,'r.purpose=''PRODUCTION''','r.purpose=''PRODUCTION'''||filter);
 execute source;
 select pg_get_functiondef('public.leader20_clock_expire()'::regprocedure) into source;
 if strpos(source,'r.purpose=''PRODUCTION''')=0 then raise exception 'CLOCK_EXPIRY_BASELINE_CHANGED';end if;
 source:=replace(source,'r.purpose=''PRODUCTION''','r.purpose=''PRODUCTION'''||filter);
 execute source;
end $migration$;

-- Correct only derived slot timings from the durable original ENTRY journals.
with timing as (
 select t.slot_at,min(r.api_started_at) started_at,max(coalesce(r.api_completed_at,r.completed_at)) completed_at
 from public.leader20_clock_slots t join public.gpt_final_entry_reviews r
  on r.record#>>'{packet,leader20,batch_id}'=t.batch_id::text and r.purpose='PRODUCTION'
  and r.record#>>'{packet,task}'='ENTRY' and coalesce(r.record->>'kind','FD1_ENTRY')='FD1_ENTRY'
 group by t.slot_at
)
update public.leader20_clock_slots t set gpt_started_at=x.started_at,gpt_completed_at=x.completed_at,updated_at=clock_timestamp()
from timing x where x.slot_at=t.slot_at and (t.gpt_started_at is distinct from x.started_at or t.gpt_completed_at is distinct from x.completed_at);
select public.leader20_clock_expire();
