-- Top30 Leader/Emerging SHADOW 타당성 감사 (2026-09-24) — 재현용 읽기 전용 쿼리.
-- 모든 쿼리는 SELECT 전용이다. 테이블 생성/수정/삭제 없음.
-- project: etaajwpernzrcdrifdnw

-- Q-A1. 패널 규모
select 'ranks' t, count(*) n, count(distinct symbol) syms, count(distinct cutoff) cutoffs,
       to_timestamp(min(cutoff)/1000) mn, to_timestamp(max(cutoff)/1000) mx, max(rk) maxrk from claude_ranks
union all
select 'p4', count(*), count(distinct symbol), count(distinct cutoff),
       to_timestamp(min(cutoff)/1000), to_timestamp(max(cutoff)/1000), max(rk) from claude_p4;

-- Q-A2. ret4/ret8 의 실제 horizon (자기조인 가격 대비 상관): ret4≈1h, ret8≈2h
with a as (select symbol,cutoff,e,ret4,ret8 from claude_p4 where random()<0.1)
select count(*) n,
 corr(a.ret4, b1.e/a.e-1) c_ret4_1h, corr(a.ret4, b4.e/a.e-1) c_ret4_4h,
 corr(a.ret8, b2.e/a.e-1) c_ret8_2h, corr(a.ret8, b8.e/a.e-1) c_ret8_8h
from a
left join claude_p4 b1 on b1.symbol=a.symbol and b1.cutoff=a.cutoff+3600000
left join claude_p4 b2 on b2.symbol=a.symbol and b2.cutoff=a.cutoff+7200000
left join claude_p4 b4 on b4.symbol=a.symbol and b4.cutoff=a.cutoff+4*3600000
left join claude_p4 b8 on b8.symbol=a.symbol and b8.cutoff=a.cutoff+8*3600000;

-- Q-A3. e(진입가) = cutoff+15분 1m 시가 (claude_k1 커버 구간)
with k as (select symbol, min(t) mn, max(t) mx from claude_k1 group by symbol),
p as (select p.symbol,p.cutoff,p.e from claude_p4 p join k on k.symbol=p.symbol
      and p.cutoff between k.mn+3600000 and k.mx-7200000 order by random() limit 300)
select (x.t-p.cutoff)/60000 off_min, sum((abs(x.o/p.e-1)<1e-9)::int) open_hits
from p join claude_k1 x on x.symbol=p.symbol and x.t between p.cutoff-20*60000 and p.cutoff+20*60000
group by 1 order by 1;

-- Q-A4. claude_ranks day open = KST 00:00 - 15분 1m 시가 (production 은 KST 00:00 정각)
-- (v17_market_scan_runs.details.top10 의 dayStart/reference15Close 와 대조; 본문 5.1 참조)

-- Q-A5. 순위 버킷 (전체 행, 일자 군집 t)
with b as (
 select *, case when rk<=3 then '01_top3' when rk<=10 then '02_4-10' when rk<=20 then '03_11-20'
   when rk<=30 then '04_21-30' when rk<=50 then '05_31-50' else '06_51+' end bucket,
 ret4 - avg(ret4) over (partition by cutoff) x4, (cutoff/86400000) d from claude_p4),
daily as (select bucket, d, avg(ret4) m4, avg(ret8) m8, avg(x4) mx4, count(*) n from b group by bucket,d)
select bucket, sum(n) n_rows, count(*) n_days,
 round(100*sum(m4*n)/sum(n),3) mean_1h_pct, round(100*sum(m8*n)/sum(n),3) mean_2h_pct,
 round((avg(m4)/(stddev(m4)/sqrt(count(*))))::numeric,2) t_day_1h,
 round((avg(m8)/(stddev(m8)/sqrt(count(*))))::numeric,2) t_day_2h,
 round((avg(mx4)/(stddev(mx4)/sqrt(count(*))))::numeric,2) t_excess_1h
from daily group by bucket order by bucket;

-- Q-A6. 심볼-일 최초 진입 이벤트만 (중복 표본 제거) — 셀별
with b as (select *, (cutoff+9*3600000)/86400000 kd from claude_p4),
cells as (
 select 'top3' c, * from b where rk<=3
 union all select 'top10_vr4+', * from b where rk<=10 and volume_ratio>=4
 union all select 'top10_vr<4', * from b where rk<=10 and volume_ratio<4
 union all select 'E_11-20_up20_60m', * from b where rk between 11 and 20 and rk4-rk>=20
 union all select 'E_11-30_up20_60m', * from b where rk between 11 and 30 and rk4-rk>=20),
f as (select * from (select *, row_number() over (partition by c,symbol,kd order by cutoff) rn from cells) z where rn=1),
d as (select c, kd, avg(ret4) m4, avg(ret8) m8, count(*) n from f group by 1,2)
select c, sum(n) n_first, count(*) days, round(100*sum(m4*n)/sum(n),3) m1h, round(100*sum(m8*n)/sum(n),3) m2h,
 round((avg(m4)/(stddev(m4)/sqrt(count(*))))::numeric,2) t1h, round((avg(m8)/(stddev(m8)/sqrt(count(*))))::numeric,2) t2h
from d group by c order by c;

-- Q-A7. 1분 후 진입 기준 재계산 (claude_k1: 225 심볼, 2026-09-01~09-19)
-- 본문 5.5 참조 (fwd60/fwd120 from open of cutoff+1m)

-- Q-B1. 실거래 409건 버전별 분해 (notional 정규화)
with t as (select *, realized_pnl_usdt/(original_quantity*entry_price) r,
 case when metadata->>'executionMode'<>'LEADER_MOMENTUM_V17' then 'X_nonV17'
      when metadata->>'entryTimingPolicyVersion' is null then 'A_V17_instant_40'
      when metadata->'v30Front' is not null and metadata->'v30Front'<>'null' then 'D_V30_GPT'
      when metadata->'b06133' is not null and metadata->'b06133'<>'null' then 'C_pullback_B06133'
      else 'B_pullback_nogate' end grp from v11_long_regime_positions where state='CLOSED')
select grp, exit_reason, count(*) n, round(100*avg(r),3) avg_ret_pct, round(sum(realized_pnl_usdt),2) pnl
from t group by 1,2 order by 1, n desc;

-- Q-C1. FD1 replay 결정 분포
select run_tag, task, count(*) n, count(*) filter (where decision='BUY') buy,
 count(*) filter (where decision='SKIP') skip, count(*) filter (where decision='ABSTAIN') abst, round(sum(api_cost_usd),3) cost
from fd1_replay_jobs group by 1,2;

-- Q-D1. production scanner 부하/차단 이력
select coalesce(details->>'blocked','(ok)') blocked, count(*), avg((details->>'requestWeight')::numeric) w
from v17_market_scan_runs group by 1;

-- Q-D2. GPT 통제/원장
select * from gpt_final_review_control;
select * from gpt_final_review_daily_budget order by utc_day desc limit 3;
