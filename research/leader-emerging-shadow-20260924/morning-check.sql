-- LE-SHADOW-1 내일 오전 점검 SQL (2026-09-25). 전부 읽기 전용 SELECT. project etaajwpernzrcdrifdnw.
-- 목적: 배관·비용·행태 점검. 성과는 n 과 95% CI 만 보고하며 판정하지 않는다
-- (사전등록 PREREGISTRATION.md §9: 판정은 ≥15 거래일 AND ≥300 EMERGING-BUY 이후).
-- :since 는 첫 SCAN 사이클 시각으로 바꿔 쓴다 (아래 Q0 참조).

-- Q0. 배포 이후 창
select min(observed_at) first_scan, max(observed_at) last_scan, count(*) scans
from shadow_le.cycles where mode = 'SCAN';

-- ================================================================ 운영 KPI
-- O1. 사이클 실행률 / 상태 (기대 SCAN 수 = 경과분/5)
with w as (select min(started_at) t0, max(started_at) t1 from shadow_le.cycles where mode = 'SCAN')
select c.mode, c.status, count(*) n,
  round(100.0 * count(*) filter (where c.mode = 'SCAN' and c.status = 'OK') over () / nullif(floor(extract(epoch from (w.t1 - w.t0)) / 300) + 1, 0), 1) scan_ok_rate_pct
from shadow_le.cycles c, w group by c.mode, c.status, w.t0, w.t1 order by 1, 3 desc;

-- O2. 관찰자 지연 / source / velocity_valid / 가중치 / Binance 상태
select source, count(*) n,
  round(100.0 * avg((observer_age_ms <= 360000)::int), 1) observer_le_6m_pct,
  round(100.0 * avg(velocity_valid::int), 1) velocity_valid_pct,
  max(request_weight) max_cycle_weight, round(avg(request_weight), 1) avg_cycle_weight,
  max(used_weight_max) max_shared_ip_used_weight,
  count(*) filter (where binance_status <> 'OK') n_binance_not_ok,
  string_agg(distinct binance_status, ',') statuses
from shadow_le.cycles where mode = 'SCAN' group by source;

-- O3. 오류 목록 (최근 50)
select started_at, mode, status, errors from shadow_le.cycles where jsonb_array_length(errors) > 0 order by started_at desc limit 50;

-- O4. micro_complete (N5: < 90% 인 구간 결과 무효), 선정 후보 기준, 시간대별
select date_trunc('hour', observed_at) h, count(*) n_shortlisted,
  round(100.0 * avg(coalesce(micro_complete, false)::int), 1) micro_complete_pct,
  count(*) filter (where read_errors is not null) n_read_errors
from shadow_le.candidates where shortlisted group by 1 order by 1;

-- O5. 커버리지: production top10(15m 경계) ⊂ shadow top30 (같은 5분 버킷)
with p as (
  select distinct on (signal_close_at) signal_close_at, jsonb_path_query_array(details, '$.top10[*].symbol') top10
  from public.v17_market_scan_runs where signal_close_at >= (select min(observed_at) from shadow_le.cycles where mode = 'SCAN')
  order by signal_close_at, captured_at desc),
s as (select observation_bucket, rank_order from shadow_le.cycles where mode = 'SCAN' and status = 'OK')
select count(*) boundaries,
  round(avg((select count(*) from jsonb_array_elements_text(p.top10) x where s.rank_order->0 is not null and
     x in (select jsonb_array_elements_text(jsonb_path_query_array(s.rank_order, '$[0 to 29]'))))::numeric / 10), 3) mean_top10_in_top30,
  round(avg((select count(*) from jsonb_array_elements_text(p.top10) x where
     x in (select jsonb_array_elements_text(jsonb_path_query_array(s.rank_order, '$[0 to 9]'))))::numeric / 10), 3) mean_top10_overlap
from p join s on s.observation_bucket between p.signal_close_at and p.signal_close_at + interval '3 minutes';

-- O6. production V17 신호 중 shadow 가 같은 사이클 top30 에서 본 비율
select count(*) prod_signals,
  count(*) filter (where exists (select 1 from shadow_le.candidates k where k.symbol = s.symbol
    and k.observed_at between s.created_at - interval '10 minutes' and s.created_at + interval '5 minutes')) seen_in_top30
from public.v11_long_regime_signals s where s.created_at >= (select min(observed_at) from shadow_le.cycles where mode = 'SCAN');

-- O7. N1 감사: shadow_le_writer 가 실행한 모든 문장 중 shadow_le 밖 쓰기 / public 함수 호출 (기대 0, 0)
select count(*) n_statements, sum(calls) calls,
  count(*) filter (where query ~* '\m(insert\s+into|update|delete\s+from|merge\s+into|truncate|copy)\s+(?!shadow_le\.)') n_non_shadow_write,
  count(*) filter (where query ~* '\mpublic\.[a-z_0-9]+\s*\(') n_public_function_calls,
  count(*) filter (where query ~* '\m(create|alter|drop|grant|revoke)\M') n_ddl
