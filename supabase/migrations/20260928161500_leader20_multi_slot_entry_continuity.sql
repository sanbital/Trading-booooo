-- Multi-slot entry capacity, entry-capture continuity and independent position capture.
--
-- INCIDENT (2026-09-28 00:50 KST)
-- ------------------------------
-- One OPEN position (HBARUSDT) and one affordable slot, yet the 00:50 entry capture
-- produced ready=0 / blocked=20 / retry=13 and expired as DECISION_WINDOW_INSUFFICIENT.
-- The capture archive for that slot held only BTCUSDT (market sensor) and HBARUSDT
-- (open position): the twenty Top20 candidate streams were never collected.
--
-- Two production defects combined:
--
--  1. leader20_batch_capacity() returned available=0 whenever ANY order was unresolved
--     ("case when pending>0 then 0"), although the same function had already reserved a
--     full slot cost AND a slot for each of them. One entry going PLANNED therefore
--     closed the whole account: entry capture, paid review admission (ai_call_reserve),
--     batch claim/finish and materialization all read zero slots, and
--     leader20_batch_note_full()/leader20_batch_slot_wake() retired every in-flight
--     review event. A filled position ended the batch instead of consuming one slot.
--
--  2. doa_capture_rpc() used leader20_control.entry_capture_slot_ms as a single-shot
--     latch: it was only ever armed inside [T-180s, T-120s), and ANY zero-capacity read
--     cleared it -- including a read that was merely uncertain (a stale or unreadable
--     account snapshot). Once cleared it could not be re-armed for the same clock slot,
--     so the watch RPC dropped all twenty candidates for the rest of the window and the
--     collector tore their sockets down.
--
-- WHAT THIS MIGRATION CHANGES
-- ---------------------------
--  * Unresolved entry orders and live slot reservations CONSUME slots and margin; they
--    no longer zero the account. available_slots means "how many more positions may be
--    opened", never "stop scanning".
--  * entry_capture_slot_ms becomes derived, re-armable state: arming is allowed at any
--    point in the preparation window while a complete 120s/24-bucket path is still
--    reachable (up to T-120s-arm_lead), and an uncertain account read preserves an armed
--    slot instead of destroying it (CAPACITY_UNCERTAIN). Only a confirmed zero disarms.
--  * The BTCUSDT market sensor stays watched whenever anything is held, so entry capacity
--    can never degrade open-position evidence.
--  * An atomic, self-expiring slot reservation (leader20_entry_reservations) admits at
--    most available_for_new_entry concurrent BUY candidates; the rest get NO_ENTRY_CAPACITY.
--  * Per-slot observation columns and a read-only report view.
--
-- Sizing authority is UNCHANGED: MAX_SLOTS=10, one slot's worst-case margin draw
-- 152.021375 USDT, account cash buffer 0.10 USDT, leverage, the 10-minute clock and the
-- 120s/24-bucket capture contract are all read from the existing production values.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- ---------------------------------------------------------------------------
-- 1. The existing sizing authority, in one place. Values are unchanged.
-- ---------------------------------------------------------------------------
-- 152.021375 = maxOrderMarginUsdt 151.25 x (1 + leverage 3 x (taker 0.0005 + iocMax 0.0012)),
-- i.e. entry-capacity.mjs slotCostUsdt() at the current production sizing contract.
-- 0.10 = ENTRY_CASH_BUFFER_USDT, held once for the account. 10 = MAX_SLOTS.
create or replace function public.leader20_entry_slot_policy() returns jsonb
 language sql immutable set search_path='' as $$
 select jsonb_build_object('version','ENTRY_SLOT_POLICY_1','max_slots',10,
  'target_margin_per_slot',152.021375::numeric,'cash_buffer',0.10::numeric);
$$;

