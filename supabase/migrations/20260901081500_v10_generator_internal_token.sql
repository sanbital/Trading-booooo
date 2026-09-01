-- V10 signal generator uses a dedicated internal token because this project's
-- cron environment does not expose a usable service-role JWT through Vault.

begin;

insert into public.edge_internal_tokens(name,token)
values('v10-lane-signal-generator',encode(gen_random_bytes(32),'hex'))
on conflict(name) do nothing;

do $$
declare
  v_job_id bigint;
  v_command text;
begin
  select jobid into v_job_id
  from cron.job
  where jobname='v10-lane-signal-generator-v3';

  if v_job_id is null then
    raise exception 'v10-lane-signal-generator-v3 cron job not found';
  end if;

  v_command := $command$
    with req as (
      select net.http_post(
        url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
        headers := jsonb_build_object(
          'x-v10-lane-token',(
            select token from public.edge_internal_tokens
            where name='v10-lane-signal-generator'
          ),
          'content-type','application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      ) request_id
    )
    insert into public.v10_lane_deployment_audit(
      stage,engine_revision,spec_sha256,edge_function_slug,request_id,passed,details
    )
    select
      'SCHEDULED_INVOCATION',
      'V10-LANES-3.0.0',
      '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
      'v10-lane-signal-generator',
      request_id,
      false,
      jsonb_build_object('scheduled_at',now())
    from req;
  $command$;

  perform cron.alter_job(
    job_id := v_job_id,
    schedule := '0,15,30,45 * * * *',
    command := v_command
  );
end
$$;

insert into public.v10_lane_deployment_audit(
  stage,engine_revision,spec_sha256,edge_function_slug,passed,details
)
values(
  'GENERATOR_INTERNAL_TOKEN_CONFIGURED',
  'V10-LANES-3.0.0',
  '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  'v10-lane-signal-generator',
  true,
  jsonb_build_object('auth','DEDICATED_INTERNAL_TOKEN','verify_jwt',false)
);

commit;
