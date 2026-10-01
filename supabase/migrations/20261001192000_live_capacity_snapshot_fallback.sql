-- Do not cancel a valid ENTRY/RECHECK provider call solely because the cached
-- account snapshot is stale. A stale/incomplete snapshot is capacity uncertainty,
-- not proof of zero capacity. The executor performs the authoritative fresh
-- Binance portfolio read before any order and still fails closed if live state
-- cannot be proven.
do $$
declare
  v_def text;
  v_old text := 'if (cap->>''available'')::integer<1 then return jsonb_build_object(''created'',false,''reason'',''API_NO_ENTRY_CAPACITY'',''capacity'',cap);end if;';
  v_new text := 'if coalesce(cap->>''certain'',''false'')=''true'' and coalesce((cap->>''available'')::integer,0)<1 then return jsonb_build_object(''created'',false,''reason'',''API_NO_ENTRY_CAPACITY'',''capacity'',cap);end if;';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='ai_call_reserve'
    and pg_get_function_identity_arguments(p.oid)=
      'p_key text, p_provider text, p_model text, p_purpose text, p_parent text, p_version text, p_reserve numeric';

  if v_def is null then
    raise exception 'AI_CALL_RESERVE_NOT_FOUND';
  end if;

  if position(v_new in v_def)>0 then
    return;
  end if;

  if position(v_old in v_def)=0 then
    raise exception 'AI_CALL_RESERVE_EXPECTED_GUARD_NOT_FOUND';
  end if;

  execute replace(v_def,v_old,v_new);
end $$;
