-- Read-only queries behind research/fd1-opportunity-refinement-20260925 (production, cutoff 2026-09-24 18:57 UTC).
-- Money is normalized to a 450 USDT notional: 450*net/coalesce(nullif(target_notional_usdt,0),450).

-- 1. FD1-era candidates by ENTRY-only initial GPT decision (HOLD/EXIT reviews excluded).
with j as (
  select j.*, coalesce(nullif(j.target_notional_usdt,0),450) notional, e.decision entry_dec, e.record->'result'->>'error' entry_err,
   (select count(*) from public.v11_long_regime_orders o where o.signal_id=j.signal_id and o.intent='OPEN_LONG') orders
  from public.missed_opportunity_journal j
  left join lateral (select r.decision,r.record from public.gpt_final_entry_reviews r where r.signal_id=j.signal_id::text and r.purpose='PRODUCTION'
     and coalesce(r.record->>'kind','')<>'FD1_FINAL_RECHECK' and coalesce(r.record->'packet'->>'task','ENTRY')='ENTRY' order by r.created_at asc limit 1) e on true
  where j.candidate_at >= '2026-09-24 04:20:00+00'),
b as (select j.*, case
   when position_id is not null then 'FILLED'
   when entry_dec='BUY' and final_gpt_decision='SKIP' then 'BUY>RECHECK_SKIP'
   when entry_dec='BUY' and orders>0 then 'BUY>IOC_NO_FILL'
   when entry_dec='BUY' and orders=0 then 'BUY_ORPHAN('||coalesce(split_part(reject_reason,':',1),'NULL')||')'
   when entry_dec='ABSTAIN' then 'GPT_ABSTAIN' when entry_dec='SKIP' then 'GPT_SKIP'
   else 'PRE:'||coalesce(split_part(reject_reason,':',1),'NULL') end bucket from j)
select bucket, count(*) n, round(sum(450*reconstructed_net_30m/notional),1) s30, round(sum(450*reconstructed_net_usdt/notional),1) s60,
 round(sum(realized_net_usdt),2) realized
from b group by 1 order by 2 desc;

-- 2. Chase-point counterfactual with the DEAD/LIVE/UNCERTAIN split (5m-metric proxy of the live 1m classifier).
--    The stop is inferred only from lows provably after the chase segment (segment-boundary inference).
with c as (
 select j.symbol, j.candidate_at, j.reference_price ref, coalesce(nullif(j.target_notional_usdt,0),450) notional,
  coalesce(nullif(j.stop_pct,0),0.025) stop, (j.v17_result->>'lastClose')::numeric pc,
  (j.v17_result->>'pullbackObserved')::boolean pb, (j.v17_result->>'pullbackLow')::numeric pbl,
  ((j.v17_result->>'lastCandleOpenTime')::bigint + 60000 - (extract(epoch from j.candidate_at)*1000)::bigint)/60000.0 m,
  to_timestamp(((j.v17_result->>'lastCandleOpenTime')::bigint + 60000)/1000.0) tb,
  j.low_5m l5, j.low_15m l15, j.low_30m l30, j.low_60m l60, j.close_30m c30, j.close_60m c60,
  j.reconstructed_net_usdt jn60, j.candidate_at>='2026-09-24 04:20:00+00' fd1
 from public.missed_opportunity_journal j
 where j.reject_reason like 'V17_CHASE_EXPIRED%' and j.outcome_tracked_at is not null and j.close_60m is not null
   and j.v17_result->>'lastClose' is not null),
k as (select c.*, pc*(1-stop) s, case when pb then pbl else ref*0.9975 end pre_floor,
  case when m<=5 then l5 when m<=15 then l15 else l30 end seg_low from c),
e as (select k.*, (seg_low < pre_floor and seg_low <= s) or (m<=5 and l15<l5 and l15<=s) or (m<=15 and l30<l15 and l30<=s)
  or (l60<l30 and l60<=s) stop60 from k),
