#!/usr/bin/env python3
"""
Analyze stats CSV (overnight.csv) and generate quick plots.

Usage:
  python scripts/analyze_stats.py --csv overnight.csv --out-dir plots
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import List

import matplotlib.pyplot as plt
import pandas as pd


def load(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def threshold_cols(df: pd.DataFrame) -> List[str]:
    return [c for c in df.columns if c.startswith("hits_le_")]


def latest_symbol_snapshot(df: pd.DataFrame) -> pd.DataFrame:
    symbols = df[df["row_type"] == "symbol"].copy()
    if symbols.empty:
        return symbols
    symbols = symbols.sort_values("timestamp")
    return symbols.groupby("symbol").tail(1).reset_index(drop=True)


def print_summary(df: pd.DataFrame) -> None:
    th_cols = threshold_cols(df)
    all_rows = df[df["row_type"] == "all"].sort_values("timestamp")
    sym_rows = df[df["row_type"] == "symbol"].sort_values("timestamp")

    print(f"Total rows: {len(df)}, thresholds: {', '.join(th_cols)}")
    if not df.empty:
        print(f"Time span: {df['timestamp'].min()} → {df['timestamp'].max()}")

    latest_all = all_rows.tail(1)
    if not latest_all.empty:
        row = latest_all.iloc[0]
        print("\nLatest aggregate:")
        print(f"  samples={row['samples']}")
        for c in th_cols:
            hit = row[c]
            rate = (hit / row["samples"]) * 100 if row["samples"] else 0
            print(f"  {c}: {hit} ({rate:.2f}%)")

    latest_sym = latest_symbol_snapshot(df)
    if not latest_sym.empty:
        print("\nLatest per-symbol:")
        for _, r in latest_sym.iterrows():
            print(f"  {r['symbol']}: samples={r['samples']}", end="")
            for c in th_cols:
                hit = r[c]
                rate = (hit / r["samples"]) * 100 if r["samples"] else 0
                print(f", {c}={hit} ({rate:.2f}%)", end="")
            print("")


def plot_samples_over_time(sym_rows: pd.DataFrame, out_dir: Path) -> None:
    if sym_rows.empty:
        return
    plt.figure(figsize=(8, 4))
    for sym, grp in sym_rows.groupby("symbol"):
        plt.plot(grp["timestamp"], grp["samples"], label=sym)
    plt.title("Samples over time (per symbol)")
    plt.xlabel("timestamp")
    plt.ylabel("samples")
    plt.legend()
    plt.tight_layout()
    out_path = out_dir / "samples_over_time.png"
    plt.savefig(out_path)
    plt.close()


def plot_hit_rates(latest_sym: pd.DataFrame, out_dir: Path) -> None:
    if latest_sym.empty:
        return
    th_cols = threshold_cols(latest_sym)
    symbols = latest_sym["symbol"].tolist()
    x = range(len(symbols))

    plt.figure(figsize=(10, 5))
    width = 0.1
    for idx, c in enumerate(th_cols):
        rates = [
            ((latest_sym.iloc[i][c] / latest_sym.iloc[i]["samples"]) * 100) if latest_sym.iloc[i]["samples"] else 0
            for i in range(len(symbols))
        ]
        offsets = [i + (idx - len(th_cols) / 2) * width for i in x]
        plt.bar(offsets, rates, width=width, label=c)

    plt.title("Hit rates per symbol (latest snapshot)")
    plt.xlabel("symbol")
    plt.ylabel("hit rate (%)")
    plt.xticks(list(x), symbols)
    plt.legend()
    plt.tight_layout()
    out_path = out_dir / "hit_rates_per_symbol.png"
    plt.savefig(out_path)
    plt.close()


def plot_hit_counts_over_time(all_rows: pd.DataFrame, out_dir: Path) -> None:
    if all_rows.empty:
        return
    th_cols = threshold_cols(all_rows)
    plt.figure(figsize=(8, 4))
    for c in th_cols:
        plt.plot(all_rows["timestamp"], all_rows[c], label=c)
    plt.title("Aggregate hit counts over time")
    plt.xlabel("timestamp")
    plt.ylabel("hits (cumulative)")
    plt.legend()
    plt.tight_layout()
    out_path = out_dir / "aggregate_hits_over_time.png"
    plt.savefig(out_path)
    plt.close()


def plot_market_inefficiency(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """
    Plot showing what % of price updates had combined < threshold.
    This highlights market inefficiency - when combined YES+NO asks < 1,
    there's a guaranteed profit opportunity (before fees).
    """
    if all_rows.empty:
        return
    
    th_cols = threshold_cols(all_rows)
    latest = all_rows.iloc[-1]
    samples = latest["samples"]
    
    if samples == 0:
        return
    
    # Calculate hit rates for each threshold
    thresholds = []
    rates = []
    for c in th_cols:
        th_val = float(c.replace("hits_le_", ""))
        hit_rate = (latest[c] / samples) * 100
        thresholds.append(th_val)
        rates.append(hit_rate)
    
    # Sort by threshold value
    sorted_data = sorted(zip(thresholds, rates), key=lambda x: x[0])
    thresholds, rates = zip(*sorted_data)
    
    # Create bar chart
    fig, ax = plt.subplots(figsize=(10, 6))
    colors = plt.cm.RdYlGn_r([r / max(rates) if max(rates) > 0 else 0 for r in rates])
    bars = ax.bar([f"≤{t}" for t in thresholds], rates, color=colors, edgecolor="black", linewidth=0.5)
    
    # Add value labels on bars
    for bar, rate in zip(bars, rates):
        height = bar.get_height()
        ax.annotate(f'{rate:.2f}%',
                    xy=(bar.get_x() + bar.get_width() / 2, height),
                    xytext=(0, 3),
                    textcoords="offset points",
                    ha='center', va='bottom', fontsize=9, fontweight='bold')
    
    ax.set_xlabel("Combined Price Threshold (YES ask + NO ask)", fontsize=11)
    ax.set_ylabel("% of Price Updates Below Threshold", fontsize=11)
    ax.set_title("Polymarket Crypto 15m Markets: Price Inefficiency Analysis\n"
                 f"({samples:,} price updates analyzed)", fontsize=12, fontweight='bold')
    
    # Add annotation explaining the insight
    ax.text(0.02, 0.98, 
            "Combined < 1.0 = Arbitrage opportunity (before fees)\n"
            "Lower combined = Higher edge / more inefficient",
            transform=ax.transAxes, fontsize=9, verticalalignment='top',
            bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))
    
    plt.tight_layout()
    out_path = out_dir / "market_inefficiency.png"
    plt.savefig(out_path, dpi=150)
    plt.close()
    print(f"  Saved: {out_path}")


def plot_inefficiency_by_symbol(latest_sym: pd.DataFrame, out_dir: Path) -> None:
    """
    Bar chart comparing inefficiency (hits ≤1) across symbols.
    """
    if latest_sym.empty:
        return
    
    th_cols = threshold_cols(latest_sym)
    # Find the ≤1 column
    col_1 = [c for c in th_cols if "1" in c and "0.9" not in c]
    if not col_1:
        col_1 = th_cols[-1]  # Use highest threshold
    else:
        col_1 = col_1[0]
    
    symbols = latest_sym["symbol"].tolist()
    rates = []
    for _, row in latest_sym.iterrows():
        rate = (row[col_1] / row["samples"]) * 100 if row["samples"] else 0
        rates.append(rate)
    
    # Sort by rate descending
    sorted_data = sorted(zip(symbols, rates), key=lambda x: x[1], reverse=True)
    symbols, rates = zip(*sorted_data)
    
    fig, ax = plt.subplots(figsize=(8, 5))
    colors = plt.cm.Blues([0.4 + 0.6 * (r / max(rates)) if max(rates) > 0 else 0.5 for r in rates])
    bars = ax.barh(symbols, rates, color=colors, edgecolor="black", linewidth=0.5)
    
    for bar, rate in zip(bars, rates):
        width = bar.get_width()
        ax.annotate(f'{rate:.2f}%',
                    xy=(width, bar.get_y() + bar.get_height() / 2),
                    xytext=(3, 0),
                    textcoords="offset points",
                    ha='left', va='center', fontsize=9)
    
    ax.set_xlabel(f"% of Updates with Combined ≤ 1.0", fontsize=11)
    ax.set_ylabel("Crypto Symbol", fontsize=11)
    ax.set_title("Market Inefficiency by Symbol\n(Higher = More Arbitrage Opportunities)", 
                 fontsize=12, fontweight='bold')
    
    plt.tight_layout()
    out_path = out_dir / "inefficiency_by_symbol.png"
    plt.savefig(out_path, dpi=150)
    plt.close()
    print(f"  Saved: {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze stats CSV.")
    parser.add_argument("--csv", type=Path, default=Path("overnight.csv"))
    parser.add_argument("--out-dir", type=Path, default=Path("plots"))
    args = parser.parse_args()

    if not args.csv.exists():
        raise SystemExit(f"CSV not found: {args.csv}")

    os.makedirs(args.out_dir, exist_ok=True)

    df = load(args.csv)
    print_summary(df)

    all_rows = df[df["row_type"] == "all"].sort_values("timestamp")
    sym_rows = df[df["row_type"] == "symbol"].sort_values("timestamp")
    latest_sym = latest_symbol_snapshot(df)

    plot_samples_over_time(sym_rows, args.out_dir)
    plot_hit_counts_over_time(all_rows, args.out_dir)
    plot_hit_rates(latest_sym, args.out_dir)
    plot_market_inefficiency(all_rows, args.out_dir)
    plot_inefficiency_by_symbol(latest_sym, args.out_dir)

    print(f"\nPlots saved to: {args.out_dir.resolve()}")


if __name__ == "__main__":
    main()
