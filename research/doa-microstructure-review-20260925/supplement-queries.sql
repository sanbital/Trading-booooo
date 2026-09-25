-- V17 membership used to separate legacy order cohorts; exported to v17-ids.json
select id from v11_long_regime_signals where features->>'strategy'='LEADER_MOMENTUM_V17' order by id;

-- coverageMore
select table_name,column_name,data_type from information_schema.columns where table_schema='public' and table_name in ('v10_usdm_forward_snapshots','v10_crossvenue_forward_snapshots','v2_live_universe_snapshots') order by table_name,ordinal_position;

-- fn
select proname from pg_proc where pronamespace='public'::regnamespace and proname ilike '%missed%';

-- signals
select count(*) total,count(*) filter(where features->>'strategy'='LEADER_MOMENTUM_V17') v17,count(*) filter(where features ? 'spreadBps') spread,count(*) filter(where features ? 'bookImbalance') imbalance,count(*) filter(where features ? 'spread_bps') snake_spread from v11_long_regime_signals;

-- candles
select 'claude_bt.klines' tbl,min(open_time),max(open_time),count(*) filter(where open_time>='2026-09-19') recent from claude_bt.klines union all select 'public.claude_r8_klines',min(open_time),max(open_time),count(*) filter(where open_time>='2026-09-19') from claude_r8_klines;

-- forward
select 'usdm' tbl,count(*) n,min(observation_bucket),max(observation_bucket),count(*) filter(where observation_bucket>='2026-09-08') recent from v10_usdm_forward_snapshots union all select 'crossvenue',count(*),min(observation_bucket),max(observation_bucket),count(*) filter(where observation_bucket>='2026-09-08') from v10_crossvenue_forward_snapshots;

-- legacyCandidates
select s.id signal_id,s.symbol,s.created_at candidate_at,s.features->>'strategy' strategy,s.features->>'spreadBps' spread_bps,s.features->>'bookImbalance' book_imbalance,m.mfe_60,m.mae_60,m.mfe_5 from v11_long_regime_signals s left join missed_opportunity_journal m on s.id=m.signal_id where s.features ? 'spreadBps' order by s.created_at;

-- functions
select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('missed_opportunity_sync','missed_opportunity_track_lane');

-- feeRate
select jsonb_object_keys(request_payload) k,count(*) from v11_long_regime_orders where created_at>='2026-09-19' and intent='OPEN_LONG' group by 1 order by 1;

-- orderFeatures
with o as(select distinct on(signal_id) signal_id,symbol,created_at,request_payload->>'spread_bps' spread,request_payload->>'expected_slippage_bps' slippage,request_payload->'e1'->>'expectedCostBps' cost,request_payload->'e1'->>'expectedEntryVWAP' vwap,request_payload->>'executor_patch' patch from v11_long_regime_orders where intent='OPEN_LONG' order by signal_id,created_at,id) select o.*,m.mfe_60,m.mae_60,m.mfe_5,m.candidate_at,p.entry_price,p.peak_price from o left join missed_opportunity_journal m on m.signal_id=o.signal_id left join v11_long_regime_positions p on p.signal_id=o.signal_id order by o.created_at;
