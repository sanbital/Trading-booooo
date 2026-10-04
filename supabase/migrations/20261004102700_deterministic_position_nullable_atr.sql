-- Dynamic-state entries deliberately have no legacy ATR price-distance field.
-- Keep the legacy requirement; recognize only the matching persisted entry and
-- feature contract of the deterministic executor. NOT VALID avoids a table scan.
begin;
set local lock_timeout='500ms';
set local statement_timeout='3000ms';
alter table public.v11_long_regime_positions drop constraint leader20_nullable_atr;
alter table public.v11_long_regime_positions add constraint leader20_nullable_atr
 check(entry_atr is not null
  or coalesce(metadata#>>'{entryFeatures,leader20,version}'='LEADER20_DYNAMIC_1',false)
  or coalesce(metadata#>>'{entryFeatures,deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1'
   and metadata#>>'{deterministicEntry,version}'='DETERMINISTIC_DYNAMIC_STATE_1',false)) not valid;
commit;
