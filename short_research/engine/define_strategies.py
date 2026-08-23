"""Emit the frozen S01..S50 SHORT strategy definitions.

BASELINE CORRECTION (before any market data was loaded):
The live entry strategy on binance_futures is I46_HYBRID_SCORE_L1 (revision I46-LIVE-1.0.0),
not P10. P10 was retired for the Binance venues on 2026-08-22 -- v2_live_signals carries an
explicit `P10_DONCHIAN_BREAKOUT_RETIRED_20260822` config_key at the cutover, and
v2_strategy_registry now records binance_futures as strategy_key I46_HYBRID_SCORE_L1 with
execution_config_key P10_DONCHIAN_BREAKOUT_E10_SLOW_4R. P10 survives only as the exit and
execution policy. So a "production symmetric SHORT" mirrors I46 entry + P10 exit, which is
what S01 now is. The retired P10-symmetric SHORT is kept as S02 so the two can be compared
directly, and it replaces a definition that had been an exact duplicate of S25.

Written and hashed BEFORE any market data is loaded. The definitions are executable
specs: run_strategy() in backtest.py dispatches on the enum fields here, so a
definition cannot silently drift from what was actually run.

Every strategy is a structural variant -- a different entry rule, a different exit
mechanism, a different regime gate or a different guard. None of them is a parameter
sweep of another. Where an exit family is under test (S31..S50) the entry is pinned
to the S01 production-symmetric entry so the exit effect is isolated.
"""
import json, hashlib, copy, pathlib

P10 = dict(
    donchian_n=72, breakout_buffer_atr=0.10, stop_atr=2.00, target_r=5.00,
    trail_atr=2.50, breakeven_r=1.50, partial_r=2.00, partial_fraction=0.40,
    loss_time_stop_bars=24, max_hold_bars=96, min_volume_ratio=1.60,
    trend_min_pct=1.20, trend_max_pct=20.0, min_close_location=0.74,
    min_ema_slope6_pct=0.10, max_entry_gap_atr=0.50,
    liquidity_floor=500000, atr_pct_range=[0.15, 6.0], rsi_range=[16, 52],
)

BASE = {
    "side": "SHORT",
    "venue": "binance_futures",
    "timeframe": "1h",
    "current_candle_excluded": True,
    "min_history_bars": 106,
    "entry": {
        "rule": "DONCHIAN_BREAKDOWN",
        "params": {"n": P10["donchian_n"], "buffer_atr": P10["breakout_buffer_atr"],
                   "require_prior_inside": True},
        "timing": "NEXT_BAR_OPEN",
        "trigger_price": "NEXT_BAR_OPEN",
        "max_entry_gap_atr": P10["max_entry_gap_atr"],
        "max_initial_risk_pct": 5.0,
    },
    "filters": {
        "min_volume_ratio": P10["min_volume_ratio"],
        "liquidity_floor_quote_mean20": P10["liquidity_floor"],
        "atr_pct_range": P10["atr_pct_range"],
        "ret24_pct_range": [-P10["trend_max_pct"], -P10["trend_min_pct"]],
        "rsi14_range": P10["rsi_range"],
        "min_close_location": P10["min_close_location"],
        "min_ema_slope6_pct": P10["min_ema_slope6_pct"],
        "require_ema20_below_ema50": True,
        "require_bearish_candle": True,
        "overextension_max_abs_ret24_pct": None,
        "extreme_mover_rank_guard": None,
        "funding_rate_min": None,
        "min_quote_volume_percentile": None,
    },
    "regime": {"mode": "SYMMETRIC_P10",
               "params": {"benchmark": "BTCUSDT", "not_regime": "BULL",
                          "ret24_max_pct": -0.10, "ret72_max_pct": 0.0}},
    "stop": {"method": "ATR", "mult": P10["stop_atr"]},
    "take_profit": {"method": "R_MULTIPLE", "r": P10["target_r"]},
    "partial_exit": {"enabled": True, "at_r": P10["partial_r"],
                     "fraction": P10["partial_fraction"]},
    "breakeven": {"enabled": True, "at_r": P10["breakeven_r"],
                  "cost_stress_multiple": 1.5},
    "trailing": {"method": "ATR", "mult": P10["trail_atr"],
                 "activation": "FAVORABLE_CLOSE_R_GT_0"},
    "rule_exits": {"ema_reclaim": "EMA20", "donchian_reclaim_n": None,
                   "momentum_reversal_rsi_above": None, "regime_reversal": False},
    "max_holding_bars": P10["max_hold_bars"],
    "loss_time_stop_bars": P10["loss_time_stop_bars"],
    "cooldown_bars": 0,
    "same_symbol_rule": "ONE_ACTIVE_POSITION_PER_SYMBOL",
    "conflict_rule": "SKIP_IF_OPPOSITE_SIDE_OPEN",
}

