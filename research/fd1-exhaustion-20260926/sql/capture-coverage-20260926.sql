-- 2026-09-26 capture coverage fix (DB only; no executor/worker change).
-- Problem: CAPTURE-CONTEXT-2 reads persisted 5s micro rows, but the worker only persists rows
-- within [at-60s, at+120s] of a window, and windows existed only for 4 minutes after signal
-- creation / entry. GPT ENTRY calls run 55-781s after signal creation and HOLD reviews run
-- long after entry, so ~half of ENTRY/RECHECK and all later HOLD calls got
-- INCOMPLETE_TRAJECTORY. Ingestion (15s flush) also left <12 rows in a 75s lookback.
-- Fix 1: keep a rolling window (at=now()) for V17 signals still NEW (<=30 min) and OPEN positions.
-- Fix 2: lookback 75s -> 95s; still the latest 12 contiguous buckets (50-65s span check kept),
--        and the executor still rejects contexts older than 25s.
do $$
declare d text;
begin
 d:=pg_get_functiondef('public.doa_capture_rpc(text,jsonb)'::regprocedure);
 if position('state=''OPEN''
      union select symbol,now()' in d)=0 then
  d:=replace(d,$r$      union select symbol,entry_at from public.v11_long_regime_positions where entry_at>=c.starts_at and entry_at>now()-interval '4 minutes'
$r$,$r$      union select symbol,entry_at from public.v11_long_regime_positions where entry_at>=c.starts_at and entry_at>now()-interval '4 minutes'
      union select symbol,now() from public.v11_long_regime_positions where state='OPEN'
      union select symbol,now() from public.v11_long_regime_signals where status='NEW' and created_at>now()-interval '30 minutes' and features->>'strategy'='LEADER_MOMENTUM_V17'
$r$);
  if position('status=''NEW'' and created_at>now()-interval ''30 minutes''' in d)=0 then raise exception 'rpc patch did not apply'; end if;
  execute d;
 end if;
 d:=pg_get_functiondef('public.doa_gpt_capture_context(text,timestamptz)'::regprocedure);
 if position('interval ''75 seconds''' in d)>0 then
  d:=replace(d,$r$o.at > p_as_of - interval '75 seconds'$r$,$r$o.at > p_as_of - interval '95 seconds'$r$);
  execute d;
 end if;
end $$;
