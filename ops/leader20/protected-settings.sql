select jsonb_build_object(
 'settings',(select jsonb_build_object('margin',binance_futures_allocation_usdt,'leverage',binance_futures_leverage,'slots',max_open_positions_per_exchange,'mode',mode,'pause',pause_new_entries) from public.trading_settings where id=1),
 'ai',(select jsonb_build_object('mode',mode,'daily_cap_usd',daily_cap_usd,'max_calls_per_day',max_calls_per_day) from public.gpt_final_review_control where singleton),
 'archive_budget',(select archive_max_bytes from public.leader20_control where singleton));
