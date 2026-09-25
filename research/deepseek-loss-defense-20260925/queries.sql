-- Read-only queries used for README.md (production project etaajwpernzrcdrifdnw).

-- 1. Live positions by peak bucket, normalized to 450 USDT notional
with p as (
  select realized_pnl_usdt / nullif(original_quantity * entry_price, 0) * 100 ret,
         (peak_price / entry_price - 1) * 100 pk,
         extract(epoch from closed_at - entry_at) / 60 hm
  from v11_long_regime_positions
  where state = 'CLOSED' and entry_at >= '2026-09-08')
select case when pk < 0.3 then 'a <0.3' when pk < 0.7 then 'b 0.3-0.7' when pk < 1.2 then 'c 0.7-1.2'
            when pk < 1.7 then 'd 1.2-1.7' when pk < 2.2 then 'e 1.7-2.2' when pk < 3 then 'f 2.2-3'
            when pk < 5 then 'g 3-5' else 'h 5+' end bucket,
       count(*) n, round(avg((ret > 0)::int), 2) win, round(avg(ret), 3) avg_ret_pct,
       round(sum(ret * 450 / 100), 1) pnl_at450, round(avg(hm), 1) avg_hold
from p group by 1 order by 1;

-- 2. DOA rate by entry-feature tertile, positions not in the FD1 sample
with p as (
  select realized_pnl_usdt / nullif(original_quantity * entry_price, 0) * 100 ret_pct,
         (peak_price / entry_price - 1) * 100 peak_pct,
         (metadata->'entryFeatures'->>'return30m')::numeric r30
  from v11_long_regime_positions
  where state = 'CLOSED' and entry_at >= '2026-09-08' and entry_at < '2026-09-24 05:00+00'),
q as (select *, ntile(3) over (order by r30) t from p where r30 is not null)
select t, count(*), round(avg(ret_pct), 3) avg_ret_pct, round(avg((peak_pct < 0.5)::int), 2) doa
from q group by t order by t;
-- (repeat with dayReturn, return60m, return5m, bbPos)

-- 3. Chronological 5-minute early-failure rule on tracked candidates
with c as (
  select case when candidate_at < '2026-09-16' then 'DEV' else 'TEST' end part, 0.025 s,
         mfe_5 f5, mae_5 a5, close_5m / reference_price - 1 c5,
         mae_60 a60, close_60m / reference_price - 1 c60, mfe_60 f60
  from missed_opportunity_journal where close_60m is not null and reference_price > 0),
r as (
  select *, (case when a60 <= -s then -s else c60 end) - 0.001 base,
         (case when a5 <= -s then -s when f5 < 0.003 then c5 when a60 <= -s then -s else c60 end) - 0.001 e5_03,
         (case when a5 <= -s then -s when f5 < 0.005 then c5 when a60 <= -s then -s else c60 end) - 0.001 e5_05
  from c)
select part, count(*), round(avg(base) * 100, 3) base, round(avg(e5_03) * 100, 3) e5_03,
       round(avg(e5_05) * 100, 3) e5_05,
       round(avg((f5 < 0.003 and a5 > -s and f60 >= 0.03)::int), 4) killed_3pct_winners
from r group by part order by part;

-- 4. Join replayed ENTRY packets to outcomes (keys from live-provider-replay.json, task=ENTRY)
select r.job_key, r.symbol, m.realized_net_usdt, m.reconstructed_net_usdt,
       m.mfe_5, m.mae_5, m.close_5m / m.reference_price - 1 c5,
       m.mfe_60, m.mae_60, m.close_60m / m.reference_price - 1 c60, m.terminal_class
from gpt_final_entry_reviews r
join missed_opportunity_journal m on m.signal_id::text = r.signal_id
where r.job_key = any(:entry_job_keys);