-- ---------------------------------------------------------------------------
-- 2. Atomic entry-slot reservations
-- ---------------------------------------------------------------------------
create table public.leader20_entry_reservations(
 id uuid primary key default gen_random_uuid(),
 symbol text not null check(symbol=upper(btrim(symbol)) and symbol<>''),
 slot_ms bigint,
 signal_id uuid,
 state text not null default 'RESERVED'
  check(state in ('RESERVED','ORDER_PENDING','FILLED','RELEASED','EXPIRED')),
 reserved_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 settled_at timestamptz,
 reason text,
 updated_at timestamptz not null default clock_timestamp(),
 check(expires_at>reserved_at)
);
-- One live reservation per symbol: one symbol = one open position (no pyramiding yet).
create unique index leader20_entry_reservation_live_symbol
 on public.leader20_entry_reservations(symbol) where state in ('RESERVED','ORDER_PENDING');
create index leader20_entry_reservation_live
 on public.leader20_entry_reservations(expires_at) where state in ('RESERVED','ORDER_PENDING');
create index leader20_entry_reservation_slot on public.leader20_entry_reservations(slot_ms);
alter table public.leader20_entry_reservations enable row level security;
revoke all on public.leader20_entry_reservations from public,anon,authenticated;
grant select on public.leader20_entry_reservations to service_role;

-- A reservation is LIVE while its state is RESERVED or ORDER_PENDING and its own deadline has
-- not passed. Capacity reads that predicate WITHOUT writing, so a lost settlement can never
-- block the account past that deadline, and capacity stays callable from a read-only session.
-- Record the reservation lifecycle from the order/signal journal. Idempotent, and never
-- required for correctness: expiry alone already releases capacity.
create or replace function public.leader20_entry_reservation_sweep() returns jsonb
 language plpgsql set search_path='' as $$
declare settled integer:=0;released integer:=0;expired integer:=0;
begin
 with o as (
  select r.id,
   bool_or(x.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and x.response_payload->>'v18ExposureFinal' is distinct from 'true') live,
   bool_or(x.state='FILLED') filled,
   bool_and(x.state in ('REJECTED','CANCELLED','EXPIRED')) dead
  from public.leader20_entry_reservations r
  join public.v11_long_regime_orders x on x.signal_id=r.signal_id and x.intent='OPEN_LONG'
  where r.state in ('RESERVED','ORDER_PENDING') and r.signal_id is not null
  group by r.id
 )
 -- An order state this function does not recognise leaves the reservation alone: it then
 -- falls away at its own deadline rather than freeing a slot on an unknown outcome.
 update public.leader20_entry_reservations r
  set state=case when o.filled then 'FILLED' when o.live then 'ORDER_PENDING' else 'RELEASED' end,
   reason=case when o.filled then 'ORDER_FILLED' when o.live then 'ORDER_DISPATCHED' else 'ORDER_NOT_FILLED' end,
   settled_at=case when o.live then r.settled_at else clock_timestamp() end,updated_at=clock_timestamp()
  from o where o.id=r.id and (o.filled or o.live or o.dead)
   and r.state is distinct from case when o.filled then 'FILLED' when o.live then 'ORDER_PENDING' else 'RELEASED' end;
 get diagnostics settled=row_count;
 -- A candidate the executor refused outright frees its slot at once.
 update public.leader20_entry_reservations r set state='RELEASED',reason='SIGNAL_REJECTED',
  settled_at=clock_timestamp(),updated_at=clock_timestamp()
 where r.state='RESERVED' and r.signal_id is not null
  and exists(select 1 from public.v11_long_regime_signals s where s.id=r.signal_id and s.status in ('REJECTED','CLOSED'))
  and not exists(select 1 from public.v11_long_regime_orders x where x.signal_id=r.signal_id and x.intent='OPEN_LONG');
 get diagnostics released=row_count;
 update public.leader20_entry_reservations set state='EXPIRED',reason=coalesce(reason,'WINDOW_EXPIRED'),
  settled_at=clock_timestamp(),updated_at=clock_timestamp()
 where state in ('RESERVED','ORDER_PENDING') and expires_at<=clock_timestamp();
 get diagnostics expired=row_count;
 return jsonb_build_object('settled',settled,'released',released,'expired',expired);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Canonical Binance-futures capacity