def S(sid, name, family, strength, risk, **patch):
    d = copy.deepcopy(BASE)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(d.get(k), dict):
            d[k] = {**d[k], **v}
        else:
            d[k] = v
    d["strategy_id"] = sid
    d["name"] = name
    d["family"] = family
    d["expected_strength"] = strength
    d["expected_risk"] = risk
    return d

def F(**kw):   return {"filters": kw}
def R(mode, **p): return {"regime": {"mode": mode, "params": p}}

X = []
A = X.append

# ---- Family A: Donchian breakdown lineage -------------------------------------
A(S("S01","Production symmetric SHORT (I46 entry + P10 exit)","I46_LIVE",
    "Exact mirror of what binance_futures actually runs today; the only variant with "
    "true production parity.",
    "Inherits an 8-condition hybrid score tuned on long-side behaviour, and its gates are "
    "materially looser than P10's, so it will fire far more often.",
    entry={"rule":"I46_HYBRID_SCORE","params":{"min_score":5},
           "timing":"NEXT_BAR_OPEN","trigger_price":"NEXT_BAR_OPEN"},
    regime={"mode":"I46_BUILTIN","params":{"benchmark":"BTCUSDT",
                                           "ret24_min_directional":-0.50,
                                           "ret72_min_directional":-2.0}}))
A(S("S02","Retired P10 symmetric SHORT","DONCHIAN_BREAKDOWN",
    "The previous production entry, retired on 2026-08-22; the reference the Donchian "
    "family is built on and the direct comparison against S01.",
    "No longer what production runs, and its gates are strict enough that it may barely fire."))
A(S("S03","Breakdown, strict BEAR regime","DONCHIAN_BREAKDOWN",
    "Only trades confirmed benchmark downtrends.",
    "Very few signals; may miss the fastest legs down.",
    **R("BENCHMARK_BEAR_ONLY", benchmark="BTCUSDT")))
A(S("S04","Breakdown, no ATR buffer","DONCHIAN_BREAKDOWN",
    "Earlier fills at the channel edge.",
    "More marginal breaks that reclaim immediately.",
    entry={"params":{"n":72,"buffer_atr":0.0,"require_prior_inside":True}}))
A(S("S05","Intrabar breakdown trigger","DONCHIAN_BREAKDOWN",
    "Captures the move without waiting for the hourly close.",
    "No close confirmation; highest wick-fill risk.",
    entry={"rule":"DONCHIAN_BREAKDOWN_INTRABAR","timing":"INTRABAR_TRIGGER",
           "trigger_price":"CHANNEL_LEVEL",
           "params":{"n":72,"buffer_atr":0.10,"require_prior_inside":True}}))
A(S("S06","Breakdown, two-close confirmation","DONCHIAN_BREAKDOWN",
    "Two consecutive closes below the channel filter out one-bar fakeouts.",
    "Enters later and further from the stop reference.",
    entry={"rule":"DONCHIAN_BREAKDOWN_CONFIRMED","timing":"NEXT_BAR_OPEN",
           "params":{"n":72,"buffer_atr":0.10,"require_prior_inside":True,
                     "confirm_closes":2}}))

# ---- Family B: retest / failed reclaim ----------------------------------------
A(S("S07","Breakdown retest rejection","RETEST",
    "Enters on the pullback, so the stop sits much closer.",
    "Many breakdowns never retest; low fill rate.",
    entry={"rule":"BREAKDOWN_RETEST_REJECT","timing":"NEXT_BAR_OPEN",
           "params":{"n":72,"retest_window_bars":6,"reject_tolerance_atr":0.25}}))
