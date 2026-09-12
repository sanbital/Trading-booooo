-- Trading-booooo v6.6.0-LIVE-DATA
--
-- Source: 67 CLOSED LIVE LOB positions ending 2026-07-27 15:26:50 KST,
-- 171 maker-entry attempts, and the day's rejection/error distribution.
--
-- This migration seeds the same conservative profile that the hourly lob-calibration
-- job will rebuild from the database. The 120-sample prior remains in force:
-- today's data corrects the model immediately without becoming a permanent hard-coded
-- verdict. No new entry veto and no trade-count ceiling is added.

do $$
declare
  v_profile_id uuid;
  v_patterns jsonb := '[
    {
      "pattern": "ABSORPTION_REVERSAL",
      "samples": 29,
      "realizedHitRate": 0.06896551724137931,
      "predictedHitRate": 0.511616909008477,
      "neutralWinRate": 0.3983815003057423,
      "measuredEdge": -0.32941598306436304,
      "predictedEdge": 0.11323540870273469,
      "meanNetBps": -15.4978,
      "probabilityMultiplier": 0.30,
      "hitRateLowerBound": 0.019120864097994437
    },
    {
      "pattern": "OFI_CONTINUATION",
      "samples": 24,
      "realizedHitRate": 0.08333333333333333,
      "predictedHitRate": 0.515151382151939,
      "neutralWinRate": 0.40783601447762086,
      "measuredEdge": -0.32450268114428754,
      "predictedEdge": 0.10731536767431815,
      "meanNetBps": -21.2222,
      "probabilityMultiplier": 0.3293628269390523,
      "hitRateLowerBound": 0.023158327842973492
    },
    {
      "pattern": "SWEEP_RECLAIM",
      "samples": 14,
      "realizedHitRate": 0.2857142857142857,
      "predictedHitRate": 0.5200399166000589,
      "neutralWinRate": 0.4090767964145015,
      "measuredEdge": -0.12336251070021581,
      "predictedEdge": 0.11096312018555737,
      "meanNetBps": -2.7363,
      "probabilityMultiplier": 0.7793700980072484,
      "hitRateLowerBound": 0.11721187910109102
    }
  ]'::jsonb;
  v_notes jsonb := jsonb_build_array(
    'LIVE_DATA_2026-07-27_KST',
    '67 live trades: profitable 16 (23.9%), target hit 8 (11.9%), mean -14.88bp',
    'pTarget mean 51.5% versus target-hit 11.9%; 120-sample shrinkage applied',
    'maker entries: 67 fills / 171 attempts = 39.2%; calibrated per exchange at runtime',
    'selection keeps trade count: no new veto; EV-LCB ranking replaces hotness-first ranking'
  );
begin
  -- Re-pushable: reuse this seed row when the migration is executed again.
  update public.lob_learning_profiles
     set active = false
   where active;

  update public.lob_learning_profiles
     set generated_at = '2026-07-27T06:26:50.697Z'::timestamptz,
         active = true,
         samples = 67,
         base_hit_rate = 8.0 / 67.0,
         window_hours = 24,
         patterns = v_patterns,
         traps = '[]'::jsonb,
         notes = v_notes
   where id = (
     select id
       from public.lob_learning_profiles
      where notes @> '["LIVE_DATA_2026-07-27_KST"]'::jsonb
      order by created_at desc
      limit 1
   )
  returning id into v_profile_id;

  if v_profile_id is null then
    insert into public.lob_learning_profiles (
      generated_at,
      active,
      samples,
      base_hit_rate,
      window_hours,
      patterns,
      traps,
      notes
    ) values (
      '2026-07-27T06:26:50.697Z'::timestamptz,
      true,
      67,
      8.0 / 67.0,
      24,
      v_patterns,
      '[]'::jsonb,
      v_notes
    );
  end if;
end $$;

-- Preserve throughput by expanding candidate supply and simultaneous slots. Total managed
-- exposure is unchanged: the risk allocator divides the same operator allocation across
-- the active slots.
alter table public.trading_settings
  alter column scalp_position_slots set default 12,
  alter column scalp_scan_universe set default 240;

update public.trading_settings
   set scalp_position_slots = greatest(coalesce(scalp_position_slots, 12), 12),
       scalp_scan_universe = greatest(coalesce(scalp_scan_universe, 240), 240),
       lob_scan_interval_seconds = least(coalesce(lob_scan_interval_seconds, 12), 12),
       full_scan_interval_seconds = least(coalesce(full_scan_interval_seconds, 12), 12),
       max_new_entries_per_scan = greatest(coalesce(max_new_entries_per_scan, 12), 12),
       version = coalesce(version, 0) + 1,
       updated_at = now()
 where id = 1
   and strategy = 'LOB_SCALP';
