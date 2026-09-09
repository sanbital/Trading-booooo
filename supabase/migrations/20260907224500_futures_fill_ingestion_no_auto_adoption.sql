-- Futures fill ingestion is bookkeeping, never trading authorization.
-- Root cause reproduced with the deployed functions in pg_temp, then rolled back:
-- adopt_manual_trade_fill -> UPDATE position_id -> attribution resets a futures BUY
-- to NULL -> adoption retriggers. Small historical fills instead hit the current
-- order-entry minimum when adoption manufactures a MANUAL/APPLIED order.
-- Preserve raw fills, exchange attribution, all order guards and every live switch.
-- Preserve existing spot adoption behavior. Never adopt unknown futures positions.
DO $repair$
DECLARE
  body text;
  anchor constant text := '  -- Do not adopt a fill that can already be proven to belong to a bot order.';
  marker constant text := 'FUTURES_LEDGER_ONLY_20260908';
BEGIN
  SELECT pg_get_functiondef('public.adopt_manual_trade_fill(uuid)'::regprocedure)
    INTO STRICT body;
  IF position(marker IN body) > 0 THEN
    RETURN;
  END IF;
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'ADOPTION_PATCH_ANCHOR_NOT_UNIQUE: inspect deployed definition before applying';
  END IF;
  body := replace(body,anchor,
    E'  -- FUTURES_LEDGER_ONLY_20260908: importing fills must never authorize trading.\n'
    || E'  if lower(coalesce(v_fill.exchange, '''')) = ''binance_futures'' then\n'
    || E'    return v_fill.position_id;\n'
    || E'  end if;\n\n' || anchor);
  EXECUTE body;
END;
$repair$;