A(S("S08","Failed Donchian reclaim","FAILED_RECLAIM",
    "Trades trapped longs after a failed recovery of the broken channel.",
    "Depends on a specific two-stage pattern; sparse.",
    entry={"rule":"FAILED_RECLAIM_DONCHIAN","timing":"NEXT_BAR_OPEN",
           "params":{"n":72,"reclaim_window_bars":8}}))
A(S("S09","Failed EMA20 reclaim","FAILED_RECLAIM",
    "Cleanest continuation pattern in an established downtrend.",
    "EMA20 is noisy on 1h; many shallow failures.",
    entry={"rule":"FAILED_RECLAIM_EMA","timing":"NEXT_BAR_OPEN",
           "params":{"ema":20,"reclaim_window_bars":6}}))
A(S("S10","Failed EMA50 reclaim","FAILED_RECLAIM",
    "Slower, higher-conviction rejection level.",
    "Entry far below the swing high; wide stop.",
    entry={"rule":"FAILED_RECLAIM_EMA","timing":"NEXT_BAR_OPEN",
           "params":{"ema":50,"reclaim_window_bars":8}}))
A(S("S11","Lower-high structural breakdown","STRUCTURE",
    "Uses swing structure rather than a fixed channel.",
    "Swing detection is lagging and parameter sensitive.",
    entry={"rule":"LOWER_HIGH_BREAKDOWN","timing":"NEXT_BAR_OPEN",
           "params":{"swing_lookback":12,"min_lower_highs":2}}))

# ---- Family C: momentum continuation ------------------------------------------
A(S("S12","Momentum continuation, no breakout","MOMENTUM",
    "Does not need a channel break, so it fires in grinding downtrends.",
    "No structural trigger; weakest entry precision.",
    entry={"rule":"MOMENTUM_CONTINUATION","timing":"NEXT_BAR_OPEN",
           "params":{"ret24_max_pct":-3.0,"require_ema_stack":True}}))
A(S("S13","Bearish EMA stack","EMA_STRUCTURE",
    "Trades only fully aligned downtrends (ema20<ema50<ema100).",
    "Alignment is a lagging condition; late entries.",
    entry={"rule":"EMA_STACK_BEARISH","timing":"NEXT_BAR_OPEN",
           "params":{"require_close_below":100,"min_separation_pct":0.15}}))
A(S("S14","Below-EMA100 pullback short","EMA_STRUCTURE",
    "Sells rallies into resistance rather than chasing lows.",
    "Counter-move entries can be run over in a squeeze.",
    entry={"rule":"EMA_PULLBACK_SHORT","timing":"NEXT_BAR_OPEN",
           "params":{"trend_ema":100,"pullback_ema":20,"max_pullback_atr":1.0}}))
A(S("S15","RSI momentum regime","MOMENTUM",
    "Pure momentum state; independent of price structure.",
    "RSI thresholds are regime dependent and can whipsaw.",
    entry={"rule":"RSI_MOMENTUM","timing":"NEXT_BAR_OPEN",
           "params":{"rsi_max":40,"rsi_falling_bars":3}},
    **F(rsi14_range=[0,40])))

# ---- Family D: volatility / volume --------------------------------------------
A(S("S16","Volume-expansion breakdown","VOLUME",
    "Requires real participation behind the break.",
    "High volume bars are often already extended.",
    **F(min_volume_ratio=2.50)))
A(S("S17","Squeeze then expansion","VOLATILITY",
    "Targets breaks out of compression, the classic high-payoff setup.",
    "Compression detection is sensitive to the percentile window.",
    entry={"rule":"SQUEEZE_EXPANSION_BREAKDOWN","timing":"NEXT_BAR_OPEN",
           "params":{"n":72,"squeeze_lookback":48,"squeeze_pct":30,
                     "expansion_atr_ratio":1.3}}))
