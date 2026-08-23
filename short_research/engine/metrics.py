"""Per-strategy metrics. Drawdown is measured on the time-ordered equity curve of realised
net PnL, not on per-trade returns, so overlapping positions are reflected in the order they
actually closed."""
from __future__ import annotations
import math, statistics
from typing import Sequence


def _median(v: Sequence[float]) -> float:
    return statistics.median(v) if v else 0.0


def compute(strategy_id: str, trades: list, signals: int, capital: float,
            rejected: dict | None = None) -> dict:
    n = len(trades)
    if n == 0:
        base = dict.fromkeys(
            ["trades","wins","losses","win_rate","gross_pnl","fees","funding","slippage",
             "net_pnl","return_pct","avg_return_trade_pct","median_return_trade_pct",
             "profit_factor","expectancy","max_drawdown","best_trade","worst_trade",
             "avg_mfe_r","avg_mae_r","mfe_mae","avg_hold_bars","median_hold_bars",
             "max_hold_bars","max_losing_streak","max_winning_streak",
             "symbol_concentration","top1_contribution","top5_contribution",
             "fee_share_gross_profit","sharpe_like","sortino_like","downside_deviation"], 0.0)
        base.update(strategy_id=strategy_id, signals=signals,
                    rejected=rejected or {}, symbols=0)
        return base

    net = [t.net_pnl for t in trades]
    wins = [x for x in net if x > 0]
    losses = [x for x in net if x <= 0]
    gross_profit = sum(wins)
    gross_loss = -sum(losses)
    fees = sum(t.fees for t in trades)
    funding = sum(t.funding for t in trades)
    slippage = sum(t.slippage_cost for t in trades)
    total = sum(net)
    rets = [t.return_pct_on_margin for t in trades]

    ordered = sorted(trades, key=lambda t: t.exit_time)
    eq, peak, mdd = 0.0, 0.0, 0.0
    for t in ordered:
        eq += t.net_pnl
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)

    streak_l = worst_l = streak_w = best_w = 0
    for t in ordered:
        if t.net_pnl > 0:
            streak_w += 1; streak_l = 0
        else:
            streak_l += 1; streak_w = 0
        worst_l = max(worst_l, streak_l); best_w = max(best_w, streak_w)

    by_symbol: dict[str, float] = {}
    for t in trades:
        by_symbol[t.symbol] = by_symbol.get(t.symbol, 0.0) + t.net_pnl
    pos = sorted((v for v in by_symbol.values() if v > 0), reverse=True)
    total_pos = sum(pos) or 1.0

    sd = statistics.pstdev(rets) if len(rets) > 1 else 0.0
    downside = [r for r in rets if r < 0]
    dd = statistics.pstdev(downside) if len(downside) > 1 else 0.0
    mean_r = sum(rets) / len(rets)

    return dict(
        strategy_id=strategy_id, signals=signals, trades=n,
        wins=len(wins), losses=len(losses), win_rate=len(wins) / n * 100.0,
        gross_pnl=sum(t.gross_pnl for t in trades), fees=fees, funding=funding,
        slippage=slippage, net_pnl=total, return_pct=total / capital * 100.0,
        avg_return_trade_pct=mean_r, median_return_trade_pct=_median(rets),
        profit_factor=(gross_profit / gross_loss) if gross_loss > 0
                      else (float("inf") if gross_profit > 0 else 0.0),
        expectancy=total / n, max_drawdown=mdd,
        best_trade=max(net), worst_trade=min(net),
        avg_mfe_r=sum(t.mfe_r for t in trades) / n,
        avg_mae_r=sum(t.mae_r for t in trades) / n,
        mfe_mae=(sum(t.mfe_r for t in trades) / max(1e-9, sum(t.mae_r for t in trades))),
        avg_hold_bars=sum(t.holding_bars for t in trades) / n,
        median_hold_bars=_median([t.holding_bars for t in trades]),
        max_hold_bars=max(t.holding_bars for t in trades),
        max_losing_streak=worst_l, max_winning_streak=best_w,
        symbols=len(by_symbol),
        symbol_concentration=len(by_symbol) / n,
        top1_contribution=(pos[0] / total_pos * 100.0) if pos else 0.0,
        top5_contribution=(sum(pos[:5]) / total_pos * 100.0) if pos else 0.0,
        fee_share_gross_profit=(fees / gross_profit * 100.0) if gross_profit > 0 else 0.0,
        sharpe_like=(mean_r / sd) if sd > 0 else 0.0,
        sortino_like=(mean_r / dd) if dd > 0 else 0.0,
        downside_deviation=dd,
        rejected=rejected or {},
    )