f as (select e.*, (v.metrics->>'qvRatio')::numeric qvr, (v.metrics->>'closeLocation')::numeric cloc,
   (v.metrics->>'takerBuyShare')::numeric tbs, (v.metrics->>'higherLowPreserved')::boolean hl, (v.metrics->>'ret60')::numeric r60, v.symbol vsym
 from e left join lateral (select v.* from public.v16_momentum_shadow_candidates v where v.symbol=e.symbol
   and v.signal_bar_at + interval '5 minutes' <= e.tb and v.signal_bar_at >= e.tb - interval '15 minutes'
   order by v.signal_bar_at desc, v.observed_at asc limit 1) v on true),
g as (select f.*, case when vsym is null then 'NO_DATA'
   when pc/ref-1 > 0.05 or qvr < 1 or cloc < 0.5 or tbs < 0.5 or hl is false or r60 <= 0 then 'DEAD'
   when cloc >= 0.7 then 'LIVE' else 'UNCERTAIN' end st,
  (case when stop60 then -notional*stop else notional*(c60/pc-1) end - notional*0.001)*450/notional n60,
  jn60*450/notional j60 from f)
select case when fd1 then 'FD1' else 'PRE' end period, st, count(*) n, round(sum(n60),1) sum60, round(avg(n60),2) avg60,
 round(sum(j60),1) journal60
from g group by rollup(1,2) order by 1,2;

-- 3. GPT BUY orphans (ENTRY BUY, no order, no recheck) with answer validity and trigger expiry.
select j.symbol, j.candidate_at, e.completed_at gpt_done, to_timestamp((e.record->>'valid_until_ms')::bigint/1000.0) valid_until,
 to_timestamp((e.record->>'expires_at_ms')::bigint/1000.0) expires, s.status, s.reject_reason,
 round(450*j.reconstructed_net_usdt/coalesce(nullif(j.target_notional_usdt,0),450),2) n60
from public.missed_opportunity_journal j join public.v11_long_regime_signals s on s.id=j.signal_id
join lateral (select r.decision,r.completed_at,r.record from public.gpt_final_entry_reviews r where r.signal_id=j.signal_id::text
  and r.purpose='PRODUCTION' and coalesce(r.record->>'kind','')<>'FD1_FINAL_RECHECK' and coalesce(r.record->'packet'->>'task','ENTRY')='ENTRY'
  order by r.created_at asc limit 1) e on e.decision='BUY'
where j.candidate_at>='2026-09-24 04:20:00+00' and j.position_id is null and j.final_gpt_decision is null
  and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=j.signal_id and o.intent='OPEN_LONG')
order by j.candidate_at;

-- 4. IOC attempts since 2026-09-18 (dispatched only).
select coalesce(nullif(o.request_payload->>'entry_ioc_attempt','')::int,1) attempt, count(*) n,
 count(*) filter (where o.state='FILLED') filled, round(100.0*count(*) filter (where o.state='FILLED')/count(*),1) fill_pct
from public.v11_long_regime_orders o
where o.intent='OPEN_LONG' and o.created_at>='2026-09-18' and coalesce(o.reject_reason,'') not like 'ORDER_NEVER_PLACED%'
  and coalesce(o.response_payload->>'notDispatched','')<>'true'
group by 1 order by 1;

-- 5. Stale NEW rows the lifecycle sweep retires on its first run.
select coalesce(s.features->'v17Setup'->>'state','(none)') setup_state, count(*) n
from public.v11_long_regime_signals s
where s.status='NEW' and s.reject_reason is null and s.lane='BULL' and s.revision='V11-LONG-REGIME-1.0.1'
  and s.features->>'strategy'='LEADER_MOMENTUM_V17' and s.entry_bar_at < now()-interval '20 minutes'
group by 1;

-- ===== Phase 2: dynamic multi-slot admission =====

-- 6. Same-trigger GPT BUY groups in the FD1 window: which BUYs were ordered/filled (the one-entry-per-run loss).
with e as (
  select distinct on (r.signal_id) r.signal_id, r.decision, s.symbol,
    to_timestamp((s.features->'v17Setup'->>'triggerAt')::bigint/1000.0) trig,
    exists(select 1 from public.v11_long_regime_orders o where o.signal_id=s.id and o.intent='OPEN_LONG') ordered,
    exists(select 1 from public.v11_long_regime_positions p where p.signal_id=s.id) filled
  from public.gpt_final_entry_reviews r join public.v11_long_regime_signals s on s.id::text=r.signal_id
  where r.purpose='PRODUCTION' and coalesce(r.record->>'kind','')<>'FD1_FINAL_RECHECK'
    and coalesce(r.record->'packet'->>'task','ENTRY')='ENTRY' and r.created_at>='2026-09-24 04:20'
  order by r.signal_id, r.created_at)