A(S("S18","High-ATR regime only","VOLATILITY",
    "Concentrates on names that actually move enough to pay costs.",
    "High ATR also means wider stops and larger losses.",
    **F(atr_pct_range=[1.5,6.0])))
A(S("S19","Low-ATR regime only","VOLATILITY",
    "Tight stops keep per-trade risk small.",
    "Moves may not clear fees and funding.",
    **F(atr_pct_range=[0.15,1.0])))
A(S("S20","Breakdown, no volume gate","VOLUME",
    "Isolates the value of the production volume filter.",
    "Admits illiquid, low-participation breaks.",
    **F(min_volume_ratio=0.0)))

# ---- Family E: regime gating ---------------------------------------------------
A(S("S21","BTC bearish by magnitude","REGIME",
    "Demands the benchmark actually be down a set amount, not merely labelled BEAR, so a "
    "flat-but-technically-bearish tape does not qualify.",
    "Adds a second threshold on top of a categorical gate; can sit out shallow slides that "
    "still trend.",
    **R("BENCHMARK_BEAR_MAGNITUDE", benchmark="BTCUSDT", ret24_max_pct=-1.0)))
A(S("S22","ETH bearish regime required","REGIME",
    "ETH leads alt risk appetite more closely than BTC.",
    "Adds a second data dependency for little diversification.",
    **R("BENCHMARK_BEAR_ONLY", benchmark="ETHUSDT")))
A(S("S23","BTC and ETH both bearish","REGIME",
    "Strongest available market-wide confirmation.",
    "Very restrictive; may produce almost no trades.",
    **R("DUAL_BENCHMARK_BEAR", benchmarks=["BTCUSDT","ETHUSDT"])))
A(S("S24","Bearish breadth gate","REGIME",
    "Uses the whole universe rather than one proxy asset.",
    "Breadth is slow and can stay bearish through a bottom.",
    **R("BREADTH_BEAR", max_share_up=0.40, lookback_bars=1)))
A(S("S25","Regime-agnostic breakdown","REGIME",
    "Maximum signal count; measures the pure entry edge.",
    "No market guard at all; worst-case squeeze exposure.",
    **R("NONE")))

# ---- Family F: guards ----------------------------------------------------------
A(S("S26","Overextension guard","GUARD",
    "Refuses to sell what has already collapsed.",
    "Filters out the strongest trends along with the exhausted ones.",
    **F(overextension_max_abs_ret24_pct=15.0)))
A(S("S27","Extreme-mover guard","GUARD",
    "Avoids the top decliners where bounces are violent.",
    "Requires a cross-sectional rank each bar.",
    **F(extreme_mover_rank_guard=10)))
A(S("S28","Positive funding only","FUNDING",
    "Shorts are paid to hold; funding becomes a tailwind.",
    "Positive funding also marks crowded-long squeezes.",
    **F(funding_rate_min=0.0)))
A(S("S29","Extreme positive funding","FUNDING",
    "Targets the most crowded longs, where unwinds are largest.",
    "Rare; very few qualifying symbol-bars.",
    **F(funding_rate_min=0.0005)))
A(S("S30","Top-quartile liquidity only","LIQUIDITY",
    "Best fills and lowest realised slippage.",
    "Large caps trend less cleanly than small caps.",
    **F(min_quote_volume_percentile=75)))

# ---- Exit families: entry pinned to S01 ----------------------------------------
I46_ENTRY = {"rule":"I46_HYBRID_SCORE","params":{"min_score":5},
             "timing":"NEXT_BAR_OPEN","trigger_price":"NEXT_BAR_OPEN",
             "max_entry_gap_atr":0.50,"max_initial_risk_pct":5.0}
I46_REGIME = {"mode":"I46_BUILTIN","params":{"benchmark":"BTCUSDT",
                                             "ret24_min_directional":-0.50,
                                             "ret72_min_directional":-2.0}}


def E(sid, name, strength, risk, **patch):
    """Exit variants pin the entry to S01 -- the LIVE I46 entry -- so an exit effect is
    attributable rather than confounded with a different trade population, and so the
    result is directly actionable on the entry production actually uses."""
    patch.setdefault("entry", I46_ENTRY)
    patch.setdefault("regime", I46_REGIME)
    return S(sid, name, "EXIT_VARIANT", strength, risk, **patch)

