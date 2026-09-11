-- Futures history is evidence, not permission to create/augment managed positions.
-- Retain all entry safeguards, exact order attribution, and existing spot behavior.
-- This migration never changes order switches, circuits, quantities or account data.
DO $repair$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef('public.adopt_manual_trade_fill(uuid)'::regprocedure);
  IF position('FUTURES_INGESTION_ONLY_20260908' in definition) = 0 THEN
    anchor := '  -- Do not adopt a fill that can already be proven to belong to a bot order.';
    IF (length(definition)-length(replace(definition,anchor,''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'adopt_manual_trade_fill changed; review before applying ingestion repair';
    END IF;
    definition := replace(definition,anchor,
      E'  -- FUTURES_INGESTION_ONLY_20260908: unmatched history must not enable automatic exits.\n'
      || E'  if lower(coalesce(v_fill.exchange, '''')) = ''binance_futures'' then\n'
      || E'    return v_fill.position_id;\n  end if;\n\n' || anchor);
    EXECUTE definition;
  END IF;
  definition := pg_get_functiondef('public.enforce_futures_fill_order_attribution()'::regprocedure);
  IF position('UNPROVEN_FUTURES_SOURCE_20260908' in definition) = 0 THEN
    anchor := '  new.position_id := v_position_id;';
    IF (length(definition)-length(replace(definition,anchor,''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'enforce_futures_fill_order_attribution changed; review before applying repair';
    END IF;
    definition := replace(definition,anchor,
      anchor || E'\n  -- UNPROVEN_FUTURES_SOURCE_20260908: absence of a bot match does not prove manual ownership.\n'
      || E'  if v_position_id is null then\n    new.source := ''UNCLASSIFIED'';\n  end if;');
    EXECUTE definition;
  END IF;
END;
$repair$;
CREATE OR REPLACE FUNCTION public.trg_adopt_manual_trade_fill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  -- Guard both this trigger and the RPC above; do not rely on trigger depth.
  if lower(coalesce(new.exchange, '')) = 'binance_futures' then
    return new;
  end if;
  if upper(coalesce(new.source, '')) = 'MANUAL'
     and upper(coalesce(new.side, '')) = 'BUY'
     and new.position_id is null and new.bot_order_id is null then
    perform public.adopt_manual_trade_fill(new.id);
  end if;
  return new;
end;
$function$;
