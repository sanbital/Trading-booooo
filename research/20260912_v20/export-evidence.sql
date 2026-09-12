\set ON_ERROR_STOP on
begin isolation level repeatable read read only;
set local v20.analysis_start = :'analysis_start';
set local v20.analysis_cutoff = :'analysis_cutoff';

\copy (select row_to_json(x) from (select * from public.v11_long_regime_positions where entry_at >= current_setting('v20.analysis_start')::timestamptz and entry_at <= current_setting('v20.analysis_cutoff')::timestamptz order by entry_at, id) x) to 'evidence/positions.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select d.* from public.v11_long_regime_decisions d join public.v11_long_regime_positions p on p.id=d.position_id where p.entry_at >= current_setting('v20.analysis_start')::timestamptz and p.entry_at <= current_setting('v20.analysis_cutoff')::timestamptz and d.decided_at <= current_setting('v20.analysis_cutoff')::timestamptz order by d.decided_at, d.id) x) to 'evidence/decisions.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.v11_long_regime_signals where created_at >= current_setting('v20.analysis_start')::timestamptz and created_at <= current_setting('v20.analysis_cutoff')::timestamptz order by created_at, id) x) to 'evidence/signals.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.v11_long_regime_orders where created_at >= current_setting('v20.analysis_start')::timestamptz and created_at <= current_setting('v20.analysis_cutoff')::timestamptz order by created_at, id) x) to 'evidence/orders.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and executed_at >= current_setting('v20.analysis_start')::timestamptz - interval '5 minutes' and executed_at <= current_setting('v20.analysis_cutoff')::timestamptz order by executed_at, id) x) to 'evidence/exchange-fills.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.trading_account_snapshots where exchange='binance_futures' and captured_at >= current_setting('v20.analysis_start')::timestamptz and captured_at <= current_setting('v20.analysis_cutoff')::timestamptz order by captured_at, id) x) to 'evidence/account-snapshots.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.v17_market_scan_runs where captured_at >= current_setting('v20.analysis_start')::timestamptz and captured_at <= current_setting('v20.analysis_cutoff')::timestamptz order by captured_at, id) x) to 'evidence/market-scans.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.v18_strategy_shadow_runs where slot_at >= current_setting('v20.analysis_start')::timestamptz and slot_at <= current_setting('v20.analysis_cutoff')::timestamptz and policy_version in ('V18_STRATEGY_SHADOW_1','QV3_ENTRY_EXIT_TWO_SHADOW_1') order by slot_at, policy_version) x) to 'evidence/strategy-shadow.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select * from public.trading_cycle_runs where started_at >= current_setting('v20.analysis_start')::timestamptz and started_at <= current_setting('v20.analysis_cutoff')::timestamptz order by started_at, id) x) to 'evidence/cycles.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select jsonb_build_object('kind','captured_at','payload',jsonb_build_object('database_clock',clock_timestamp(),'transaction_timestamp',transaction_timestamp(),'analysis_cutoff',current_setting('v20.analysis_cutoff'),'txid_snapshot',txid_current_snapshot())) union all select jsonb_build_object('kind','v11_long_regime_runtime','payload',to_jsonb(r)) from public.v11_long_regime_runtime r where singleton union all select jsonb_build_object('kind','v17_operator_control','payload',to_jsonb(o)) from public.v17_operator_control o where singleton union all select jsonb_build_object('kind','trading_settings','payload',to_jsonb(s)) from public.trading_settings s where id=1 union all select jsonb_build_object('kind','v18_ops_incident','payload',to_jsonb(i)) from public.v18_ops_incidents i where opened_at <= current_setting('v20.analysis_cutoff')::timestamptz order by 1) to 'evidence/operational-snapshot.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

\copy (select row_to_json(x) from (select table_name,column_name,data_type,ordinal_position from information_schema.columns where table_schema='public' and table_name in ('v11_long_regime_positions','v11_long_regime_decisions','v11_long_regime_signals','v11_long_regime_orders','exchange_trade_fills','trading_account_snapshots','v17_market_scan_runs','v18_strategy_shadow_runs','trading_cycle_runs','v11_long_regime_runtime','v17_operator_control','trading_settings','v18_ops_incidents') order by table_name,ordinal_position) x) to 'evidence/schema.jsonl' with (format csv, delimiter E'\x1f', quote E'\x1e', escape E'\x1d')

commit;
