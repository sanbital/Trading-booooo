-- CEC0040 is GPT evidence (2026-09-24): a CEC REJECT may still be bought by GPT. Such a
-- position must enter CEC's outcome tracking, otherwise CEC only ever learns from the
-- trades it liked (selection bias). The decision row itself is never modified; only the
-- action filters of target registration, repair and the registration-lag guard widen.
create or replace function public.v11_cec0040_missing_targets()
 returns table(position_id uuid, signal_id uuid, symbol text, branch text, entry_at timestamp with time zone, actual_entry_price numeric)
 language sql
 set search_path to ''
as $function$
  select p.id,d.signal_id,d.symbol,d.branch,p.entry_at,p.entry_price
  from public.v11_cec0040_decisions d
  join public.v11_long_regime_positions p on p.signal_id=d.signal_id
  left join public.v11_cec0040_targets t on t.position_id=p.id
  where d.model_action in ('ADMIT','PROBE','REJECT') and t.position_id is null
  order by p.entry_at,p.id
  limit 4
$function$;

do $mig$
declare src text; out text;
begin
  -- register_target: accept a REJECT decision (all other checks unchanged).
  src := pg_get_functiondef('public.v11_cec0040_register_target(uuid,uuid,text,text,timestamptz,numeric)'::regprocedure);
  out := replace(src, $q$d.model_action not in ('ADMIT','PROBE')$q$, $q$d.model_action not in ('ADMIT','PROBE','REJECT')$q$);
  if out = src then raise exception 'CEC0040_REGISTER_TARGET_PATTERN_NOT_FOUND'; end if;
  execute out;
  -- decide: a GPT-bought REJECT position without a target also holds new decisions (causal order).
  src := pg_get_functiondef('public.v11_cec0040_decide(uuid,timestamptz,text,text,boolean)'::regprocedure);
  out := replace(src, $q$where d0.model_action in ('ADMIT','PROBE') and t0.position_id is null$q$,
                      $q$where d0.model_action in ('ADMIT','PROBE','REJECT') and t0.position_id is null$q$);
  if out = src then raise exception 'CEC0040_DECIDE_PATTERN_NOT_FOUND'; end if;
  execute out;
end
$mig$;
