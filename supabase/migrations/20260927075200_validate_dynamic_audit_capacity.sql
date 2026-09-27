-- Validate independently so the preceding size-bound change holds no table lock during this scan.
set local lock_timeout = '1s';
set local statement_timeout = '30s';
alter table public.gpt_final_entry_reviews validate constraint gpt_final_entry_reviews_record_check;
