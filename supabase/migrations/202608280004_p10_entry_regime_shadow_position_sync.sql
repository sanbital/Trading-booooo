-- Keep the shadow ledger linked after the P10 claim is attached to its position.
-- This remains telemetry-only and cannot affect claim/order admission.

create or replace function public.sync_p10_entry_regime_shadow_position()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.position_id is distinct from old.position_id then
    update public.p10_entry_regime_shadow
    set position_id = new.position_id
    where claim_id = new.id;
  end if;
  return new;
exception when others then
  raise warning 'P10 entry regime shadow position sync failed for claim %: %', new.id, sqlerrm;
  return new;
end;
$$;

revoke all on function public.sync_p10_entry_regime_shadow_position() from public;

drop trigger if exists trg_p10_entry_regime_shadow_position_sync on public.p10_signal_claims;
create trigger trg_p10_entry_regime_shadow_position_sync
after update of position_id on public.p10_signal_claims
for each row
when (new.position_id is distinct from old.position_id)
execute function public.sync_p10_entry_regime_shadow_position();

update public.p10_entry_regime_shadow s
set position_id = c.position_id
from public.p10_signal_claims c
where c.id = s.claim_id
  and s.position_id is distinct from c.position_id;
