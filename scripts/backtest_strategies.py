#!/usr/bin/env python3
"""Backtest simple top-of-book strategy families on collected snapshots."""

from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import median


def num(row: dict[str, str], key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except ValueError:
        return 0.0


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def tradeable(row: dict[str, str], min_volume: float, max_spread: float) -> bool:
    title = row.get("title", "").lower()
    yes = num(row, "yes_price")
    no = num(row, "no_price")
    if "completed match" in title or "completed game" in title:
        return False
    if abs(yes - 0.5) < 1e-9 and abs(no - 0.5) < 1e-9:
        return False
    if not (0.02 <= yes <= 0.98 and 0.02 <= no <= 0.98):
        return False
    return num(row, "volume") >= min_volume and num(row, "spread_pct") <= max_spread


@dataclass(frozen=True)
class Config:
    name: str
    mode: str
    lookback: int
    horizon: int
    threshold: float
    min_volume: float
    max_spread: float
    stake: float
    wide_spread: float = 12.0


@dataclass
class Trade:
    strategy: str
    category: str
    title: str
    opened: datetime
    side: str
    entry: float
    exit: float
    pnl: float
    ret: float


def load_grouped(path: Path) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if num(row, "yes_price") > 0 and num(row, "no_price") > 0:
                grouped[row["id"]].append(row)
    for rows in grouped.values():
        rows.sort(key=lambda r: int(r["scan_id"]))
    return grouped


def side_for_signal(rows: list[dict[str, str]], idx: int, cfg: Config) -> str | None:
    row = rows[idx]
    prev = rows[idx - cfg.lookback]
    delta = num(row, "yes_price") - num(prev, "yes_price")
    if cfg.mode in {"momentum", "fade"}:
        if abs(delta) < cfg.threshold:
            return None
        follow = "YES" if delta > 0 else "NO"
        return follow if cfg.mode == "momentum" else ("NO" if follow == "YES" else "YES")
    if cfg.mode in {"compression_follow", "compression_fade"}:
        old_spreads = [num(r, "spread_pct") for r in rows[max(0, idx - 12): idx - 2]]
        if not old_spreads or median(old_spreads) < cfg.wide_spread:
            return None
        if num(row, "spread_pct") > cfg.max_spread or abs(delta) < cfg.threshold:
            return None
        follow = "YES" if delta > 0 else "NO"
        return follow if cfg.mode == "compression_follow" else ("NO" if follow == "YES" else "YES")
    raise ValueError(f"Unknown mode: {cfg.mode}")


def price_trade(row: dict[str, str], future: dict[str, str], side: str, stake: float) -> tuple[float, float, float, float] | None:
    if side == "YES":
        entry = num(row, "yes_price")
        exit_bid = 1.0 - num(future, "no_price")
    else:
        entry = num(row, "no_price")
        exit_bid = 1.0 - num(future, "yes_price")
    if not (0.02 <= entry <= 0.98):
        return None
    exit_bid = min(1.0, max(0.0, exit_bid))
    pnl_per_share = exit_bid - entry
    shares = stake / entry
    pnl = pnl_per_share * shares
    return entry, exit_bid, pnl, pnl / stake


def run_strategy(grouped: dict[str, list[dict[str, str]]], cfg: Config) -> list[Trade]:
    trades: list[Trade] = []
    for rows in grouped.values():
        idx = cfg.lookback
        last_entry_idx = -cfg.horizon
        while idx + cfg.horizon < len(rows):
            row = rows[idx]
            if idx - last_entry_idx < cfg.horizon or not tradeable(row, cfg.min_volume, cfg.max_spread):
                idx += 1
                continue
            side = side_for_signal(rows, idx, cfg)
            if side is None:
                idx += 1
                continue
            future = rows[idx + cfg.horizon]
            priced = price_trade(row, future, side, cfg.stake)
            if priced is None:
                idx += 1
                continue
            entry, exit_bid, pnl, ret = priced
            trades.append(Trade(cfg.name, row["category"], row["title"], parse_time(row["timestamp"]), side, entry, exit_bid, pnl, ret))
            last_entry_idx = idx
            idx += cfg.horizon
    trades.sort(key=lambda t: t.opened)
    return trades


def summarize(trades: list[Trade]) -> dict[str, float]:
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    wins = 0
    gross_profit = 0.0
    gross_loss = 0.0
    returns = []
    for trade in trades:
        equity += trade.pnl
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
        returns.append(trade.ret)
        if trade.pnl > 0:
            wins += 1
            gross_profit += trade.pnl
        else:
            gross_loss += abs(trade.pnl)
    avg = sum(returns) / len(returns) if returns else 0.0
    var = sum((r - avg) ** 2 for r in returns) / len(returns) if returns else 0.0
    return {
        "trades": len(trades),
        "pnl": equity,
        "avg_return": avg,
        "win_rate": wins / len(trades) if trades else 0.0,
        "profit_factor": gross_profit / gross_loss if gross_loss else math.inf,
        "max_drawdown": abs(max_dd),
        "risk_score": abs(max_dd) / gross_profit if gross_profit else math.inf,
        "sharpe_proxy": avg / math.sqrt(var) if var > 0 else 0.0,
    }


def category_table(trades: list[Trade], limit: int = 8) -> list[str]:
    grouped: dict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        grouped[trade.category].append(trade)
    rows = []
    for cat, cat_trades in grouped.items():
        stats = summarize(cat_trades)
        if stats["trades"] >= 5:
            rows.append((stats["pnl"], cat, stats))
    rows.sort(reverse=True)
    return [
        f"  - {cat}: trades={int(s['trades'])} pnl={s['pnl']:.2f} "
        f"win={s['win_rate']:.1%} pf={s['profit_factor']:.2f}"
        for _, cat, s in rows[:limit]
    ]


def render(configs: list[Config], results: dict[str, list[Trade]]) -> str:
    lines = ["# Strategy Backtest Report", ""]
    lines.append("Assumption: buy at YES/NO ask; exit at synthetic bid `1 - opposite_ask` after the horizon.")
    lines.append("This penalizes spread, but it is still a top-of-book paper model, not a fill/depth simulation.")
    lines.append("")
    lines.append("| Strategy | Trades | PnL | Avg Return | Win Rate | Profit Factor | Max Drawdown | Risk Score | Sharpe Proxy |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for cfg in configs:
        stats = summarize(results[cfg.name])
        pf = "inf" if math.isinf(stats["profit_factor"]) else f"{stats['profit_factor']:.2f}"
        risk = "inf" if math.isinf(stats["risk_score"]) else f"{stats['risk_score']:.2f}"
        lines.append(
            f"| {cfg.name} | {int(stats['trades'])} | {stats['pnl']:.2f} | "
            f"{stats['avg_return']:.2%} | {stats['win_rate']:.1%} | {pf} | "
            f"{stats['max_drawdown']:.2f} | {risk} | {stats['sharpe_proxy']:.2f} |"
        )
    lines.append("")
    for cfg in configs:
        trades = results[cfg.name]
        lines.append(f"## {cfg.name}")
        lines.extend(category_table(trades))
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("data/all-polymarket-20260512T171924Z/market-snapshots.csv"))
    parser.add_argument("--out", type=Path, default=Path("data/strategy-backtest-latest.md"))
    parser.add_argument("--stake", type=float, default=10.0)
    args = parser.parse_args()
    configs = [
        Config("momentum_30m", "momentum", 6, 6, 0.08, 100, 8, args.stake),
        Config("fade_30m", "fade", 6, 6, 0.08, 100, 8, args.stake),
        Config("momentum_60m", "momentum", 12, 12, 0.12, 100, 8, args.stake),
        Config("fade_60m", "fade", 12, 12, 0.12, 100, 8, args.stake),
        Config("compression_follow", "compression_follow", 6, 6, 0.05, 100, 3, args.stake),
        Config("compression_fade", "compression_fade", 6, 6, 0.05, 100, 3, args.stake),
    ]
    grouped = load_grouped(args.csv)
    results = {cfg.name: run_strategy(grouped, cfg) for cfg in configs}
    report = render(configs, results)
    args.out.write_text(report + "\n")
    print(report)


if __name__ == "__main__":
    main()
