-- inventory
select count(*) n,count(*) filter(where initial_gpt_record is not null) initial_records,count(*) filter(where pre_dispatch_snapshot is not null) pre_dispatch,count(*) filter(where initial_gpt_record#>'{packet,facts,values}' is not null) facts,count(*) filter(where mfe_60 is not null) labels,min(candidate_at),max(candidate_at) from missed_opportunity_journal;

-- featureKeys
select jsonb_object_keys(metadata->'entryFeatures') k,count(*) n from v11_long_regime_positions group by 1 order by 1;

-- fillCoverage
select market,side,count(*) n,count(*) filter(where position_id is not null) position_link,count(*) filter(where v17_position_id is not null) v17_link,min(executed_at),max(executed_at) from exchange_trade_fills where executed_at>='2026-09-19' group by 1,2;

-- orderSchema
select column_name,data_type from information_schema.columns where table_name='v11_long_regime_orders' order by ordinal_position;

-- purposes
select purpose,record#>>'{packet,task}' task,count(*) n from gpt_final_entry_reviews group by 1,2;

-- snapshotShape
select metadata->'entryFeatures' features,metadata->'entryConfirmation' confirmation,metadata->'postFillEntryGuard' guard,metadata->'v18Exits' exits from v11_long_regime_positions where entry_at>='2026-09-19' and metadata->'v18Exits' is not null order by entry_at desc limit 1;

-- candidates
select m.signal_id,m.symbol,m.candidate_at,m.reference_price,m.position_id,m.mfe_5,m.mae_5,m.mfe_60,m.mae_60,m.close_60m,m.initial_gpt_decision,m.initial_gpt_record#>'{packet,facts,values}' facts,m.initial_gpt_record#>'{packet,execution_ref}' execution_ref,m.initial_gpt_record->>'snapshot_at_ms' snapshot_ms,m.initial_gpt_record#>>'{result,completed_at_ms}' completed_ms,m.pre_dispatch_snapshot pre,m.execution_attempts attempts,p.entry_price,p.peak_price,p.realized_pnl_usdt,p.metadata->>'executorPatch' patch from missed_opportunity_journal m left join v11_long_regime_positions p on p.id=m.position_id where m.initial_gpt_record#>'{packet,facts,values}' is not null or m.pre_dispatch_snapshot is not null order by m.candidate_at,m.signal_id;

-- positions
select p.id,p.signal_id,p.symbol,p.entry_at,p.closed_at,p.state,p.entry_price,p.exit_price,p.original_quantity,p.peak_price,p.entry_fee_usdt,p.realized_pnl_usdt,p.metadata->>'executorPatch' patch,p.metadata->>'entryTimingPolicyVersion' timing,p.metadata->'entryFeatures'->>'strategy' strategy,p.metadata->'entryFeatures'->>'spreadBps' legacy_spread,p.metadata->'entryFeatures'->>'bookImbalance' legacy_imbalance,p.metadata->'entryConfirmation' confirmation,p.metadata->'entryFillOrders' entry_orders,p.metadata->>'entryOrderId' entry_order_id,p.metadata->'v18Exits' exits,p.metadata->>'v18EntryAccountingPending' entry_pending,p.metadata->>'exitAccountingPending' exit_pending,m.reference_price,m.candidate_at,m.execution_attempts attempts,m.pre_dispatch_snapshot pre from v11_long_regime_positions p left join missed_opportunity_journal m on m.position_id=p.id order by p.entry_at,p.id;

-- fills
select f.v17_position_id position_id,f.exchange_order_id, f.side,count(*) fills,sum(f.quantity) quantity,sum(f.quote_amount) quote_amount,sum(f.fee_quote_amount) fee,min(f.fee_asset) fee_asset,count(*) filter(where fee_quote_amount is null) missing_fee,bool_and(f.is_maker) all_maker,bool_or(f.is_maker) any_maker,min(f.executed_at) first_at,max(f.executed_at) last_at,sum(f.realized_pnl_quote) fill_pnl from exchange_trade_fills f where f.v17_position_id in(select id from v11_long_regime_positions where entry_at>='2026-09-19') group by 1,2,3 order by 1,2;

-- latencies
select job_key,signal_id,symbol,record#>>'{packet,task}' task,snapshot_at,api_started_at,api_completed_at,completed_at,latency_ms,record#>'{packet,execution_ref}' execution_ref,record#>>'{packet,as_of_offset_ms}' offset_ms from gpt_final_entry_reviews where purpose='PRODUCTION' and record->'packet' is not null order by created_at;

-- dbfunctions
select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname ilike '%sync%missed%';