-- ---------------------------------------------------------------------------
-- Two bounds, deliberately distinct:
--
--   available                -- how many more slots the ACCOUNT can fund right now, counting
--                               open positions and unresolved entry orders. This is the
--                               capture / paid-review / batch admission bound. Soft
--                               reservations are NOT subtracted here: a candidate must be
--                               able to pay for its own FINAL RECHECK, and tearing the
--                               capture down mid-window cannot be undone.
--   available_for_new_entry  -- min(available_by_margin, max_slots - open - reservations):
--                               the ORDER admission bound, and the number of additional
--                               positions that may still be opened (requirement: a fill
--                               decrements it, it never closes the entry system).
--
-- Only missing/stale/unreadable account evidence is UNCERTAIN (certain=false): callers may
-- keep an already-armed capture alive across it, but no order may ever be admitted on it.
create or replace function public.leader20_batch_capacity() returns jsonb language plpgsql set search_path='' as $$
declare s public.trading_account_snapshots%rowtype;
 pol jsonb:=public.leader20_entry_slot_policy();
 max_slots integer:=(pol->>'max_slots')::integer;
 cost numeric:=(pol->>'target_margin_per_slot')::numeric;
 buffer numeric:=(pol->>'cash_buffer')::numeric;
 db_open text[]; live_open text[]; committed text[]; held text[]; open_count integer;
 exposure_pending integer; pending_entries integer; reserved integer;
 free numeric; by_margin integer; slots integer; for_new integer; reason text;
