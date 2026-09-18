-- v6.13.0 ADAPTIVE SEARCH EXPANSION
--
-- When adequate scans find zero executable opportunities, widen the search surface rather
-- than weakening economics. Core Heat books remain observed every cycle; additional ranks are
-- rotated through a bounded websocket budget. Entry EV, direction, spread, risk and the KST
-- daily -30% circuit are unchanged.

alter table public.trading_settings
  add column if not exists lob_search_expand_enabled boolean not null default true,
  add column if not exists lob_search_base_finalists integer not null default 12,
  add column if not exists lob_search_max_finalists integer not null default 20,
  add column if not exists lob_search_base_observation_ms integer not null default 8000,
  add column if not exists lob_search_max_observation_ms integer not null default 12000,
  add column if not exists lob_search_rotation_pool integer not null default 48,
  add column if not exists lob_search_rotation_minutes integer not null default 1,
  add column if not exists lob_search_state_fresh_minutes integer not null default 20;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_search_v6130;
alter table public.trading_settings
  add constraint trading_settings_lob_adaptive_search_v6130 check (
    lob_search_base_finalists between 4 and 20
    and lob_search_max_finalists between lob_search_base_finalists and 20
    and lob_search_base_observation_ms between 8000 and 12000
    and lob_search_max_observation_ms between lob_search_base_observation_ms and 12000
    and lob_search_rotation_pool between lob_search_max_finalists and 120
    and lob_search_rotation_minutes between 1 and 30
    and lob_search_state_fresh_minutes between 5 and 120
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_adaptive_search_v6130;

update public.trading_settings
   set lob_search_expand_enabled = true,
       lob_search_base_finalists = 12,
       lob_search_max_finalists = 20,
       lob_search_base_observation_ms = 8000,
       lob_search_max_observation_ms = 12000,
       lob_search_rotation_pool = 48,
       lob_search_rotation_minutes = 1,
       lob_search_state_fresh_minutes = 20,
       -- Verified exchange-pattern parents are sparse but strongly adverse. Start with a
       -- deliberately small weight at 8 samples and reach the 0.5 parent cap at 40 samples.
       lob_regime_parent_start_samples = 8,
       lob_regime_parent_full_samples = 40,
       version = version + 1,
       updated_at = now()
 where id = 1;

comment on column public.trading_settings.lob_search_expand_enabled is
  'Widens LOB observation breadth after a fresh search-failure signal; never lowers entry gates.';
comment on column public.trading_settings.lob_search_rotation_pool is
  'Heat ranks after the core finalist set that are rotated through the additional observation slots.';
