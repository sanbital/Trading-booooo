do $$
declare
  constraint_definition text;
begin
  select pg_get_constraintdef(oid)
    into constraint_definition
  from pg_constraint
  where conrelid = 'public.trading_settings'::regclass
    and conname = 'trading_settings_lob_mission_v6120';

  if constraint_definition is null then
    raise exception 'trading_settings_lob_mission_v6120 constraint not found';
  end if;

  if position('(lob_min_net_reward_risk_ratio >= 0.75)' in constraint_definition) = 0 then
    raise exception 'unexpected lob_min_net_reward_risk_ratio constraint definition: %', constraint_definition;
  end if;

  if position('(lob_max_stop_to_target_ratio <= 1.50)' in constraint_definition) = 0 then
    raise exception 'unexpected lob_max_stop_to_target_ratio constraint definition: %', constraint_definition;
  end if;

  constraint_definition := replace(
    constraint_definition,
    '(lob_min_net_reward_risk_ratio >= 0.75)',
    '(lob_min_net_reward_risk_ratio >= 0.10)'
  );
  constraint_definition := replace(
    constraint_definition,
    '(lob_max_stop_to_target_ratio <= 1.50)',
    '(lob_max_stop_to_target_ratio <= 4.00)'
  );

  execute 'alter table public.trading_settings drop constraint trading_settings_lob_mission_v6120';
  execute 'alter table public.trading_settings add constraint trading_settings_lob_mission_v6120 ' || constraint_definition;
end
$$;