begin
 select coalesce(array_agg(distinct symbol),'{}') into db_open from public.v11_long_regime_positions
  where state='OPEN' or remaining_quantity>0.0000000001 or metadata->>'exitAccountingPending'='true';
 -- Unresolved entry orders hold a whole slot and a whole slot cost until their outcome is final.
 select count(*) into pending_entries from public.v11_long_regime_orders
  where intent='OPEN_LONG' and state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
   and response_payload->>'v18ExposureFinal' is distinct from 'true';
 select count(*) into exposure_pending from public.v11_long_regime_orders
  where state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
   and response_payload->>'v18ExposureFinal' is distinct from 'true';
 -- Live reservations that no unresolved order already accounts for, on symbols not held.
 select count(*) into reserved from public.leader20_entry_reservations r
  where r.state in ('RESERVED','ORDER_PENDING') and r.expires_at>clock_timestamp()
   and not (r.symbol=any(db_open))
   and not exists(select 1 from public.v11_long_regime_orders x where x.signal_id=r.signal_id
    and x.intent='OPEN_LONG' and x.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and x.response_payload->>'v18ExposureFinal' is distinct from 'true');
 -- Symbols that hold, or may yet hold, exposure. Always reported, even when the exchange
 -- snapshot is unusable, so capture routing and duplicate-symbol refusal keep working.
 select coalesce(array_agg(distinct symbol),'{}') into committed from (
  select unnest(db_open) symbol
  union select upper(btrim(o.symbol)) from public.v11_long_regime_orders o
   where o.intent='OPEN_LONG' and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and o.response_payload->>'v18ExposureFinal' is distinct from 'true' and nullif(btrim(o.symbol),'') is not null
  union select r.symbol from public.leader20_entry_reservations r
   where r.state in ('RESERVED','ORDER_PENDING') and r.expires_at>clock_timestamp()
 ) x;
 select * into s from public.trading_account_snapshots where exchange='binance_futures' order by captured_at desc limit 1;
 if not found or s.positions_complete is distinct from true or s.captured_at<clock_timestamp()-interval '90 seconds'
  or s.captured_at>clock_timestamp() then
  return jsonb_build_object('available',0,'available_for_new_entry',0,'certain',false,
   'reason','ACCOUNT_SNAPSHOT_STALE_OR_INCOMPLETE','held',to_jsonb(committed),'open_positions',coalesce(array_length(db_open,1),0),
   'reserved_slots',reserved,'pending_entry_orders',pending_entries,'pending_orders',exposure_pending,
   'max_slots',max_slots,'target_margin_per_slot',cost,'cash_buffer',buffer,'snapshot_at',s.captured_at);
 end if;
 if s.available_quote is null or s.available_quote::text in ('NaN','Infinity','-Infinity')
  or jsonb_typeof(s.positions) is distinct from 'array'
  or exists(select 1 from jsonb_array_elements(s.positions) p where coalesce(p->>'symbol',p->>'market') is null
   or coalesce(p->>'quantity',p->>'positionAmt',p->>'position_amount') is null) then
  return jsonb_build_object('available',0,'available_for_new_entry',0,'certain',false,
   'reason','ACCOUNT_SNAPSHOT_UNREADABLE','held',to_jsonb(committed),'open_positions',coalesce(array_length(db_open,1),0),
   'reserved_slots',reserved,'pending_entry_orders',pending_entries,'pending_orders',exposure_pending,
   'max_slots',max_slots,'target_margin_per_slot',cost,'cash_buffer',buffer,'snapshot_at',s.captured_at);
 end if;
 select coalesce(array_agg(distinct upper(coalesce(p->>'symbol',p->>'market'))),'{}') into live_open
  from jsonb_array_elements(coalesce(s.positions,'[]')) p
  where abs(coalesce((p->>'quantity')::numeric,(p->>'positionAmt')::numeric,(p->>'position_amount')::numeric,0))>0;
 select coalesce(array_agg(distinct symbol),'{}') into held
  from (select unnest(committed) symbol union select unnest(live_open)) x;
 select count(*) into open_count from (select unnest(db_open) symbol union select unnest(live_open)) x;
 free:=greatest(0,s.available_quote-pending_entries*cost);
 by_margin:=greatest(0,floor((free-buffer)/cost)::integer);
 slots:=greatest(0,least(max_slots-open_count-pending_entries,by_margin));
 for_new:=greatest(0,least(max_slots-open_count-pending_entries-reserved,
  greatest(0,floor((greatest(0,s.available_quote-(pending_entries+reserved)*cost)-buffer)/cost)::integer)));
 -- `reason` keeps exactly the strings the deployed bundles and SQL compare against
 -- ('NO_ENTRY_CAPACITY', 'ACCOUNT_SNAPSHOT_*', null when funded). The finer cause travels
 -- separately so no downstream comparison changes behaviour.
 reason:=case when slots>0 then null else 'NO_ENTRY_CAPACITY' end;
 return jsonb_build_object('available',slots,'available_for_new_entry',for_new,'certain',true,
  'capacity_detail',case when slots>0 then case when for_new<1 then 'ENTRY_SLOTS_RESERVED' else 'ENTRY_CAPACITY_AVAILABLE' end
   when max_slots-open_count-pending_entries<1 then 'MAX_SLOTS_REACHED'
   when pending_entries>0 and greatest(0,floor((s.available_quote-buffer)/cost)::integer)>0 then 'PENDING_CAPITAL_RESERVED'
   else 'INSUFFICIENT_MARGIN' end,
  'available_by_margin',by_margin,'held',to_jsonb(held),'open_positions',open_count,
  'reserved_slots',reserved,'pending_entry_orders',pending_entries,'pending_orders',exposure_pending,
  'max_slots',max_slots,'target_margin_per_slot',cost,'cash_buffer',buffer,
  'available_quote',free,'futures_available_margin',s.available_quote,'snapshot_at',s.captured_at,
  'open_symbols',(select coalesce(jsonb_agg(symbol order by symbol),'[]'::jsonb)
   from (select unnest(db_open) symbol union select unnest(live_open)) x),
  'reason',reason);
end $$;

-- Atomically take one entry slot. Concurrent BUY candidates serialize on the existing
-- account-capacity lock, so exactly available_for_new_entry of them can succeed; the rest
-- are refused NO_ENTRY_CAPACITY without ever reaching an order.
create or replace function public.leader20_reserve_entry_slot(p_symbol text,p_slot_ms bigint,
 p_signal_id uuid,p_expires_at timestamptz) returns jsonb language plpgsql set search_path='' as $$
declare sym text:=upper(btrim(coalesce(p_symbol,'')));cap jsonb;r public.leader20_entry_reservations%rowtype;
 deadline timestamptz:=coalesce(p_expires_at,clock_timestamp()+interval '120 seconds');