A(E("S31","Fixed 1R target","Highest hit rate; fastest capital turnover.",
    "Cuts every large winner; payoff ratio below 1.",
    take_profit={"method":"R_MULTIPLE","r":1.0},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None}))
A(E("S32","Fixed 2R target","Balances hit rate against payoff.",
    "Still caps the tail that pays for the losers.",
    take_profit={"method":"R_MULTIPLE","r":2.0},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None}))
A(E("S33","Fixed 3R target","Keeps a meaningful tail with a defined exit.",
    "Fewer targets reached inside the 96-bar cap.",
    take_profit={"method":"R_MULTIPLE","r":3.0},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None}))
A(E("S34","Fixed 4R target","Closest fixed target to the production 5R.",
    "Low hit rate; heavy dependence on rare winners.",
    take_profit={"method":"R_MULTIPLE","r":4.0},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None}))
A(E("S35","ATR trailing only","Lets winners run with no fixed cap.",
    "Gives back open profit on every reversal.",
    take_profit={"method":"NONE","r":None},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"ATR","mult":2.50,"activation":"FAVORABLE_CLOSE_R_GT_0"}))
A(E("S36","Donchian reclaim exit","Exits on structural failure, not a fixed level.",
    "Reclaim can lag far behind the low.",
    take_profit={"method":"NONE","r":None},
    trailing={"method":"DONCHIAN","mult":None,"activation":"ALWAYS","n":20},
    rule_exits={"ema_reclaim":None,"donchian_reclaim_n":20,
                "momentum_reversal_rsi_above":None,"regime_reversal":False}))
A(E("S37","EMA20 reclaim exit only","Simplest trend-following exit.",
    "No stop discipline beyond the initial ATR stop.",
    take_profit={"method":"NONE","r":None},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None},
    rule_exits={"ema_reclaim":"EMA20","donchian_reclaim_n":None,
                "momentum_reversal_rsi_above":None,"regime_reversal":False}))
A(E("S38","EMA50 reclaim exit only","Holds through noise for the larger move.",
    "Very late exits; large give-back.",
    take_profit={"method":"NONE","r":None},
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0},
    trailing={"method":"NONE","mult":None,"activation":None},
    rule_exits={"ema_reclaim":"EMA50","donchian_reclaim_n":None,
                "momentum_reversal_rsi_above":None,"regime_reversal":False}))
A(E("S39","Swing-high stop","Stop sits at real structure, not a volatility guess.",
    "Swing highs can be far away, forcing tiny size.",
    stop={"method":"SWING_HIGH","lookback":12,"buffer_atr":0.25}))
A(E("S40","Tight 1.0 ATR stop","Small per-trade loss; more trades per unit risk.",
    "Stopped out by ordinary noise.",
    stop={"method":"ATR","mult":1.00}))
A(E("S41","Wide 3.0 ATR stop","Survives noise and holds the trend.",
    "Each loss is large; needs a high payoff to compensate.",
    stop={"method":"ATR","mult":3.00}))
A(E("S42","Partial 50% at 1R","Banks cost recovery early.",
    "Halves the position before the move develops.",
    partial_exit={"enabled":True,"at_r":1.0,"fraction":0.50}))
A(E("S43","Partial 30% at 3R","Keeps most of the position for the tail.",
    "Little protection if the move stalls before 3R.",
    partial_exit={"enabled":True,"at_r":3.0,"fraction":0.30}))
A(E("S44","No partial, pure runner to 5R","Maximum exposure to the winning tail.",
    "Full give-back on any trade that reverses before target.",
    partial_exit={"enabled":False,"at_r":None,"fraction":0.0}))
A(E("S45","Time stop at 12 bars","Frees slots fast; high capital velocity.",
    "Cuts trends that need more than half a day.",
    max_holding_bars=12, loss_time_stop_bars=12))
A(E("S46","Time stop at 48 bars","Gives the thesis two full days.",
    "Slots occupied by dead trades.",
    max_holding_bars=48, loss_time_stop_bars=24))
