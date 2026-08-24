-- S096 replaces S37 for new SHORT entries. The same operator opt-in remains in force;
-- S37 is retained only as a grandfathered exit policy for positions opened before cutover.

comment on column public.trading_settings.binance_futures_short_enabled is
  'Allows exact S096-LIVE-1.0.0 Binance futures SHORT entries; legacy S37 positions retain their original exit policy. LONG is unaffected.';