begin
 if sym !~ '^[[:alnum:]]{1,24}USDT$' then return jsonb_build_object('reserved',false,'reason','INVALID_SYMBOL');end if;
 perform pg_advisory_xact_lock(20260928,52);
 perform public.leader20_entry_reservation_sweep();
 if deadline<=clock_timestamp() then return jsonb_build_object('reserved',false,'reason','RESERVATION_WINDOW_EXPIRED');end if;
 cap:=public.leader20_batch_capacity();
 if coalesce(cap->>'certain','false')<>'true' then
  return jsonb_build_object('reserved',false,'reason',coalesce(cap->>'reason','CAPACITY_UNCERTAIN'),'capacity',cap);end if;
 -- one symbol = one open position
 if cap->'held' ? sym then return jsonb_build_object('reserved',false,'reason','SYMBOL_ALREADY_HELD','capacity',cap);end if;
 if coalesce((cap->>'available_for_new_entry')::integer,0)<1 then
  return jsonb_build_object('reserved',false,'reason','NO_ENTRY_CAPACITY','capacity',cap);end if;
 insert into public.leader20_entry_reservations(symbol,slot_ms,signal_id,expires_at)
 values(sym,p_slot_ms,p_signal_id,deadline) returning * into r;
 -- The slot's observation row records the remaining-slot transition where it happens.
 if p_slot_ms is not null and p_slot_ms%600000=0 then
  perform public.leader20_clock_note(to_timestamp(p_slot_ms::numeric/1000),jsonb_build_object(
   'available_slots_before',(cap->>'available_for_new_entry')::integer,
   'available_slots_after',greatest(0,(cap->>'available_for_new_entry')::integer-1),
   'reserved_slots',coalesce((cap->>'reserved_slots')::integer,0)+1,
   'open_position_count',(cap->>'open_positions')::integer,
   'futures_available_margin',(cap->>'futures_available_margin')::numeric,
   'target_margin_per_slot',(cap->>'target_margin_per_slot')::numeric));
 end if;
 return jsonb_build_object('reserved',true,'id',r.id,'symbol',sym,'expires_at',r.expires_at,
  'available_for_new_entry_before',(cap->>'available_for_new_entry')::integer,
  'available_for_new_entry_after',greatest(0,(cap->>'available_for_new_entry')::integer-1),'capacity',cap);
end $$;

create or replace function public.leader20_bind_entry_reservation(p_id uuid,p_signal_id uuid) returns jsonb
 language plpgsql set search_path='' as $$
declare r public.leader20_entry_reservations%rowtype;
begin
 update public.leader20_entry_reservations set signal_id=p_signal_id,updated_at=clock_timestamp()
  where id=p_id and state in ('RESERVED','ORDER_PENDING') returning * into r;
 return jsonb_build_object('bound',r.id is not null,'state',r.state);
end $$;

create or replace function public.leader20_settle_entry_reservation(p_id uuid,p_state text,p_reason text default null)
 returns jsonb language plpgsql set search_path='' as $$
declare r public.leader20_entry_reservations%rowtype;
begin
 if p_state not in ('ORDER_PENDING','FILLED','RELEASED','EXPIRED') then raise exception 'RESERVATION_STATE_INVALID';end if;
 update public.leader20_entry_reservations set state=p_state,reason=coalesce(p_reason,reason),
  settled_at=case when p_state='ORDER_PENDING' then settled_at else clock_timestamp() end,updated_at=clock_timestamp()
 where id=p_id and state in ('RESERVED','ORDER_PENDING') returning * into r;
 return jsonb_build_object('settled',r.id is not null,'state',coalesce(r.state,p_state));
end $$;

revoke all on function public.leader20_entry_slot_policy(),
 public.leader20_entry_reservation_sweep(),public.leader20_batch_capacity(),
 public.leader20_reserve_entry_slot(text,bigint,uuid,timestamptz),
 public.leader20_bind_entry_reservation(uuid,uuid),
 public.leader20_settle_entry_reservation(uuid,text,text) from public,anon,authenticated;