A(E("S47","Momentum-reversal exit","Exits when the driving momentum is gone.",
    "RSI can recross repeatedly in chop.",
    rule_exits={"ema_reclaim":None,"donchian_reclaim_n":None,
                "momentum_reversal_rsi_above":50,"regime_reversal":False}))
A(E("S48","Regime-reversal exit","Closes the book when the market flips.",
    "One benchmark flip closes every position at once.",
    rule_exits={"ema_reclaim":"EMA20","donchian_reclaim_n":None,
                "momentum_reversal_rsi_above":None,"regime_reversal":True}))
A(E("S49","Volatility-scaled trailing","Trail adapts to the current ATR regime.",
    "Extra parameter; can loosen exactly when it should tighten.",
    take_profit={"method":"NONE","r":None},
    trailing={"method":"VOL_SCALED","mult":2.50,"activation":"FAVORABLE_CLOSE_R_GT_0",
              "atr_percentile_lookback":48,"low_vol_mult":1.5,"high_vol_mult":3.5}))
A(E("S50","Mixed exit stack","Combines every protective mechanism under test.",
    "Most complex; hardest to attribute and most overfit-prone.",
    breakeven={"enabled":True,"at_r":1.0,"cost_stress_multiple":1.5},
    partial_exit={"enabled":True,"at_r":2.0,"fraction":0.40},
    trailing={"method":"DONCHIAN","mult":None,"activation":"FAVORABLE_CLOSE_R_GT_0","n":20},
    rule_exits={"ema_reclaim":"EMA20","donchian_reclaim_n":20,
                "momentum_reversal_rsi_above":None,"regime_reversal":False}))

assert len(X) == 50, len(X)
assert [s["strategy_id"] for s in X] == [f"S{i:02d}" for i in range(1, 51)]

doc = {
    "schema_version": "1.0.0",
    "frozen": True,
    "frozen_before_any_market_data_loaded": True,
    "side": "SHORT",
    "venue": "binance_futures",
    "derived_from": {
        "live_entry_strategy_key": "I46_HYBRID_SCORE_L1",
        "live_entry_revision": "I46-LIVE-1.0.0",
        "live_exit_execution_config_key": "P10_DONCHIAN_BREAKOUT_E10_SLOW_4R",
        "live_exit_policy": "P10_PRODUCTION_FIXED_5R_STOP2ATR_TRAIL2P5_"
                            "PARTIAL2R40_BE1P5_EMA20_LOSS24_MAX96",
        "retired_entry_strategy_key": "P10_DONCHIAN_BREAKOUT_E10_SLOW_4R",
        "retired_on": "2026-08-22",
        "signal_producer": {"edge_function": "market-v2-signal", "version": 8,
                            "ezbr_sha256": "567427c0686080d0574858c81470582049e0f33f"
                                           "b607c6afcc8e"},
        "executor": {"edge_function": "market-autotrader", "version": 360,
                     "ezbr_sha256": "c0f59c6de0e751f8943d32348289e40ae8a29690b3d29"
                                    "1998f0fd52a58b9d0de"},
    },
    "shared_execution_assumptions": {
        "margin_per_slot_usdt": 60, "leverage": 3,
        "max_open_positions_per_exchange": 10, "max_new_entries_per_scan": 3,
        "shared_slot_pool_with_long": True,
        "taker_fee_pct_per_side": 0.05, "slippage_bps_per_side": 5,
        "funding_applied": True, "entry_timing_default": "NEXT_BAR_OPEN",
        "same_bar_stop_and_target_rule": "STOP_FIRST",
    },
    "strategies": X,
}
out = pathlib.Path(__file__).resolve().parents[1]
p = out / "strategy_definitions.json"
blob = json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False)
p.write_text(blob + "\n")
h = hashlib.sha256((blob + "\n").encode()).hexdigest()
(out / "strategy_definitions_hash.txt").write_text(h + "  strategy_definitions.json\n")
fams = {}
for s in X: fams[s["family"]] = fams.get(s["family"], 0) + 1
print("strategies:", len(X))
print("families:", fams)
print("sha256:", h)
