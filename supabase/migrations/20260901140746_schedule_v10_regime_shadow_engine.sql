create or replace function public.invoke_v10_regime_shadow_engine(p_mode text default 'run')
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_token text;
  v_request_id bigint;
  v_body jsonb;
begin
  select token into v_token
  from public.edge_internal_tokens
  where name='v10-lane-signal-generator'
  limit 1;
  if v_token is null or length(v_token)<32 then
    raise exception 'V10_SHADOW_INTERNAL_TOKEN_MISSING';
  end if;
  v_body := case when lower(coalesce(p_mode,'run'))='diagnostic'
    then jsonb_build_object('mode','diagnostic')
    else jsonb_build_object('mode','run') end;
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-regime-shadow-engine',
    headers := jsonb_build_object('x-v10-lane-token',v_token,'content-type','application/json'),
    body := v_body,
    timeout_milliseconds := 120000
  ) into v_request_id;
  return v_request_id;
end;
$function$;

revoke all on function public.invoke_v10_regime_shadow_engine(text) from public, anon, authenticated;
grant execute on function public.invoke_v10_regime_shadow_engine(text) to service_role;

do $block$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='v10-regime-shadow-engine-15m' limit 1;
  if v_job is not null then perform cron.unschedule(v_job); end if;
  perform cron.schedule(
    'v10-regime-shadow-engine-15m',
    '1,16,31,46 * * * *',
    $cron$select public.invoke_v10_regime_shadow_engine('run');$cron$
  );
end
$block$;