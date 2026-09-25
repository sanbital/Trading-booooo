-- LE-SHADOW-1: keep v_compare / portfolio_1slot index-driven as the store grows (shadow_le only).
-- The outcome lookup used "decision_id = x OR (candidate_id = y AND decision_id IS NULL)", which
-- cannot use an index; it is now two indexed lookups. Output columns are unchanged.
create index if not exists outcomes_candidate_idx on shadow_le.outcomes (candidate_id);
create index if not exists decisions_candidate_idx on shadow_le.decisions (candidate_id);

create or replace view shadow_le.v_compare as
with arms as (
  select c.cycle_id, a.arm from shadow_le.cycles c cross join lateral jsonb_array_elements_text(c.arms_active) a(arm) where c.mode = 'SCAN'),
base as (
  select k.candidate_id, k.cycle_id, k.observed_at, k.kst_day, k.symbol, k.lane, k.rank_now, k.shortlisted, a.arm,
    case when not k.shortlisted then 'NOT_SHORTLISTED' else coalesce(f.final_decision, 'NONE') end alt_decision,
    f.decision_id alt_decision_id,
    l.link_stage, coalesce(l.prod_gpt_buy, false) or coalesce(l.prod_entered, false) current_buy, l.prod_realized_pnl_usdt
  from shadow_le.candidates k join arms a on a.cycle_id = k.cycle_id
  left join shadow_le.v_arm_final f on f.candidate_id = k.candidate_id and f.arm = a.arm
  left join lateral (select * from shadow_le.production_link l where l.candidate_id = k.candidate_id order by (l.link_stage = 'FINAL') desc limit 1) l on true)
select b.*,
  case when b.link_stage is null then '0_NOT_LINKED_YET'
       when b.current_buy and b.alt_decision = 'BUY' then '1_CURRENT_BUY_ALT_BUY'
       when b.current_buy then '2_CURRENT_BUY_ALT_SKIP_WAIT'
       when b.alt_decision = 'BUY' then '3_CURRENT_SKIP_OR_NOT_SEEN_ALT_BUY'
       when b.alt_decision = 'WAIT' then '4_CURRENT_SKIP_OR_NOT_SEEN_ALT_WAIT'
       else '5_BOTH_EXCLUDED' end as grp,
  o.entry_ref, o.hyp_entry_price, o.hyp_fwd_60m, o.hyp_fwd_120m, o.hyp_mfe_60, o.hyp_mae_60, o.hyp_mfe_240, o.hyp_mae_240,
  o.hyp_net_bps_real_60m, o.hyp_net_bps_real_120m, o.hyp_net_bps_stress44_60m, o.hyp_net_bps_stress44_120m,
  o.hyp_sim_net_bps_real, o.hyp_sim_net_bps_stress44, o.hyp_sim_exit_reason, o.data_complete
from base b
left join lateral (
  select x.* from (
    select o1.*, 0 as pri from shadow_le.outcomes o1 where o1.decision_id = b.alt_decision_id
    union all
    select o2.*, case when o2.entry_ref = 'ASK_AT_DECISION' then 1 else 2 end from shadow_le.outcomes o2
    where o2.candidate_id = b.candidate_id and o2.decision_id is null) x
  order by x.pri limit 1) o on true;

create or replace function shadow_le.portfolio_1slot(p_arm text, p_from timestamptz, p_to timestamptz default now())
returns table(decision_id bigint, symbol text, entry_at timestamptz, exit_at timestamptz, net_bps_real double precision,
  net_bps_stress44 double precision, taken boolean)
language plpgsql stable set search_path = '' as $$
declare r record; busy_until timestamptz := '-infinity';
begin
  for r in
    select f.decision_id, d.symbol, o.hyp_entry_at, o.hyp_entry_at + make_interval(secs => coalesce(o.hyp_sim_hold_min, 240) * 60) ex,
      o.hyp_sim_net_bps_real, o.hyp_sim_net_bps_stress44
    from shadow_le.v_arm_final f join shadow_le.decisions d on d.decision_id = f.decision_id
    join lateral (select x.* from (
        select o1.*, 0 as pri from shadow_le.outcomes o1 where o1.decision_id = f.decision_id
        union all
        select o2.*, 1 from shadow_le.outcomes o2 where o2.candidate_id = f.candidate_id and o2.decision_id is null and o2.entry_ref = 'ASK_AT_DECISION') x
      order by x.pri limit 1) o on true
    where f.arm = p_arm and f.final_decision = 'BUY' and o.hyp_entry_at between p_from and p_to and o.hyp_sim_net_bps_real is not null
    order by o.hyp_entry_at
  loop
    decision_id := r.decision_id; symbol := r.symbol; entry_at := r.hyp_entry_at; exit_at := r.ex;
    net_bps_real := r.hyp_sim_net_bps_real; net_bps_stress44 := r.hyp_sim_net_bps_stress44;
    taken := r.hyp_entry_at >= busy_until;
    if taken then busy_until := r.ex; end if;
    return next;
  end loop;
end $$;
revoke all on function shadow_le.portfolio_1slot(text, timestamptz, timestamptz) from public;
