-- 7.3.8-M1-CORE-SCORE-OBS-TOLERANCE
-- Core 1m admission: bullish completed candle, Stoch(14,3,3) K>D, upper-band touch,
-- and rising upper band. Other candle attributes are weighted supporting evidence.
-- The scanner still observes for 15 seconds; 13.5-15.0 seconds is accepted only with
-- substantial synchronized book/trade samples.

update public.trading_settings
set lob_observation_window_ms = 15000,
    lob_max_gainer_rank = 10,
    lob_live_admission_revision = '7.3.8-M1-CORE-SCORE-OBS-TOLERANCE',
    lob_model_revision = '7.3.8-M1-CORE-SCORE-OBS-TOLERANCE',
    updated_at = now()
where id = 1;
