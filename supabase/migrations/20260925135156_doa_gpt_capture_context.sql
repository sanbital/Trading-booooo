begin;
alter table doa_capture.control add column gpt_context_enabled boolean not null default false;
create function public.doa_gpt_capture_context(p_symbol text,p_as_of timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((select case
 when not c.enabled or not c.gpt_context_enabled or now()>=c.ends_at then jsonb_build_object('status','UNAVAILABLE','reason','DISABLED')
 when c.heartbeat_at>p_as_of or c.heartbeat_at<p_as_of-interval '25 seconds' then jsonb_build_object('status','UNAVAILABLE','reason','STALE_OR_FUTURE')
 else coalesce(c.metrics->'live_contexts'->p_symbol,jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED')) || jsonb_build_object('ingested_at_ms',floor(extract(epoch from c.heartbeat_at)*1000))
 end from doa_capture.control c where id=1 and p_symbol ~ '^[A-Z0-9]{2,24}USDT$'),jsonb_build_object('status','UNAVAILABLE','reason','UNWATCHED'))
$$;
revoke all on function public.doa_gpt_capture_context(text,timestamptz) from public,anon,authenticated;
grant execute on function public.doa_gpt_capture_context(text,timestamptz) to service_role;
commit;
