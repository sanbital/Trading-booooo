-- Restore the absolute/max-hold STOP owner for Binance Futures after the
-- 20260818083500 recovery-state migration rewrote guard_residual_sell_order_v751()
-- with `and not v_futures`. Absolute timeout must outrank the first-tranche guard
-- for both spot and futures once the position has reached its hard holding deadline.
--
-- This is deliberately a bounded source patch: fail closed if the expected guard
-- shape has drifted instead of silently replacing unrelated policy logic.

DO $migration$
DECLARE
  v_def text;
  v_bad text := $bad$
  elsif upper(coalesce(new.purpose, '')) = 'STOP'
        and not v_futures
        and v_approved_reason in ('HALF_HOLD_ABSOLUTE_TIMEOUT', 'POST180_MAX_HOLD_TIMEOUT')
$bad$;
  v_good text := $good$
  elsif upper(coalesce(new.purpose, '')) = 'STOP'
        and v_approved_reason in ('HALF_HOLD_ABSOLUTE_TIMEOUT', 'POST180_MAX_HOLD_TIMEOUT')
$good$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'guard_residual_sell_order_v751'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'guard_residual_sell_order_v751() not found';
  END IF;

  IF position(v_bad IN v_def) = 0 THEN
    IF position(v_good IN v_def) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'FUTURES_ABSOLUTE_TIMEOUT_GUARD_SOURCE_DRIFT';
  END IF;

  v_def := replace(v_def, v_bad, v_good);
  EXECUTE v_def;
END
$migration$;

COMMENT ON FUNCTION public.guard_residual_sell_order_v751() IS
  'Split/residual exit authority with futures absolute-timeout STOP ownership restored after recovery-state rewrite.';