grant execute on function public.leader20_entry_slot_policy(),
 public.leader20_entry_reservation_sweep(),public.leader20_batch_capacity(),
 public.leader20_reserve_entry_slot(text,bigint,uuid,timestamptz),
 public.leader20_bind_entry_reservation(uuid,uuid),
 public.leader20_settle_entry_reservation(uuid,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Re-armable entry capture (replaces the single-shot latch)
-- ---------------------------------------------------------------------------
alter table public.leader20_control add column entry_capture_arm_lead_ms integer not null default 25000
 check(entry_capture_arm_lead_ms>=0 and entry_capture_arm_lead_ms<=60000);
comment on column public.leader20_control.entry_capture_arm_lead_ms is
 'Transport lead required before T-120s for a candidate stream to produce all 24 buckets. 25000 = the collector''s 15s control-poll period (worst case) plus 10s to open both sockets and take twenty depth snapshots; completeCaptureInterval() requires started<=T-120s and book.syncAt<=T-120s. Arming later in the same slot cannot complete the path, so the slot is deferred to the next window. Tune from observed capture_finalize_latency_ms / capture_blocked_count, never below the control-poll period.';
comment on column public.leader20_control.entry_capture_slot_ms is
 'Derived, re-armable admission: the clock slot whose 120s entry path is currently armed. Re-armed on any funded watch up to T-120s-entry_capture_arm_lead_ms; disarmed only by a CONFIRMED zero-capacity read, never by an uncertain account snapshot.';

create or replace function public.doa_capture_rpc(p_action text,p_body jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;c public.leader20_control%rowtype;capacity jsonb;
 slot_ms bigint;epoch_slot_ms bigint;at_ms bigint;arm_deadline bigint;
 funded boolean;certain boolean;holding boolean;in_path boolean;armed boolean;
 can_arm boolean;entry_allowed boolean;reason text;
begin
 r:=public.doa_capture_rpc_before_clock(p_action,p_body);
 if p_action<>'watch' or r->>'enabled' is distinct from 'true' or r->>'reason'='LEASE_BUSY' then return r;end if;
 select * into c from public.leader20_control where singleton for update;
 if not c.clock_capture_enabled then return r;end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000);
 select (snapshot->>'capture_slot_ms')::bigint into epoch_slot_ms from public.leader20_epochs where id=c.epoch_id;
 -- The entry slot is a property of the CLOCK, not of when the Top20 epoch happens to publish.
 -- Reading it from the epoch snapshot was the primary defect behind the lost 00:50 / 01:00 /
 -- 01:20 KST slots on 2026-09-29: those three epochs published at T-130s instead of T-165s, so
 -- for the whole preparation window this RPC still reported the PREVIOUS, already-closed slot.
 -- captureDisposition() then had connect=false for every candidate (that slot's window had long
 -- since ended), the collector closed all twenty streams, and by the time the epoch landed the
 -- arming window had closed too -- leaving BTCUSDT alone in the archive with ready=0/blocked=20.
 -- This is the same slot the shared clock module derives (preparationSlot / slotFloor(at+180s)).
 slot_ms:=floor((at_ms+180000)/600000)*600000;
 capacity:=public.leader20_batch_capacity();
 funded:=coalesce((capacity->>'available')::integer,0)>0;
 certain:=coalesce(capacity->>'certain','false')='true';
 -- Held symbols keep their own continuous capture AND the BTC market sensor their
 -- HOLD/EXIT evidence cites, whatever entry capacity says.
 holding:=exists(select 1 from jsonb_array_elements(coalesce(r->'watch','[]')) x where x->'roles' ? 'OPEN_POSITION');
 in_path:=slot_ms is not null and at_ms>=slot_ms-180000 and at_ms<slot_ms+1000;
 arm_deadline:=slot_ms-120000-c.entry_capture_arm_lead_ms;
 can_arm:=in_path and at_ms<=arm_deadline;
 if certain and not funded then
  -- Confirmed loss of entry capital. A half path is never started or continued.
  if c.entry_capture_slot_ms is not null then
   update public.leader20_control set entry_capture_slot_ms=null where singleton;
   c.entry_capture_slot_ms:=null;
  end if;
 elsif funded and coalesce(can_arm,false) and c.entry_capture_slot_ms is distinct from slot_ms then
  -- Arm or RE-ARM: capacity 1 -> 0 -> 1 inside the preparation window recovers this slot.
  update public.leader20_control set entry_capture_slot_ms=slot_ms where singleton;
  c.entry_capture_slot_ms:=slot_ms;
 end if;
 -- Three-valued logic: an unset latch is NOT armed, never unknown.
 armed:=coalesce(slot_ms is not null and c.entry_capture_slot_ms=slot_ms,false);
 -- Uncertainty preserves an armed path; it can never create one, and never admits an order.
 entry_allowed:=coalesce((funded or not certain) and armed and in_path,false);
 reason:=case
  when entry_allowed then 'CAPTURE_WINDOW'
  when certain and not funded then coalesce(capacity->>'reason','NO_ENTRY_CAPACITY')
  when not certain and not armed then 'CAPACITY_UNCERTAIN'
  when slot_ms is null or not in_path then 'CLOCK_OUTSIDE_CAPTURE_WINDOW'
  else 'WAITING_FOR_NEXT_CAPTURE_WINDOW' end;
 return r||jsonb_build_object(
  'entry_window',jsonb_build_object('version','TOP20_CLOCK_CAPTURE_1','slot_ms',slot_ms),
  'entry_capture',jsonb_build_object('funded',funded,'certain',certain,'enabled',entry_allowed,
   'armed_slot_ms',c.entry_capture_slot_ms,'arm_deadline_ms',arm_deadline,'reason',reason,
   'epoch_slot_ms',epoch_slot_ms,'epoch_published',epoch_slot_ms=slot_ms,
   'available_slots',capacity->'available','available_for_new_entry',capacity->'available_for_new_entry',
   'open_positions',capacity->'open_positions','reserved_slots',capacity->'reserved_slots',
   'available_quote',capacity->'available_quote'),
  'watch',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(r->'watch') x
   where x->'roles' ? 'OPEN_POSITION'
    or (funded or holding) and x->'roles' ? 'MARKET_SENSOR'
    or entry_allowed));
