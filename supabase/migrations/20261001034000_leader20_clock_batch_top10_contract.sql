begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Clock entry path is Top10 end-to-end. Historical Top20 packet rows remain readable.
do $migration$
declare source text;
begin
 select pg_get_functiondef('public.leader20_batch_claim(jsonb,text,boolean)'::regprocedure) into source;

 if strpos(source,'packet->>''version''=''TOP20_DEEPSEEK_BATCH_1''')=0
    or strpos(source,'p_packet->>''version'' is distinct from ''TOP20_DEEPSEEK_BATCH_1''')=0
    or strpos(source,'jsonb_array_length(p_packet->''symbols'')<>20')=0
    or strpos(source,'rank<=20')=0
 then raise exception 'TOP10_CLOCK_BATCH_BASELINE_CHANGED'; end if;

 source:=replace(source,
  'packet->>''version''=''TOP20_DEEPSEEK_BATCH_1''',
  'packet->>''version''=''TOP10_CLOCK_DEEPSEEK_BATCH_1''');
 source:=replace(source,
  'p_packet->>''version'' is distinct from ''TOP20_DEEPSEEK_BATCH_1''',
  'p_packet->>''version'' is distinct from ''TOP10_CLOCK_DEEPSEEK_BATCH_1''');
 source:=replace(source,
  'jsonb_array_length(p_packet->''symbols'')<>20',
  'jsonb_array_length(p_packet->''symbols'')<>10');
 source:=replace(source,
  '(select count(distinct x->>''id'') from jsonb_array_elements(p_packet->''symbols'')x)<>20',
  '(select count(distinct x->>''id'') from jsonb_array_elements(p_packet->''symbols'')x)<>10');
 source:=replace(source,
  'select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=20 and symbol=x->>''id''',
  'select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=least(l.watch_limit,10) and symbol=x->>''id''');

 execute source;
end
$migration$;

create unique index if not exists leader20_clock_one_top10_batch_per_slot
 on public.leader20_batches(periodic_slot)
 where packet->>'version'='TOP10_CLOCK_DEEPSEEK_BATCH_1';

notify pgrst,'reload schema';
commit;
