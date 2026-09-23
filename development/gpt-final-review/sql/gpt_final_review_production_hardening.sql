-- GPT final entry review: production hardening of the review journal.
-- Scope: GPT review tables/functions only plus one read-only CEC preview function.
-- Does NOT change trading tables, circuit, operator controls, CEC state, sizing, slots
-- or exit policy. The control row is seeded OFF with a zero budget.
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';

-- 1. Operator control (auditable DB state; the executor only reads it).
CREATE TABLE IF NOT EXISTS public.gpt_final_review_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','SHADOW','ENFORCE')),
  daily_cap_usd numeric NOT NULL DEFAULT 0 CHECK (daily_cap_usd >= 0 AND daily_cap_usd <= 10 AND daily_cap_usd::text NOT IN ('NaN','Infinity','-Infinity')),
  max_calls_per_day integer NOT NULL DEFAULT 0 CHECK (max_calls_per_day BETWEEN 0 AND 1000),
  enforce_approved boolean NOT NULL DEFAULT false,
  approval_ref text CHECK (approval_ref IS NULL OR length(approval_ref) BETWEEN 1 AND 200),
  set_reason text,
  set_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gpt_control_active_requires_budget CHECK (mode = 'OFF' OR (approval_ref IS NOT NULL AND daily_cap_usd >= 0.10 AND max_calls_per_day > 0)),
  CONSTRAINT gpt_control_enforce_requires_approval CHECK (mode <> 'ENFORCE' OR enforce_approved)
);
INSERT INTO public.gpt_final_review_control(singleton,mode,daily_cap_usd,max_calls_per_day,enforce_approved,approval_ref,set_reason,set_by)
VALUES (true,'OFF',0,0,false,NULL,'Initial install: GPT final review disabled; no production budget approved.','migration:gpt_final_review_production_hardening')
ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE public.gpt_final_review_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gpt_final_review_control FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.gpt_final_review_control TO service_role;
COMMENT ON TABLE public.gpt_final_review_control IS 'GPT final entry reviewer mode and finite daily API budget. Executor reads only. OFF = existing model path unchanged.';

-- 2. Queryable projections of the immutable review record.
ALTER TABLE public.gpt_final_entry_reviews
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'PRODUCTION' CHECK (purpose IN ('PRODUCTION','VERIFICATION','DRYRUN')),
  ADD COLUMN IF NOT EXISTS budget_day date,
  ADD COLUMN IF NOT EXISTS reserved_usd numeric,
  ADD COLUMN IF NOT EXISTS settled_usd numeric,
  ADD COLUMN IF NOT EXISTS signal_id text,
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS prompt_hash text,
  ADD COLUMN IF NOT EXISTS schema_hash text,
  ADD COLUMN IF NOT EXISTS source_commit text,
  ADD COLUMN IF NOT EXISTS candidate_id text,
  ADD COLUMN IF NOT EXISTS snapshot_hash text,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS valid boolean,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS attempted boolean,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS input_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  ADD COLUMN IF NOT EXISTS api_cost_usd numeric,
  ADD COLUMN IF NOT EXISTS cost_basis text,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS api_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS api_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_at timestamptz;
CREATE INDEX IF NOT EXISTS gpt_final_entry_reviews_created_idx ON public.gpt_final_entry_reviews(created_at DESC);
ALTER TABLE public.gpt_final_review_daily_budget ADD COLUMN IF NOT EXISTS settled_usd numeric NOT NULL DEFAULT 0 CHECK (settled_usd >= 0);

