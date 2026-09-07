do $repair$
declare
  body text;
  anchor constant text := '  -- Do not adopt a fill that can already be proven to belong to a bot order.';
  marker constant text := 'FUTURES_LEDGER_ONLY_20260908';
begin
  select pg_get_functiondef('public.adopt_manual_trade_fill(uuid)'::regprocedure)
    into strict body;
  if position(marker in body) > 0 then
    return;
  end if;
  if (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'ADOPTION_PATCH_ANCHOR_NOT_UNIQUE: inspect deployed definition before applying';
  end if;
  body := replace(
    body,
    anchor,
    E'  -- FUTURES_LEDGER_ONLY_20260908: importing fills must never authorize trading.\\n'
      || E'  if lower(coalesce(v_fill.exchange, '''')) = ''binance_futures'' then\\n'
      || E'    return v_fill.position_id;\\n'
      || E'  end if;\\n\\n'
      || anchor
  );
  execute body;
end;
$repair$;