select trig, count(*) filter (where decision='BUY') buys, count(*) filter (where decision='BUY' and filled) filled,
  string_agg(symbol||':'||decision||case when filled then '(F)' when ordered then '(O)' else '' end, ' ' order by symbol) syms
from e group by trig having count(*) filter (where decision='BUY')>=2 order by trig;

-- 7. Free margin around those fills (account snapshots).
select captured_at, available_quote, jsonb_array_length(coalesce(positions,'[]'::jsonb)) positions
from public.trading_account_snapshots where exchange='binance_futures'
  and (captured_at between '2026-09-24 16:15:30+00' and '2026-09-24 16:18:30+00'
    or captured_at between '2026-09-24 17:15:30+00' and '2026-09-24 17:19:30+00')
order by captured_at;

-- 8. Per-attempt duration (BOO admission -> ENTRY_ATTEMPT_OUTCOME) behind ENTRY_ATTEMPT_RESERVE.
with o as (
  select d.decided_at out_at, d.details->>'signalId' sid, (d.details->>'orderDispatched')::boolean dispatched,
    (d.details->>'entered')::boolean entered
  from public.v11_long_regime_decisions d
  where d.decided_at >= '2026-09-18' and d.details->>'stage'='ENTRY_ATTEMPT_OUTCOME'),
s as (select o.*, (select min(b.created_at) from public.boo_entry_gate_decisions b where b.signal_id::text=o.sid
   and b.phase='ADMISSION' and b.created_at between o.out_at - interval '90 seconds' and o.out_at) adm from o)
select case when entered then 'ENTERED' when dispatched then 'DISPATCHED_NO_ENTRY' else 'NOT_DISPATCHED' end k, count(*) n,
  round(percentile_cont(0.5) within group (order by extract(epoch from out_at-adm))::numeric,2) p50,
  round(percentile_cont(0.99) within group (order by extract(epoch from out_at-adm))::numeric,2) p99,
  round(max(extract(epoch from out_at-adm))::numeric,2) mx
from s group by 1 order by 1;

-- 9. Concurrency actually reached since the pullback policy went live, and policy-cap refusals.
with p as (select id, entry_at, coalesce(closed_at, now()) closed_at, realized_pnl_usdt
  from public.v11_long_regime_positions where entry_at >= '2026-09-17')
select (select count(*) from p q where q.entry_at <= p.entry_at and q.closed_at > p.entry_at) concurrent_at_entry,
  count(*) n, round(sum(realized_pnl_usdt)::numeric,2) pnl
from p group by 1 order by 1;
select count(*) policy_slot_limit_rejections from public.v11_long_regime_signals where reject_reason like '%V17_SETUP_POLICY_SLOT_LIMIT%';

-- 10. How often more than 10 signals were live inside a 20-minute window (the queue's .limit(10) work bound).
with b as (select entry_bar_at, count(*) n from public.v11_long_regime_signals
  where revision='V11-LONG-REGIME-1.0.1' and lane='BULL' and features->>'strategy'='LEADER_MOMENTUM_V17'
    and entry_bar_at>='2026-09-18' group by 1),
w as (select b1.entry_bar_at, (select sum(b2.n) from b b2 where b2.entry_bar_at > b1.entry_bar_at - interval '20 minutes'
  and b2.entry_bar_at <= b1.entry_bar_at) live_window from b b1)
select count(*) filter (where live_window>10) windows_over_10, count(*) windows, max(live_window) max_live from w;

-- 11. GPT calls per day against the 300/day cap.
select date_trunc('day', created_at) d, count(*) n from public.gpt_final_entry_reviews
where purpose='PRODUCTION' and created_at >= '2026-09-20' group by 1 order by 1;
