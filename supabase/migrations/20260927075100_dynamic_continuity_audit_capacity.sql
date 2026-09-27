-- Full raw trajectories and both provider audits must fit without dropping evidence.
-- This widens an existing bound; historical rows already met the stricter 300 KB check.
set local lock_timeout = '1s';
set local statement_timeout = '5s';
alter table public.gpt_final_entry_reviews drop constraint gpt_final_entry_reviews_record_check;
alter table public.gpt_final_entry_reviews add constraint gpt_final_entry_reviews_record_check
  check (jsonb_typeof(record)='object' and octet_length(record::text)<1000000) not valid;
