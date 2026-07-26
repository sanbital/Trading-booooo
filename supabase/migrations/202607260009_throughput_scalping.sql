-- Trading-booooo v5.6 — throughput-optimal scalping.
--
-- v5.4 answered "costs eat the edge" by widening targets to 2-4% and holding up to six
-- hours. That is not a fix for a scalper; it is a different strategy. The constraint is
-- scalping, and the objective is profit per unit TIME, not per trade:
--
--     profit rate ∝ (δW − C) / W²        (barrier hit time scales with W²)
--     d/dW = 0    ⇒  W* = 2C/δ,   max rate ∝ δ²/(4C)
--
-- The optimum is a POINT with an upper bound. Under maker costs (0.07% on Upbit) and a
-- 10pp edge assumption that is a 1.6% total width — a scalp, not a swing.
--
-- Win rate is arithmetic, not preference: the neutral win rate of a barrier pair IS
-- S/(T+S), so a 2:1 reward:risk caps it at 33% before any edge exists. A >50% win rate
-- requires S >= T. scalp_target_win_rate now drives the split.

alter table public.trading_settings
  -- The win rate the bot should actually print. Realized = S/(T+S) + edge, so this pins
  -- the target/stop split. Set 0 to fall back to a fixed reward:risk.
  add column if not exists scalp_target_win_rate numeric not null default 0.58;

alter table public.trading_settings
  add constraint trading_settings_target_win_rate_ck
    check (scalp_target_win_rate >= 0 and scalp_target_win_rate <= 0.80) not valid;
alter table public.trading_settings validate constraint trading_settings_target_win_rate_ck;

-- A high-win-rate scalp needs the stop no tighter than the target. The old 1..4 bound
-- made that impossible to express.
alter table public.trading_settings drop constraint if exists trading_settings_scalp_reward_risk_ck;
alter table public.trading_settings
  add constraint trading_settings_scalp_reward_risk_ck
    check (scalp_reward_risk >= 0.4 and scalp_reward_risk <= 4) not valid;
alter table public.trading_settings validate constraint trading_settings_scalp_reward_risk_ck;

-- Back to a scalp horizon. Throughput-optimal barriers are narrow and resolve fast; the
-- 120/360-minute settings were a consequence of taker costs, not of the strategy.
update public.trading_settings
   set scalp_max_holding_minutes = least(coalesce(scalp_max_holding_minutes, 45), 45),
       scalp_safety_ttl_minutes  = least(coalesce(scalp_safety_ttl_minutes, 120), 120),
       updated_at = now()
 where id = 1
   and strategy = 'SCALP';

-- Existing open positions carry the wide v5.4/v5.5 backstop; re-base them so the new
-- horizon applies without force-closing anything already in flight.
update public.trading_positions p
   set max_holding_at = least(
         p.max_holding_at,
         greatest(coalesce(p.opened_at, p.created_at) + interval '120 minutes', now() + interval '10 minutes')
       )
  from public.trading_settings s
 where s.id = 1 and s.strategy = 'SCALP' and p.state = 'OPEN';

update public.trading_settings set updated_at = now() where id = 1;
