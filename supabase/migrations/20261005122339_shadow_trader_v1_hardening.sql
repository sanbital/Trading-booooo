-- Keep the candidate row aligned with the exact executable micro snapshot that
-- caused a virtual entry. This is audit-only and cannot create an exchange order.
create function public.shadow_candidate_entry_audit_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare s public.shadow_trade_snapshots%rowtype;
begin
  if new.decision='BUY' and old.decision is distinct from 'BUY' then
    select * into s
    from public.shadow_trade_snapshots
    where candidate_id=new.id and snapshot_type='ENTRY_DECISION'
    order by captured_at desc,id desc
    limit 1;
    new.rejection_reasons='{}'::text[];
    if found then
      new.microstructure=s.microstructure;
      new.best_bid=s.best_bid;
      new.best_ask=s.best_ask;
      new.spread_bps=s.spread_bps;
      new.bid_depth=s.bid_depth;
      new.ask_depth=s.ask_depth;
      new.book_imbalance=s.book_imbalance;
      new.estimated_slippage_bps=s.estimated_slippage_bps;
    end if;
  end if;
  return new;
end
$$;

create trigger shadow_candidate_entry_audit_trigger
before update of decision,stage on public.shadow_trade_candidates
for each row execute function public.shadow_candidate_entry_audit_v1();

with latest as (
  select distinct on (candidate_id) candidate_id,microstructure,best_bid,best_ask,spread_bps,
    bid_depth,ask_depth,book_imbalance,estimated_slippage_bps
  from public.shadow_trade_snapshots
  where snapshot_type='ENTRY_DECISION'
  order by candidate_id,captured_at desc,id desc
)
update public.shadow_trade_candidates c set
  rejection_reasons='{}'::text[],microstructure=l.microstructure,best_bid=l.best_bid,best_ask=l.best_ask,
  spread_bps=l.spread_bps,bid_depth=l.bid_depth,ask_depth=l.ask_depth,
  book_imbalance=l.book_imbalance,estimated_slippage_bps=l.estimated_slippage_bps,
  updated_at=clock_timestamp()
from latest l
where c.id=l.candidate_id and c.decision='BUY';

revoke all on function public.shadow_candidate_entry_audit_v1() from public,anon,authenticated;
grant execute on function public.shadow_candidate_entry_audit_v1() to service_role;

comment on function public.shadow_candidate_entry_audit_v1 is
  'Audit synchronization for virtual Shadow entries only; no exchange capability.';
