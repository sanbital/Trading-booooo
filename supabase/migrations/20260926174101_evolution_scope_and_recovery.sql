begin;
-- Match reserved authority words, not ordinary words such as marginal demand.
create or replace function public.evolution_scope_valid(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare s jsonb; c jsonb; k text;begin
 if jsonb_typeof(p) is distinct from 'object' or (select array_agg(x order by x) from jsonb_object_keys(p)x) is distinct from array['calibration','data_cutoff_ms','models','parent_version','policy_version','schema_version','stages'] then return false;end if;
 if p->>'data_cutoff_ms' is null or p->>'policy_version' is null or p->>'schema_version' is distinct from 'SELF_EVOLUTION_1' or p->>'policy_version' !~ '^POLICY_[A-Za-z0-9_-]{1,70}$' or (p->>'data_cutoff_ms')::bigint<0 then return false;end if;
 if p->'parent_version'<>'null'::jsonb and p->>'parent_version' !~ '^POLICY_[A-Za-z0-9_-]{1,70}$' then return false;end if;
 if p->'models' is distinct from jsonb_build_object('gpt','gpt-5.4-mini-2026-03-17','deepseek','deepseek-flash') then return false;end if;
 if (select array_agg(x order by x) from jsonb_object_keys(p->'stages')x) is distinct from array['ENTRY','EXIT','HOLD','RECHECK'] then return false;end if;
 for s in select value from jsonb_each(p->'stages') loop
  if (select array_agg(x order by x) from jsonb_object_keys(s)x) is distinct from array['calibration_strength','deepseek_rubric','feature_weights','gpt_rubric'] then return false;end if;
  if s->>'calibration_strength' is null or (s->>'calibration_strength')::numeric not between 0 and 1 then return false;end if;
  foreach k in array array['gpt_rubric','deepseek_rubric'] loop
   if jsonb_typeof(s->k) is distinct from 'array' or jsonb_array_length(s->k)>6 then return false;end if;
   if exists(select 1 from jsonb_array_elements(s->k)v where jsonb_typeof(v)<>'string' or length(v#>>'{}')>600 or (v#>>'{}') ~* '(\m(margin|leverage|position[_ -]?siz(e|ing)|order[_ -]?siz(e|ing)|max[_ -]?slots?|capital[_ -]?allocation|withdraw(al)?|transfer|api[_ -]?(key|secret|permission)|credential|execution[_ -]?safety|risk[_ -]?limit|hard[_ -]?(stop|floor)|account[_ -]?setting)\M|https?:|<script|eval\(|import[[:space:]]|ignore.{0,25}(system|safety)|exit.{0,20}(after|minutes|seconds)|증거금|레버리지|출금|물타기)') then return false;end if;
  end loop;
  if jsonb_typeof(s->'feature_weights') is distinct from 'array' or jsonb_array_length(s->'feature_weights')>17 then return false;end if;
  if (select count(*)<>count(distinct v->>'feature') from jsonb_array_elements(s->'feature_weights')v) then return false;end if;
  for c in select value from jsonb_array_elements(s->'feature_weights') loop
   if (select array_agg(x order by x) from jsonb_object_keys(c)x) is distinct from array['feature','weight'] or jsonb_typeof(c->'weight') is distinct from 'number' or c->>'feature' is null or (c->>'weight')::numeric not between 0 and 2 or c->>'feature'<>all(array['price_trajectory','acceleration','high_renewal','drawdown_recovery','taker_flow','buy_share','bid_replenishment','ask_pressure','spread_depth','executable_impact','open_interest','funding_premium','btc_regime','thesis_validity','winner_retention','loser_recognition','counterevidence']) then return false;end if;
  end loop;
 end loop;
 if jsonb_typeof(p->'calibration') is distinct from 'array' or jsonb_array_length(p->'calibration')>144 or octet_length(p::text)>40000 then return false;end if;
 for c in select value from jsonb_array_elements(p->'calibration') loop
  if (select array_agg(x order by x) from jsonb_object_keys(c)x) is distinct from array['accuracy','as_of_ms','correct','lower','metric','n','provider','regime','stage','upper'] then return false;end if;
  if exists(select 1 from jsonb_each(c) x where x.value='null'::jsonb) or c->>'stage' not in ('ENTRY','RECHECK','HOLD','EXIT') or c->>'regime' not in ('STRONG_TREND','WEAK_TREND','BREAKOUT','POST_BREAKOUT','PULLBACK','REVERSAL','HIGH_VOL','LOW_VOL','HIGH_LIQUIDITY','LOW_LIQUIDITY','VOLUME_EXPANSION','VOLUME_EXHAUSTION','MARKET_RISK_ON','MARKET_RISK_OFF','MARKET_WIDE_SELLOFF','ALT_RALLY','ISOLATED_PUMP','UNKNOWN') or (c->>'as_of_ms')::bigint<0 or (c->>'as_of_ms')::bigint>(p->>'data_cutoff_ms')::bigint or (c->>'n')::integer<0 or (c->>'correct')::integer not between 0 and (c->>'n')::integer or c->>'metric'<>'NET_DIRECTION_60S' or c->>'provider' not in ('gpt','deepseek') then return false;end if;
  if (c->>'accuracy')::numeric not between 0 and 1 or (c->>'lower')::numeric not between 0 and (c->>'accuracy')::numeric or (c->>'upper')::numeric not between (c->>'accuracy')::numeric and 1 then return false;end if;
 end loop;
 return true;
exception when others then return false;end $$;

create function public.evolution_register_candidate(p_hypothesis jsonb,p_bundle jsonb,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare active text; v text:=p_bundle->>'policy_version'; h text:=p_hypothesis->>'id'; existing text;begin
 select active_version into active from evolution_private.active_policy where singleton for update;
 if not public.evolution_scope_valid(p_bundle) or p_bundle->>'parent_version' is distinct from active or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'CANDIDATE_SCOPE_OR_PARENT';end if;
 select sha256 into existing from public.evolution_policy_bundles where version=v;
 if existing is not null then
  if existing<>p_hash then raise exception 'CANDIDATE_IMMUTABLE_CONFLICT';end if;
  return jsonb_build_object('state','SIMULATING','policy_version',v,'duplicate',true);
 end if;
 if exists(select 1 from public.evolution_policy_states where state in ('SIMULATING','VALIDATING','HOLDOUT_TEST','QUALIFIED','PROMOTING')) then return jsonb_build_object('waiting','FROZEN_CHALLENGER_IN_VALIDATION');end if;
 if h is null or length(h)>100 or p_hypothesis->>'policy_version' is distinct from v then raise exception 'HYPOTHESIS_IDENTITY';end if;
 insert into public.evolution_policy_bundles(version,parent_version,bundle,sha256,source_manifest,data_cutoff)
 select v,active,p_bundle,p_hash,source_manifest,to_timestamp((p_bundle->>'data_cutoff_ms')::numeric/1000) from public.evolution_policy_bundles where version=active;
 insert into public.evolution_policy_states(version,state,reason)values(v,'SIMULATING','FROZEN; PROSPECTIVE_VALIDATION_AND_UNTOUCHED_HOLDOUT_REQUIRED');
 insert into public.evolution_hypotheses(id,description,proposal,critique,supporting_patterns,policy_version,state)
 values(h,p_hypothesis->>'description',p_hypothesis->'proposal',p_hypothesis->'critique',p_hypothesis->'supporting_patterns',v,'SIMULATING')
 on conflict(id) do update set state='SIMULATING',critique=evolution_hypotheses.critique||jsonb_build_object('recovered_candidate',p_bundle);
 insert into public.evolution_jobs(dedupe_key,kind,payload,priority,available_at)values('simulate:'||v,'SIMULATE',jsonb_build_object('policy_version',v),18,now()+interval '1 minute')on conflict do nothing;
 insert into public.evolution_events(kind,policy_version,details)values('CHALLENGER_FROZEN',v,jsonb_build_object('hypothesis',h,'atomic_registration',true));
 return jsonb_build_object('state','SIMULATING','policy_version',v,'hypothesis',h);
end $$;
revoke all on function public.evolution_register_candidate(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.evolution_register_candidate(jsonb,jsonb,text) to service_role;
commit;