-- 3. Claim: unchanged idempotency/budget semantics, now also records purpose, budget day
--    and reservation; the latest approved cap/call limit governs the day row.
CREATE OR REPLACE FUNCTION public.gpt_final_review_claim(p_job_key text,p_record jsonb,p_cap_usd numeric,p_max_calls integer,p_reserve_usd numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; b public.gpt_final_review_daily_budget; d date := (now() AT TIME ZONE 'UTC')::date;
 v_purpose text := coalesce(p_record->>'purpose','PRODUCTION');
BEGIN
 IF p_cap_usd IS NULL OR p_max_calls IS NULL OR p_reserve_usd IS NULL OR p_cap_usd<=0 OR p_max_calls<=0 OR p_reserve_usd<0.10 OR p_cap_usd::text IN ('NaN','Infinity','-Infinity') OR p_reserve_usd::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'APPROVED_API_BUDGET_REQUIRED';
 END IF;
 IF v_purpose NOT IN ('PRODUCTION','VERIFICATION','DRYRUN') THEN RAISE EXCEPTION 'REVIEW_PURPOSE_INVALID'; END IF;
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
 IF j.job_key IS NOT NULL THEN RETURN jsonb_build_object('created',false,'row',to_jsonb(j)); END IF;
 INSERT INTO public.gpt_final_review_daily_budget(utc_day,cap_usd,max_calls) VALUES(d,p_cap_usd,p_max_calls) ON CONFLICT(utc_day) DO NOTHING;
 SELECT * INTO b FROM public.gpt_final_review_daily_budget WHERE utc_day=d FOR UPDATE;
 -- Re-check under the budget lock: a concurrent claimer of the same job may have won.
 INSERT INTO public.gpt_final_entry_reviews(job_key,state,record,purpose,budget_day,reserved_usd,signal_id,symbol)
 VALUES(p_job_key,'RUNNING',p_record,v_purpose,d,p_reserve_usd,p_record#>>'{identity,signal_id}',p_record#>>'{identity,symbol}')
 ON CONFLICT(job_key) DO NOTHING RETURNING * INTO j;
 IF j.job_key IS NULL THEN
  SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
  RETURN jsonb_build_object('created',false,'row',to_jsonb(j));
 END IF;
 IF b.calls>=p_max_calls OR b.reserved_usd+p_reserve_usd>p_cap_usd THEN
  RAISE EXCEPTION 'API_BUDGET_EXHAUSTED';
 END IF;
 UPDATE public.gpt_final_review_daily_budget SET calls=calls+1,reserved_usd=reserved_usd+p_reserve_usd,cap_usd=p_cap_usd,max_calls=p_max_calls WHERE utc_day=d;
 RETURN jsonb_build_object('created',true,'row',to_jsonb(j));
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) TO service_role;

-- 4. Complete: RUNNING -> DONE exactly once by the claiming owner. Projects telemetry
--    columns from the stored record and releases only the unused part of a reservation
--    when the billed usage is known. Unknown usage (timeout, network) keeps the full reserve.
CREATE OR REPLACE FUNCTION public.gpt_final_review_complete(p_job_key text,p_owner uuid,p_record jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; r jsonb := p_record->'result'; u jsonb := p_record#>'{result,usage}';
 v_attempted boolean := coalesce((p_record#>>'{result,attempted}')::boolean,false);
 v_cost numeric := CASE WHEN jsonb_typeof(p_record#>'{result,api_cost_usd}')='number' THEN (p_record#>>'{result,api_cost_usd}')::numeric END;
 v_settled numeric;
BEGIN
 IF jsonb_typeof(p_record)<>'object' OR jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'REVIEW_RESULT_INVALID'; END IF;
 SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key FOR UPDATE;
 IF j.job_key IS NULL OR j.owner IS DISTINCT FROM p_owner OR j.state<>'RUNNING' THEN RAISE EXCEPTION 'REVIEW_RESULT_CAS'; END IF;
 v_settled := CASE WHEN NOT v_attempted THEN 0 WHEN v_cost IS NOT NULL AND v_cost>=0 AND v_cost<=coalesce(j.reserved_usd,v_cost) THEN v_cost END;
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
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_complete(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_complete(text,uuid,jsonb) TO service_role;

-- 5. Read-only CEC preview for order-free dry runs. Runs the unchanged decide function
--    inside a subtransaction that is always rolled back: no decision row, no EWMA,
--    reject-run or target change survives. An existing signal decision is returned by
--    decide's own idempotent branch. Never used by the live entry path.
CREATE OR REPLACE FUNCTION public.v11_cec0040_preview_readonly(p_signal_id uuid,p_decision_at timestamptz,p_symbol text,p_branch text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE v jsonb;
BEGIN
 BEGIN
  v := public.v11_cec0040_decide(p_signal_id,p_decision_at,p_symbol,p_branch,false);
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CEC0040_PREVIEW_ROLLBACK';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'CEC0040_PREVIEW_ROLLBACK' THEN
   RETURN jsonb_build_object('ready',false,'preview',true,'reason','CEC0040_PREVIEW_ERROR:'||left(SQLERRM,120));
  END IF;
 END;
 RETURN v||jsonb_build_object('preview',true,'persisted',false);
END $$;
REVOKE ALL ON FUNCTION public.v11_cec0040_preview_readonly(uuid,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.v11_cec0040_preview_readonly(uuid,timestamptz,text,text) TO service_role;