end $$;
revoke all on function public.doa_capture_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Reserve a slot at materialization, atomically, per candidate
-- ---------------------------------------------------------------------------
do $migration$
declare source text;
 guard text:='if (public.leader20_batch_capacity()->>''available'')::integer<1 then return jsonb_build_object(''created'',false,''reason'',''NO_ENTRY_CAPACITY'');end if;';
 decl text:='sid uuid;deadline timestamptz;';
begin
 select pg_get_functiondef('public.leader20_materialize_event(uuid,jsonb)'::regprocedure) into source;
 if strpos(source,guard)=0 or strpos(source,decl)=0 then raise exception 'CLOCK_MATERIALIZE_BASELINE_CHANGED';end if;
 source:=replace(source,decl,decl||'res jsonb;');
 source:=replace(source,guard,$g$
 -- One atomic slot per candidate. Concurrent GPT BUYs cannot overbook the account:
 -- the third of three candidates against two slots is refused NO_ENTRY_CAPACITY here.
 res:=public.leader20_reserve_entry_slot(e.symbol,(w->>'slot_ms')::bigint,null,
  to_timestamp((w->>'expires_at_ms')::numeric/1000));
 if res->>'reserved' is distinct from 'true' then
  return jsonb_build_object('created',false,'reason',coalesce(res->>'reason','NO_ENTRY_CAPACITY'));end if;
$g$);
 source:=replace(source,'r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);',
  'r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);
 if r->>''created''=''true'' then
  perform public.leader20_bind_entry_reservation((res->>''id'')::uuid,(r->>''signal_id'')::uuid);
 else
  perform public.leader20_settle_entry_reservation((res->>''id'')::uuid,''RELEASED'',''MATERIALIZE_REFUSED'');
 end if;');
 execute source;
end $migration$;
revoke all on function public.leader20_materialize_event(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.leader20_materialize_event(uuid,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Per-slot observation
-- ---------------------------------------------------------------------------
alter table public.leader20_clock_slots
 add column open_position_count integer,
 add column available_slots_before integer,
 add column available_slots_after integer,
 add column reserved_slots integer,
 add column futures_available_margin numeric,
 add column target_margin_per_slot numeric,
 add column watch_count integer,
 add column blocked_reasons jsonb,
 add column tracked_positions jsonb;

do $migration$
declare source text;marker text:='retry_count=greatest(retry_count,coalesce((p_data->>''retry_count'')::integer,0)),';
begin
 select pg_get_functiondef('public.leader20_clock_note(timestamptz,jsonb)'::regprocedure) into source;
 if strpos(source,marker)=0 then raise exception 'CLOCK_NOTE_BASELINE_CHANGED';end if;
 source:=replace(source,marker,marker||'
  open_position_count=coalesce((p_data->>''open_position_count'')::integer,open_position_count),
  available_slots_before=coalesce(available_slots_before,(p_data->>''available_slots_before'')::integer),
  available_slots_after=coalesce((p_data->>''available_slots_after'')::integer,available_slots_after),
  reserved_slots=greatest(coalesce(reserved_slots,0),coalesce((p_data->>''reserved_slots'')::integer,0)),
  futures_available_margin=coalesce((p_data->>''futures_available_margin'')::numeric,futures_available_margin),
  target_margin_per_slot=coalesce((p_data->>''target_margin_per_slot'')::numeric,target_margin_per_slot),
  watch_count=greatest(coalesce(watch_count,0),coalesce((p_data->>''watch_count'')::integer,0)),
  blocked_reasons=coalesce(p_data->''blocked_reasons'',blocked_reasons),
  tracked_positions=coalesce(p_data->''tracked_positions'',tracked_positions),');
 execute source;
end $migration$;

-- Everything requirement 19 asks for in one read-only row per ten-minute slot. Counts are
-- derived from the durable journals, so they cannot drift from what actually happened.
create or replace view public.leader20_clock_slot_report as
select t.slot_at,t.slot_status,t.batch_reason,t.batch_id,
 t.open_position_count,t.available_slots_before,t.reserved_slots,
 coalesce(t.available_slots_after,t.available_slots) available_slots_after,t.available_slots,
 t.futures_available_margin,t.target_margin_per_slot,
 t.watch_count,t.capture_ready_count,t.capture_blocked_count,t.blocked_reasons,t.retry_count,
 (select count(*) from public.gpt_final_entry_reviews g
  where g.record#>>'{packet,leader20,batch_id}'=t.batch_id::text and g.purpose='PRODUCTION'
   and g.record#>>'{packet,task}'='ENTRY' and coalesce(g.record->>'kind','FD1_ENTRY')='FD1_ENTRY'
   and g.completed_at is not null and g.decision='BUY') buy_now_count,
 (select count(*) from public.v11_long_regime_orders o join public.v11_long_regime_signals s on s.id=o.signal_id
  where o.intent='OPEN_LONG' and (s.features#>>'{leader20,entry_window,slot_ms}')::bigint
   =floor(extract(epoch from t.slot_at)*1000)::bigint) orders_attempted,
 (select count(*) from public.v11_long_regime_orders o join public.v11_long_regime_signals s on s.id=o.signal_id
  where o.intent='OPEN_LONG' and o.state='FILLED' and (s.features#>>'{leader20,entry_window,slot_ms}')::bigint
   =floor(extract(epoch from t.slot_at)*1000)::bigint) fills,
 (select count(*) from public.leader20_entry_reservations r
  where r.slot_ms=floor(extract(epoch from t.slot_at)*1000)::bigint) reservations,
 (select count(*) from public.leader20_entry_reservations r
  where r.slot_ms=floor(extract(epoch from t.slot_at)*1000)::bigint and r.state in ('RELEASED','EXPIRED')) reservations_released,
 -- Top20 publication lag against its own T-180s schedule. A lag over 60s used to cost the whole
 -- slot; it is now only a shorter transport lead for members that actually changed rank.
 (select round(extract(epoch from (e.observed_at-(t.slot_at-interval '180 seconds')))*1000)
  from public.leader20_epochs e
  where (e.snapshot->>'capture_slot_ms')::bigint=floor(extract(epoch from t.slot_at)*1000)::bigint
  order by e.observed_at limit 1) epoch_publish_lag_ms,
 t.tracked_positions,t.capture_ready_at,t.decision_deadline,t.updated_at
from public.leader20_clock_slots t;
revoke all on public.leader20_clock_slot_report from public,anon,authenticated;
grant select on public.leader20_clock_slot_report to service_role;

notify pgrst,'reload schema';
commit;
