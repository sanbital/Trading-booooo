-- Match the existing Binance gateway's Unicode letter/number contract.
-- Replace only symbol syntax checks; retain causal capture and lease/auth/budget code.
begin;
set local lock_timeout='1s';
do $$
declare r record; definition text;
begin
 for r in select c.oid,n.nspname,rel.relname,c.conname from pg_constraint c
 join pg_class rel on c.conrelid=rel.oid join pg_namespace n on rel.relnamespace=n.oid
 where c.contype='c' and (n.nspname='doa_capture' or (n.nspname='public' and rel.relname in ('leader20_members','leader20_campaigns')))
 and pg_get_constraintdef(c.oid) like '%[A-Z0-9]%' loop
  definition:=replace(pg_get_constraintdef(r.oid),'[A-Z0-9]','[[:alnum:]]');
  execute format('alter table %I.%I drop constraint %I',r.nspname,r.relname,r.conname);
  execute format('alter table %I.%I add constraint %I %s',r.nspname,r.relname,r.conname,definition);
 end loop;
 for r in select p.oid from pg_proc p join pg_namespace n on p.pronamespace=n.oid
 where n.nspname='public' and p.prokind='f'
 and p.proname in ('doa_gpt_capture_context','doa_gpt_capture_context_v3','doa_capture_rpc_before_leader20','doa_capture_rpc')
 and pg_get_functiondef(p.oid) like '%[A-Z0-9]%' loop
  execute replace(pg_get_functiondef(r.oid),'[A-Z0-9]','[[:alnum:]]');
 end loop;
end $$;
commit;
