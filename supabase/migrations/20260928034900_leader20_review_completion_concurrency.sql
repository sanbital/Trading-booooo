CREATE OR REPLACE FUNCTION public.gpt_final_review_complete(p_job_key text, p_owner uuid, p_record jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '500ms'
 SET statement_timeout TO '2500ms'
AS $function$
DECLARE j public.gpt_final_entry_reviews; r jsonb := p_record->'result'; u jsonb := p_record#>'{result,usage}';
 v_attempted boolean := coalesce((p_record#>>'{result,attempted}')::boolean,false);
 v_cost numeric := CASE WHEN jsonb_typeof(p_record#>'{result,api_cost_usd}')='number' THEN (p_record#>>'{result,api_cost_usd}')::numeric END;
 v_settled numeric;
BEGIN
 -- Physical provider calls use their own atomic ledger. Only legacy parent
 -- reservations need the global daily-budget lock; independent completions do not.
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
 IF j.provider_ledger IS DISTINCT FROM true THEN perform pg_advisory_xact_lock(20260927,40); END IF;
 IF jsonb_typeof(p_record)<>'object' OR jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'REVIEW_RESULT_INVALID'; END IF;
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key FOR UPDATE;
 IF j.owner=p_owner AND j.state='DONE' AND j.record=p_record THEN
  RETURN jsonb_build_object('done',true,'duplicate',true,'settled_usd',j.settled_usd);
 END IF;
 IF j.job_key IS NULL OR j.owner IS DISTINCT FROM p_owner OR j.state<>'RUNNING' THEN RAISE EXCEPTION 'REVIEW_RESULT_CAS'; END IF;
 v_settled := CASE WHEN NOT v_attempted THEN 0 WHEN v_cost IS NOT NULL AND v_cost>=0 AND v_cost::text NOT IN ('NaN','Infinity','-Infinity') THEN v_cost END;
 UPDATE public.gpt_final_entry_reviews SET state='DONE',record=p_record,completed_at=clock_timestamp(),
  settled_usd=v_settled,model=p_record#>>'{result,model_requested}',prompt_hash=p_record->>'prompt_hash',schema_hash=p_record->>'schema_hash',
  source_commit=p_record->>'source_commit',candidate_id=p_record#>>'{packet,candidate_id}',snapshot_hash=p_record#>>'{packet,snapshot_hash}',
  decision=r->>'decision',valid=coalesce((r->>'valid')::boolean,false),error=left(r->>'error',200),attempted=v_attempted,
  request_id=left(r->>'request_id',200),
  input_tokens=CASE WHEN jsonb_typeof(u->'input_tokens')='number' THEN (u->>'input_tokens')::integer END,
  cached_input_tokens=CASE WHEN jsonb_typeof(u#>'{input_tokens_details,cached_tokens}')='number' THEN (u#>>'{input_tokens_details,cached_tokens}')::integer END,
  output_tokens=CASE WHEN jsonb_typeof(u->'output_tokens')='number' THEN (u->>'output_tokens')::integer END,
  api_cost_usd=v_cost,cost_basis=left(r->>'cost_basis',80),
  latency_ms=CASE WHEN jsonb_typeof(r->'latency_ms')='number' THEN (r->>'latency_ms')::integer END,
  api_started_at=CASE WHEN jsonb_typeof(r->'started_at_ms')='number' THEN to_timestamp((r->>'started_at_ms')::double precision/1000) END,
  api_completed_at=CASE WHEN jsonb_typeof(r->'completed_at_ms')='number' THEN to_timestamp((r->>'completed_at_ms')::double precision/1000) END,
  snapshot_at=CASE WHEN jsonb_typeof(p_record->'snapshot_at_ms')='number' THEN to_timestamp((p_record->>'snapshot_at_ms')::double precision/1000) END
 WHERE job_key=p_job_key;
 IF v_settled IS NOT NULL AND j.budget_day IS NOT NULL AND j.reserved_usd IS NOT NULL THEN
  UPDATE public.gpt_final_review_daily_budget SET reserved_usd=greatest(0,reserved_usd-(j.reserved_usd-v_settled)),settled_usd=settled_usd+v_settled
  WHERE utc_day=j.budget_day;
 END IF;
 RETURN jsonb_build_object('done',true,'settled_usd',v_settled);
END $function$;

CREATE OR REPLACE FUNCTION public.ai_call_transition(p_key text, p_owner uuid, p_state text, p_usage jsonb DEFAULT NULL::jsonb, p_request_id text DEFAULT NULL::text, p_latency_ms bigint DEFAULT NULL::bigint, p_error text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare j public.ai_call_ledger%rowtype; cost numeric; i bigint;o bigint;c bigint;
begin
 -- State-only transitions retain the same reservation and need only the row lock.
 if p_state in ('SETTLED','CANCELLED') then perform pg_advisory_xact_lock(20260928,51); end if;
 select * into j from public.ai_call_ledger where call_key=p_key for update;
 if not found or j.owner<>p_owner then raise exception 'API_CALL_OWNER'; end if;
 if j.state=p_state and p_state in ('SETTLED','CANCELLED','UNKNOWN') then return jsonb_build_object('state',j.state,'duplicate',true); end if;
 if p_state='DISPATCHED' and j.state='RESERVED' then
  update public.ai_call_ledger set state=p_state where call_key=p_key;
 elsif p_state='CANCELLED' and j.state='RESERVED' then
  update public.ai_call_ledger set state=p_state,actual_usd=0,settled_at=clock_timestamp() where call_key=p_key;
 elsif p_state='UNKNOWN' and j.state='DISPATCHED' then
  update public.ai_call_ledger set state=p_state,error=p_error where call_key=p_key;
 elsif p_state='SETTLED' and j.state in ('DISPATCHED','UNKNOWN') then
  i:=(p_usage->>'input_tokens')::bigint;o:=(p_usage->>'output_tokens')::bigint;c:=coalesce((p_usage->>'cached_input_tokens')::bigint,0);
  if i is null or o is null or i<0 or o<0 or c<0 or c>i then raise exception 'API_USAGE_INVALID'; end if;
  cost:=case when j.provider='deepseek' then ((i-c)*.3+c*.006+o*1.2)/1000000
   else ((i-c)*.75+c*.075+o*4.5)/1000000 end;
  -- True metered usage is never truncated to a reservation, even if a provider exceeds it.
  update public.ai_call_ledger set state=p_state,actual_usd=cost,input_tokens=i,output_tokens=o,cached_input_tokens=c,
   request_id=p_request_id,cost_basis='TOKEN_RATE_PEAK_NOT_INVOICE',latency_ms=p_latency_ms,
   settled_at=clock_timestamp(),error=case when cost>reserved_usd then 'RESERVATION_EXCEEDED' else p_error end where call_key=p_key;
 else raise exception 'API_CALL_TRANSITION'; end if;
 return jsonb_build_object('state',p_state,'cost_usd',cost);
end $function$;
