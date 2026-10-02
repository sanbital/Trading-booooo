CREATE OR REPLACE FUNCTION public.leader20_entry_reservation_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.leader20_entry_slot_policy()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 select jsonb_build_object('version','ENTRY_SLOT_POLICY_1','max_slots',10,
  'target_margin_per_slot',152.021375::numeric,'cash_buffer',0.10::numeric);
$function$;

CREATE OR REPLACE FUNCTION public.leader20_batch_capacity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