from extensions.pg_stat_statements where userid = 'shadow_le_writer'::regrole;
-- O7b. 권한 재확인 (production 쓰기 권한 0, SELECT 8 표)
select count(*) filter (where has_table_privilege('shadow_le_writer', c.oid, 'INSERT') or has_table_privilege('shadow_le_writer', c.oid, 'UPDATE')
  or has_table_privilege('shadow_le_writer', c.oid, 'DELETE') or has_table_privilege('shadow_le_writer', c.oid, 'TRUNCATE')) prod_write_privs,
  count(*) filter (where has_table_privilege('shadow_le_writer', c.oid, 'SELECT')) prod_select_tables
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p');

-- O8. production 영향 (N2~N4): scanner 차단, executor last_error, FD1 production API 오류
select coalesce(details->>'blocked', '(ok)') scanner_blocked, count(*), max(captured_at)
from public.v17_market_scan_runs where captured_at >= (select min(started_at) from shadow_le.cycles) group by 1;
select circuit_open, circuit_reason, last_error, last_cycle_completed_at from public.v11_long_regime_runtime where singleton;
select date_trunc('hour', created_at) h, count(*) n, count(*) filter (where error is not null) n_err,
  count(*) filter (where error ~ '^HTTP_429') n_429, string_agg(distinct decision, ',') decisions
from public.gpt_final_entry_reviews where purpose = 'PRODUCTION' and created_at >= now() - interval '24 hours' group by 1 order by 1;

-- O9. GPT (2단계 전에는 0 이어야 함): shadow 원장, stand-down 상태
select shadow_le.budget_state() budget_today;
select gpt_state, count(*) from shadow_le.cycles where mode = 'SCAN' group by 1;

-- ================================================================ 비용 KPI (새 정보)
-- C1. lane 별 실행비용: spread, 600 USDT 슬리피지(mid 대비 / ask 초과), depth, COST_EXCEEDS_EDGE, HARD 차단
select lane, count(*) n,
  round(percentile_cont(.5) within group (order by (cost->>'spread_bps')::float8)::numeric, 2) spread_p50,
  round(percentile_cont(.9) within group (order by (cost->>'spread_bps')::float8)::numeric, 2) spread_p90,
  round(percentile_cont(.5) within group (order by (cost->>'entry_slippage_bps_600')::float8)::numeric, 2) slip600_p50,
  round(percentile_cont(.9) within group (order by (cost->>'entry_slippage_bps_600')::float8)::numeric, 2) slip600_p90,
  round(percentile_cont(.5) within group (order by (cost->>'roundtrip_cost_bps_real')::float8)::numeric, 2) roundtrip_real_p50,
  round(percentile_cont(.5) within group (order by (facts->'values'->>'ask_depth_to_order')::float8)::numeric, 2) ask_depth_to_order_p50,
  round(100.0 * avg(((soft_categories->>'COST_EXCEEDS_EDGE')::boolean)::int), 1) cost_exceeds_edge_pct,
  round(100.0 * avg((jsonb_array_length(coalesce(hard_block, '[]')) > 0)::int), 1) hard_block_pct
from shadow_le.candidates where shortlisted group by lane order by lane;
-- C2. HARD 차단 사유 분포
select lane, h reason, count(*) from shadow_le.candidates, jsonb_array_elements_text(coalesce(hard_block, '[]')) h where shortlisted group by 1, 2 order by 1, 3 desc;

-- ================================================================ 행태 KPI
-- B1. arm × lane 결정 분포
select k.lane, d.arm, d.decision, count(*) from shadow_le.decisions d join shadow_le.candidates k using (candidate_id) group by 1, 2, 3 order by 1, 2, 3;
-- B2. SOFT 카테고리 발생률 (선정 후보)
select lane, count(*) n,
  round(100.0 * avg(((soft_categories->>'VOLUME_OVERHEATED')::boolean)::int), 1) volume_overheated_pct,
  round(100.0 * avg(((soft_categories->>'EXTENDED_LEADER')::boolean)::int), 1) extended_leader_pct,
  round(100.0 * avg(((soft_categories->>'RANK_FADING')::boolean)::int), 1) rank_fading_pct
from shadow_le.candidates where shortlisted group by lane;
-- B3. lane / 선정 사유 분포, KST 시간대별 EMERGING 수 (자정 직후 편중 점검)
select selection_reason, count(*) from shadow_le.candidates group by 1 order by 2 desc;
select (minutes_since_kst_midnight / 60) kst_hour, count(*) filter (where lane = 'EMERGING') emerging, count(*) filter (where lane = 'EMERGING' and shortlisted) emerging_shortlisted
from shadow_le.candidates group by 1 order by 1;
-- B4. (2단계) GPT 결정 / WAIT 결과 / SKIP 사유
select decision, valid, count(*), round(avg(latency_ms)) avg_ms, round(sum(cost_usd), 4) usd from shadow_le.decisions where arm = 'GPT_ALT1' group by 1, 2;
select event, detail->>'reason' reason, count(*) from shadow_le.wait_events group by 1, 2 order by 3 desc;
select r->>'c' category, count(*) from shadow_le.decisions, jsonb_array_elements(reasons) r where arm = 'GPT_ALT1' and decision = 'SKIP' group by 1;

