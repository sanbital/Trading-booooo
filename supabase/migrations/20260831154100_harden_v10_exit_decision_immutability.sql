create or replace function public.reject_v10_lane_exit_decision_mutation()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='UPDATE'
     and old.order_intent_id is null
     and new.order_intent_id is not null
     and (to_jsonb(new)-'order_intent_id')=(to_jsonb(old)-'order_intent_id') then
    return new;
  end if;
  raise exception 'V10_LANE_EXIT_DECISION_IMMUTABLE' using errcode='55000';
end;
$$;
revoke all on function public.reject_v10_lane_exit_decision_mutation() from public,anon,authenticated;
