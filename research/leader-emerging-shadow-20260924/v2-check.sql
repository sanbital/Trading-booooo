-- LE-SHADOW-2 monitoring (read only). Run as an owner/analyst role.

-- 1. key present? control flags, budgets
select enabled, gpt_enabled, v2_discovery_gpt, v2_parity_enabled, updated_at from shadow_le.control;
select * from shadow_le.v2_api_usage order by utc_day desc limit 3;

-- 2. run health: V2 cycles and Binance status today
select mode, status, count(*), max(request_weight) max_w, max(used_weight_max) max_used, string_agg(distinct binance_status, ',')
from shadow_le.cycles where started_at > now() - interval '24 hours' group by 1, 2 order by 1, 2;

-- 3. events per lane and ALT gate state
select lane, count(*) events, count(*) filter (where micro_complete) micro_ok,
  avg(snapshot_offset_ms)::int avg_offset_ms, count(distinct symbol) symbols
from shadow_le.v2_events where snapshot_at > now() - interval '24 hours' group by 1;
select lane, decision_source, decision, coalesce(gate, error) gate_or_error, count(*)
from shadow_le.v2_decisions where created_at > now() - interval '24 hours' group by 1, 2, 3, 4 order by 1, 2, 3;

-- 4. WAIT lifecycle
select w.event, d.recheck_trigger->>'trigger' trig, count(*) from shadow_le.v2_wait_events w join shadow_le.v2_decisions d using (decision_id) group by 1, 2;

-- 5. comparison groups (60 and 120 minutes)
select * from shadow_le.v2_group_stats(now() - interval '30 days', now(), 60);
select * from shadow_le.v2_group_stats(now() - interval '30 days', now(), 120);

-- 6. overheat level vs outcome (report only)
select c.lane, e.axes->'overheat'->>'level' overheat, count(*), round(avg(c.net_bps_60m)::numeric, 1) net60
from shadow_le.v2_compare c join shadow_le.v2_events e using (event_id) group by 1, 2 order by 1, 2;
