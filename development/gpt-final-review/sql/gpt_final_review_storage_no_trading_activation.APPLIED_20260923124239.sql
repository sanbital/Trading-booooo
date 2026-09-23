-- Exact statements recorded in supabase_migrations.schema_migrations version 20260923124239 (applied before this work).
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
CREATE TABLE public.gpt_final_entry_reviews (
 job_key text PRIMARY KEY CHECK (job_key ~ '^[0-9a-f]{64}$'),
 owner uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL CHECK (state IN ('RUNNING','DONE')),
 record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<300000),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE public.gpt_final_review_daily_budget (
 utc_day date PRIMARY KEY,
 cap_usd numeric NOT NULL CHECK (cap_usd>0 AND cap_usd::text NOT IN ('NaN','Infinity','-Infinity')),
 max_calls integer NOT NULL CHECK(max_calls>0),
 reserved_usd numeric NOT NULL DEFAULT 0 CHECK(reserved_usd>=0 AND reserved_usd::text NOT IN ('NaN','Infinity','-Infinity')),
 calls integer NOT NULL DEFAULT 0 CHECK(calls>=0)
);
ALTER TABLE public.gpt_final_entry_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpt_final_review_daily_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gpt_final_entry_reviews,public.gpt_final_review_daily_budget FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.gpt_final_entry_reviews,public.gpt_final_review_daily_budget TO service_role;
CREATE FUNCTION public.gpt_final_review_claim(p_job_key text,p_record jsonb,p_cap_usd numeric,p_max_calls integer,p_reserve_usd numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='500ms' SET statement_timeout='2500ms' AS $$
DECLARE j public.gpt_final_entry_reviews; b public.gpt_final_review_daily_budget; d date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
 IF p_cap_usd IS NULL OR p_max_calls IS NULL OR p_reserve_usd IS NULL OR p_cap_usd<=0 OR p_max_calls<=0 OR p_reserve_usd<0.10 OR p_cap_usd::text IN ('NaN','Infinity','-Infinity') OR p_reserve_usd::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'APPROVED_API_BUDGET_REQUIRED';
 END IF;
 INSERT INTO public.gpt_final_entry_reviews(job_key,state,record) VALUES(p_job_key,'RUNNING',p_record) ON CONFLICT(job_key) DO NOTHING RETURNING * INTO j;
 IF j.job_key IS NULL THEN
  SELECT * INTO j FROM public.gpt_final_entry_reviews WHERE job_key=p_job_key;
  RETURN jsonb_build_object('created',false,'row',to_jsonb(j));
 END IF;
 INSERT INTO public.gpt_final_review_daily_budget(utc_day,cap_usd,max_calls) VALUES(d,p_cap_usd,p_max_calls) ON CONFLICT(utc_day) DO NOTHING;
 SELECT * INTO b FROM public.gpt_final_review_daily_budget WHERE utc_day=d FOR UPDATE;
 IF b.calls>=least(b.max_calls,p_max_calls) OR b.reserved_usd+p_reserve_usd>least(b.cap_usd,p_cap_usd) THEN
  RAISE EXCEPTION 'API_BUDGET_EXHAUSTED';
 END IF;
 UPDATE public.gpt_final_review_daily_budget SET calls=calls+1,reserved_usd=reserved_usd+p_reserve_usd WHERE utc_day=d;
 RETURN jsonb_build_object('created',true,'row',to_jsonb(j));
END $$;
REVOKE ALL ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gpt_final_review_claim(text,jsonb,numeric,integer,numeric) TO service_role;
COMMENT ON TABLE public.gpt_final_entry_reviews IS 'GPT review journal only. Installation does not enable trading or change any trading controls.';
COMMENT ON TABLE public.gpt_final_review_daily_budget IS 'Atomic API reservation ledger. No operational budget or call authorization is seeded by this migration.';