-- ================================================================ v_compare 5군 (판정하지 않음)
-- V1. arm 별 5군: n, 60/120분 순 bps (현실 / 44), 95% CI (정규근사, 행 단위; 일자 군집 아님 → 참고용)
select arm, grp, count(*) n_all, count(hyp_net_bps_real_60m) n_60m,
  round(avg(hyp_net_bps_real_60m)::numeric, 1) net60_real,
  round((avg(hyp_net_bps_real_60m) - 1.96 * stddev_samp(hyp_net_bps_real_60m) / sqrt(nullif(count(hyp_net_bps_real_60m), 0)))::numeric, 1) ci_lo,
  round((avg(hyp_net_bps_real_60m) + 1.96 * stddev_samp(hyp_net_bps_real_60m) / sqrt(nullif(count(hyp_net_bps_real_60m), 0)))::numeric, 1) ci_hi,
  round(avg(hyp_net_bps_stress44_60m)::numeric, 1) net60_44,
  count(hyp_net_bps_real_120m) n_120m, round(avg(hyp_net_bps_real_120m)::numeric, 1) net120_real,
  round((avg(hyp_net_bps_real_120m) - 1.96 * stddev_samp(hyp_net_bps_real_120m) / sqrt(nullif(count(hyp_net_bps_real_120m), 0)))::numeric, 1) ci120_lo,
  round((avg(hyp_net_bps_real_120m) + 1.96 * stddev_samp(hyp_net_bps_real_120m) / sqrt(nullif(count(hyp_net_bps_real_120m), 0)))::numeric, 1) ci120_hi,
  round(avg(hyp_net_bps_stress44_120m)::numeric, 1) net120_44,
  round(avg(hyp_sim_net_bps_real)::numeric, 1) sim_net_real, round(avg(hyp_sim_net_bps_stress44)::numeric, 1) sim_net_44,
  round(100 * avg(hyp_mfe_60)::numeric, 3) mfe60_pct, round(100 * avg(hyp_mae_60)::numeric, 3) mae60_pct,
  round(100.0 * avg((hyp_net_bps_real_60m > 0)::int), 1) win60_pct,
  string_agg(distinct entry_ref, ',') entry_refs
from shadow_le.v_compare group by arm, grp order by arm, grp;

-- V2. 일자 군집 t (주 가설 H1 형식; 표본 부족 시 참고만): RULE_BASELINE EMERGING BUY, 정밀 라벨
with x as (
  select k.kst_day, o.hyp_net_bps_real_60m v
  from shadow_le.v_arm_final f join shadow_le.candidates k using (candidate_id)
  join shadow_le.outcomes o on o.candidate_id = k.candidate_id and o.decision_id is null and o.entry_ref = 'ASK_AT_DECISION'
  where f.arm = 'RULE_BASELINE' and f.final_decision = 'BUY' and k.lane = 'EMERGING'),
d as (select kst_day, avg(v) m, count(*) n from x group by 1)
select count(*) days, sum(n) n_buy, round(avg(m)::numeric, 1) mean_daily_net60,
  round((avg(m) / nullif(stddev_samp(m) / sqrt(count(*)), 0))::numeric, 2) t_day_clustered
from d;

-- V3. 1슬롯 포트폴리오 (arm 별)
select 'RULE_BASELINE' arm, count(*) filter (where taken) n_taken, count(*) n_all,
  round(sum(net_bps_real) filter (where taken)::numeric / 1e4 * 600, 2) net_usdt_real, round(sum(net_bps_stress44) filter (where taken)::numeric / 1e4 * 600, 2) net_usdt_44
from shadow_le.portfolio_1slot('RULE_BASELINE', (select min(observed_at) from shadow_le.cycles where mode = 'SCAN'))
union all
select 'TAKE_ALL', count(*) filter (where taken), count(*),
  round(sum(net_bps_real) filter (where taken)::numeric / 1e4 * 600, 2), round(sum(net_bps_stress44) filter (where taken)::numeric / 1e4 * 600, 2)
from shadow_le.portfolio_1slot('TAKE_ALL', (select min(observed_at) from shadow_le.cycles where mode = 'SCAN'));

-- V4. 라벨 진행: 정밀/관찰자/연결 적체
select entry_ref, count(*), round(100.0 * avg(data_complete::int), 1) complete_pct from shadow_le.outcomes group by 1;
select link_stage, count(*), count(*) filter (where prod_gpt_buy) prod_gpt_buy, count(*) filter (where prod_entered) prod_entered from shadow_le.production_link group by 1;
