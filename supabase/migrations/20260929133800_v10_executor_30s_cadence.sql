-- Keep Leader20 entry execution responsive enough to use more than one available slot.
-- Production was updated in-place on 2026-09-29; this migration preserves the setting.
do $$
declare
  cmd text;
begin
  select command into cmd from cron.job where jobid = 50;
  if cmd is null then
    raise exception 'v10-lane-executor cron job 50 not found';
  end if;

  cmd := replace(cmd, 'timeout_milliseconds := 55000', 'timeout_milliseconds := 110000');

  perform cron.alter_job(
    50,
    schedule := '30 seconds',
    command := cmd,
    active := true
  );
end
$$;
