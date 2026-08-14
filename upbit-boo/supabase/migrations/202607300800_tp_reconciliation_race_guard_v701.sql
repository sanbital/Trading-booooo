-- v7.0.1 TP RECONCILIATION RACE GUARD
--
-- Evidence: while an 80% resting TARGET_1 fill was being synchronized, account reconciliation
-- interpreted the temporary balance drop as a manual position reduction. It reduced cost basis
-- to the 20% residual, then applied the 80% target fill against that reduced basis, creating a
-- phantom profit and closing the position while the residual asset remained in the account.
--
-- Immediate reversible mitigation:
--   1) disable resting TP; the 2-second monitor remains responsible for exits;
--   2) resume global entries because no -30% daily circuit is active;
--   3) quarantine only assets affected by this race;
--   4) exclude any existing contaminated outcome rows from realized-edge learning.
-- No entry EV, direction, spread or reward/risk threshold is relaxed.

alter table public.trading_settings
  add column if not exists tp_reconciliation_guard_enabled boolean not null default false,
  add column if not exists tp_reconciliation_guard_activated_at timestamptz,
  add column if not exists tp_reconciliation_guard_reason text;

update public.trading_settings
   set scalp_resting_tp=false,
       pause_new_entries=false,
       tp_reconciliation_guard_enabled=true,
       tp_reconciliation_guard_activated_at=now(),
       tp_reconciliation_guard_reason='RESTING_TP_FILL_MISCLASSIFIED_AS_MANUAL_REDUCTION',
       lob_model_revision='7.0.1-TP-RECONCILIATION-SAFETY',
       lob_live_admission_revision='7.0.1-TP-RECONCILIATION-SAFETY',
       version=version+1,
       updated_at=now()
 where id=1
   and scalp_daily_loss_pct=30
   and scalp_kill_switch=false
   and emergency_liquidation=false;

with affected as (
  select distinct p.id,p.exchange,p.base_asset,p.market,p.closed_at
  from public.trading_positions p
  join public.trading_events e on e.position_id=p.id and e.code='MANUAL_POSITION_REDUCTION'
  join public.trading_orders o on o.position_id=p.id and o.purpose='TARGET_1' and o.executed_volume>0
  where p.is_paper=false and p.closed_at>=now()-interval '24 hours'
)
update public.trading_positions p
   set metadata=coalesce(p.metadata,'{}'::jsonb)||jsonb_build_object(
         'accounting_quarantine',jsonb_build_object(
           'revision','7.0.1-TP-RECONCILIATION-SAFETY',
           'reason','RESTING_TP_FILL_MANUAL_REDUCTION_RACE',
           'exclude_from_learning',true,
           'quarantined_at',now()
         )
       ),updated_at=now()
  from affected a where p.id=a.id;

with affected as (
  select distinct p.id
  from public.trading_positions p
  join public.trading_events e on e.position_id=p.id and e.code='MANUAL_POSITION_REDUCTION'
  join public.trading_orders o on o.position_id=p.id and o.purpose='TARGET_1' and o.executed_volume>0
  where p.is_paper=false and p.closed_at>=now()-interval '24 hours'
)
update public.lob_online_outcomes o
   set accounting_quality='TP_RECONCILIATION_RACE_INVALID',
       entry_snapshot=coalesce(o.entry_snapshot,'{}'::jsonb)||jsonb_build_object(
         'accounting_quarantine',jsonb_build_object(
           'revision','7.0.1-TP-RECONCILIATION-SAFETY',
           'exclude_from_learning',true,
           'quarantined_at',now()
         )
       )
  from affected a where o.position_id=a.id;

with affected as (
  select distinct p.exchange,p.base_asset,p.market,p.id
  from public.trading_positions p
  join public.trading_events e on e.position_id=p.id and e.code='MANUAL_POSITION_REDUCTION'
  join public.trading_orders o on o.position_id=p.id and o.purpose='TARGET_1' and o.executed_volume>0
  where p.is_paper=false and p.closed_at>=now()-interval '24 hours'
)
select public.record_asset_lock_check_v610(
  exchange,base_asset,'MISMATCH','UNTRACKED_RESIDUAL_AFTER_TP_RECONCILIATION_RACE',
  jsonb_build_object('position_id',id,'market',market,'revision','7.0.1-TP-RECONCILIATION-SAFETY')
) from affected;

do $$
declare cfg public.trading_settings%rowtype; q integer; l integer;
begin
  select * into cfg from public.trading_settings where id=1;
  if cfg.scalp_resting_tp then raise exception 'V701_RESTING_TP_NOT_DISABLED'; end if;
  if cfg.pause_new_entries then raise exception 'V701_GLOBAL_ENTRIES_STILL_PAUSED'; end if;
  if cfg.scalp_daily_loss_pct<>30 then raise exception 'V701_DAILY_CIRCUIT_CHANGED'; end if;
  if cfg.min_order_krw<40000 then raise exception 'V701_UPBIT_MINIMUM_REDUCED'; end if;
  select count(*) into q from public.trading_positions
   where metadata#>>'{accounting_quarantine,revision}'='7.0.1-TP-RECONCILIATION-SAFETY';
  select count(*) into l from public.trading_asset_locks
   where reason='UNTRACKED_RESIDUAL_AFTER_TP_RECONCILIATION_RACE' and state='LOCKED';
  if q=0 then raise exception 'V701_AFFECTED_POSITIONS_NOT_QUARANTINED'; end if;
  if l=0 then raise exception 'V701_RESIDUAL_ASSETS_NOT_LOCKED'; end if;
end $$;
