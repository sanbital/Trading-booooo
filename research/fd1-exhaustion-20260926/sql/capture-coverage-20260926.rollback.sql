-- Rollback of capture-coverage-20260926.sql
do $$
declare d text;
begin
 d:=pg_get_functiondef('public.doa_capture_rpc(text,jsonb)'::regprocedure);
 d:=replace(d,$r$      union select symbol,now() from public.v11_long_regime_positions where state='OPEN'
      union select symbol,now() from public.v11_long_regime_signals where status='NEW' and created_at>now()-interval '30 minutes' and features->>'strategy'='LEADER_MOMENTUM_V17'
$r$,'');
 execute d;
 d:=pg_get_functiondef('public.doa_gpt_capture_context(text,timestamptz)'::regprocedure);
 d:=replace(d,$r$o.at > p_as_of - interval '95 seconds'$r$,$r$o.at > p_as_of - interval '75 seconds'$r$);
 execute d;
end $$;
