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
import matplotlib as mpl
import pandas as pd

# DeepSeek paper style configuration
def setup_deepseek_style():
    """Configure matplotlib to match DeepSeek paper chart aesthetics."""
    plt.rcParams.update({
        'font.family': 'sans-serif',
        'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
        'font.size': 10,
        'axes.titlesize': 12,
        'axes.titleweight': 'bold',
        'axes.labelsize': 10,
        'axes.spines.top': False,
        'axes.spines.right': False,
        'axes.spines.left': True,
        'axes.spines.bottom': True,
        'axes.linewidth': 0.8,
        'axes.edgecolor': '#333333',
        'xtick.labelsize': 9,
        'ytick.labelsize': 9,
        'legend.fontsize': 8,
        'legend.frameon': True,
        'legend.edgecolor': '#cccccc',
        'legend.fancybox': False,
        'figure.facecolor': 'white',
        'axes.facecolor': 'white',
        'axes.grid': True,
        'grid.alpha': 0.3,
        'grid.linestyle': '-',
        'grid.linewidth': 0.5,
        'grid.color': '#cccccc',
    })

# DeepSeek-style blue palette (light to medium blues)
DEEPSEEK_COLORS = [
    '#1a3a5c',  # dark navy
    '#2d5a87',  # medium navy  
    '#4a7fb8',  # medium blue
    '#6b9fd4',  # light blue
    '#8bbde8',  # lighter blue
    '#acd4f4',  # very light blue
    '#cce7fc',  # pale blue
]


def load(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def threshold_cols(df: pd.DataFrame) -> List[str]:
    return [c for c in df.columns if c.startswith("hits_le_")]


def avg_yes_cols(df: pd.DataFrame) -> List[str]:
    return [c for c in df.columns if c.startswith("avg_yes_le_")]


def avg_no_cols(df: pd.DataFrame) -> List[str]:
    return [c for c in df.columns if c.startswith("avg_no_le_")]


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

    # Print average price summary if available
    yes_cols = avg_yes_cols(df)
    no_cols = avg_no_cols(df)
    if yes_cols and not latest_all.empty:
        row = latest_all.iloc[0]
        print("\nAverage Prices (when threshold hit):")
        for yc, nc in zip(yes_cols, no_cols):
            th = yc.replace("avg_yes_le_", "")
            avg_yes = row[yc] if pd.notna(row[yc]) else None
            avg_no = row[nc] if pd.notna(row[nc]) else None
            if avg_yes is not None and avg_no is not None:
                print(f"  ≤{th}: avg_yes={avg_yes:.4f}, avg_no={avg_no:.4f}, combined={avg_yes+avg_no:.4f}")


def plot_hit_rates(latest_sym: pd.DataFrame, out_dir: Path) -> None:
    """DeepSeek-style grouped bar chart for hit rates by symbol."""
    if latest_sym.empty:
        return
    
    setup_deepseek_style()
    th_cols = threshold_cols(latest_sym)
    symbols = latest_sym["symbol"].tolist()
    n_symbols = len(symbols)
    n_thresholds = len(th_cols)
    
    fig, ax = plt.subplots(figsize=(12, 5))
    
    # Bar positioning like DeepSeek paper
    bar_width = 0.8 / n_thresholds
    x = range(n_symbols)
    
    # Create grouped bars
    for idx, c in enumerate(th_cols):
        rates = [
            ((latest_sym.iloc[i][c] / latest_sym.iloc[i]["samples"]) * 100) if latest_sym.iloc[i]["samples"] else 0
            for i in range(n_symbols)
        ]
        offset = (idx - n_thresholds / 2 + 0.5) * bar_width
        positions = [i + offset for i in x]
        ax.bar(positions, rates, width=bar_width * 0.9, 
               label=c.replace('hits_le_', '≤'), 
               color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)],
               edgecolor='none')
    
    # Styling
    ax.set_xlabel("")
    ax.set_ylabel("Hit Rate (%)")
    ax.set_xticks(list(x))
    ax.set_xticklabels(symbols)
    ax.set_ylim(bottom=0)
    ax.yaxis.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    
    # Legend at top like DeepSeek
    ax.legend(title="Threshold", loc='upper center', bbox_to_anchor=(0.5, 1.15),
              ncol=n_thresholds, frameon=True, edgecolor='#cccccc')
    
    # Title below figure
    fig.suptitle("Figure 1: Hit Rates by Symbol & Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.92])
    out_path = out_dir / "hit_rates_per_symbol.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_market_inefficiency(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """DeepSeek-style bar chart for market inefficiency analysis."""
    if all_rows.empty:
        return
    
    setup_deepseek_style()
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
    
    fig, ax = plt.subplots(figsize=(10, 5))
    n_bars = len(rates)
    
    # Use DeepSeek color palette
    colors = DEEPSEEK_COLORS[:n_bars] if n_bars <= len(DEEPSEEK_COLORS) else DEEPSEEK_COLORS
    x_labels = [f"≤{t}" for t in thresholds]
    bars = ax.bar(x_labels, rates, color=colors, edgecolor='none', width=0.7)
    
    # Styling
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("% of Updates")
    ax.set_ylim(bottom=0)
    ax.yaxis.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    
    # Legend at top
    legend_labels = [f"≤{t}: {r:.1f}%" for t, r in zip(thresholds, rates)]
    ax.legend(bars, legend_labels, loc='upper center', bbox_to_anchor=(0.5, 1.12),
              ncol=min(4, n_bars), frameon=True, edgecolor='#cccccc')
    
    # Caption below
    fig.suptitle(f"Figure 2: Price Inefficiency Analysis ({samples:,} samples)", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.90])
    out_path = out_dir / "market_inefficiency.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_inefficiency_by_symbol(latest_sym: pd.DataFrame, out_dir: Path) -> None:
    """DeepSeek-style horizontal bar chart for inefficiency by symbol."""
    if latest_sym.empty:
        return
    
    setup_deepseek_style()
    th_cols = threshold_cols(latest_sym)
    
    # Find the ≤1 column
    col_1 = [c for c in th_cols if "1" in c and "0.9" not in c]
    if not col_1:
        col_1 = th_cols[-1]
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
    
    fig, ax = plt.subplots(figsize=(10, 5))
    n_bars = len(rates)
    
    # Assign colors from palette based on position
    colors = [DEEPSEEK_COLORS[i % len(DEEPSEEK_COLORS)] for i in range(n_bars)]
    
    bars = ax.barh(symbols, rates, color=colors, edgecolor='none', height=0.7)
    
    # Styling
    ax.set_xlabel("% of Updates (Combined ≤ 1.0)")
    ax.set_ylabel("")
    ax.set_xlim(left=0)
    ax.xaxis.grid(True, alpha=0.3, linestyle='-', linewidth=0.5)
    ax.yaxis.grid(False)
    ax.set_axisbelow(True)
    ax.invert_yaxis()  # Highest at top
    
    # Caption below
    fig.suptitle("Figure 3: Market Inefficiency by Symbol", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.98])
    out_path = out_dir / "inefficiency_by_symbol.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_avg_prices_by_threshold(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """Bar chart showing average YES/NO prices when each threshold is hit."""
    if all_rows.empty:
        return
    
    yes_cols = avg_yes_cols(all_rows)
    no_cols = avg_no_cols(all_rows)
    if not yes_cols:
        return
    
    setup_deepseek_style()
    latest = all_rows.iloc[-1]
    
    thresholds = []
    avg_yes_vals = []
    avg_no_vals = []
    
    for yc, nc in zip(yes_cols, no_cols):
        th = float(yc.replace("avg_yes_le_", ""))
        avg_yes = latest[yc] if pd.notna(latest[yc]) else None
        avg_no = latest[nc] if pd.notna(latest[nc]) else None
        if avg_yes is not None and avg_no is not None:
            thresholds.append(th)
            avg_yes_vals.append(avg_yes)
            avg_no_vals.append(avg_no)
    
    if not thresholds:
        return
    
    # Sort by threshold
    sorted_data = sorted(zip(thresholds, avg_yes_vals, avg_no_vals), key=lambda x: x[0])
    thresholds, avg_yes_vals, avg_no_vals = zip(*sorted_data)
    
    fig, ax = plt.subplots(figsize=(12, 5))
    x = range(len(thresholds))
    bar_width = 0.35
    
    bars_yes = ax.bar([i - bar_width/2 for i in x], avg_yes_vals, bar_width, 
                       label='Avg YES Price', color=DEEPSEEK_COLORS[0])
    bars_no = ax.bar([i + bar_width/2 for i in x], avg_no_vals, bar_width,
                      label='Avg NO Price', color=DEEPSEEK_COLORS[3])
    
    # Add 0.50 reference line
    ax.axhline(y=0.50, color='red', linestyle='--', alpha=0.5, label='0.50 threshold')
    
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("Average Price")
    ax.set_xticks(list(x))
    ax.set_xticklabels([f"≤{t}" for t in thresholds])
    ax.set_ylim(0, 1)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.legend(loc='upper center', bbox_to_anchor=(0.5, 1.12), ncol=3)
    
    fig.suptitle("Figure 4: Average YES/NO Prices by Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.90])
    out_path = out_dir / "avg_prices_by_threshold.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_avg_prices_by_symbol(latest_sym: pd.DataFrame, out_dir: Path) -> None:
    """Grouped bar chart showing avg YES/NO prices per symbol at key thresholds."""
    if latest_sym.empty:
        return
    
    yes_cols = avg_yes_cols(latest_sym)
    no_cols = avg_no_cols(latest_sym)
    if not yes_cols:
        return
    
    setup_deepseek_style()
    
    # Use ≤1.0 threshold (most common)
    yc_1 = [c for c in yes_cols if c.endswith("_1")]
    nc_1 = [c for c in no_cols if c.endswith("_1")]
    if not yc_1:
        yc_1, nc_1 = yes_cols[-1], no_cols[-1]
    else:
        yc_1, nc_1 = yc_1[0], nc_1[0]
    
    symbols = []
    avg_yes_vals = []
    avg_no_vals = []
    
    for _, row in latest_sym.iterrows():
        avg_yes = row[yc_1] if pd.notna(row[yc_1]) else None
        avg_no = row[nc_1] if pd.notna(row[nc_1]) else None
        if avg_yes is not None and avg_no is not None:
            symbols.append(row['symbol'])
            avg_yes_vals.append(avg_yes)
            avg_no_vals.append(avg_no)
    
    if not symbols:
        return
    
    fig, ax = plt.subplots(figsize=(10, 5))
    x = range(len(symbols))
    bar_width = 0.35
    
    bars_yes = ax.bar([i - bar_width/2 for i in x], avg_yes_vals, bar_width,
                       label='Avg YES Price', color=DEEPSEEK_COLORS[0])
    bars_no = ax.bar([i + bar_width/2 for i in x], avg_no_vals, bar_width,
                      label='Avg NO Price', color=DEEPSEEK_COLORS[3])
    
    # Add 0.50 reference line
    ax.axhline(y=0.50, color='red', linestyle='--', alpha=0.5, label='0.50 threshold')
    
    ax.set_xlabel("Symbol")
    ax.set_ylabel("Average Price (Combined ≤ 1.0)")
    ax.set_xticks(list(x))
    ax.set_xticklabels(symbols)
    ax.set_ylim(0, 1)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.legend(loc='upper center', bbox_to_anchor=(0.5, 1.12), ncol=3)
    
    fig.suptitle("Figure 5: Average YES/NO Prices by Symbol (≤1.0 threshold)", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.90])
    out_path = out_dir / "avg_prices_by_symbol.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_opportunity_frequency(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """Analyze how often opportunities (threshold hits) occur per hour."""
    if len(all_rows) < 2:
        print("  Skipping opportunity frequency: need at least 2 data points")
        return
    
    setup_deepseek_style()
    th_cols = threshold_cols(all_rows)
    
    # Sort by timestamp and compute deltas
    df = all_rows.sort_values("timestamp").copy()
    df["time_delta_hours"] = df["timestamp"].diff().dt.total_seconds() / 3600
    
    # Compute hit deltas for each threshold
    for c in th_cols:
        df[f"{c}_delta"] = df[c].diff()
    
    # Remove first row (no delta) and rows with invalid time deltas
    df = df.iloc[1:].copy()
    df = df[df["time_delta_hours"] > 0]
    
    if df.empty:
        print("  Skipping opportunity frequency: no valid deltas")
        return
    
    # Calculate hits per hour for each threshold
    for c in th_cols:
        df[f"{c}_per_hour"] = df[f"{c}_delta"] / df["time_delta_hours"]
    
    # Aggregate stats
    total_hours = df["time_delta_hours"].sum()
    
    thresholds_vals = []
    avg_per_hour = []
    total_hits = []
    
    for c in th_cols:
        th_val = float(c.replace("hits_le_", ""))
        thresholds_vals.append(th_val)
        total_hit = df[f"{c}_delta"].sum()
        total_hits.append(total_hit)
        avg_per_hour.append(total_hit / total_hours if total_hours > 0 else 0)
    
    # Sort by threshold
    sorted_data = sorted(zip(thresholds_vals, avg_per_hour, total_hits), key=lambda x: x[0])
    thresholds_vals, avg_per_hour, total_hits = zip(*sorted_data)
    
    # Create bar chart
    fig, ax = plt.subplots(figsize=(12, 5))
    x_labels = [f"≤{t}" for t in thresholds_vals]
    colors = DEEPSEEK_COLORS[:len(thresholds_vals)]
    
    bars = ax.bar(x_labels, avg_per_hour, color=colors, edgecolor='none', width=0.7)
    
    # Add value labels on bars
    for bar, hits, rate in zip(bars, total_hits, avg_per_hour):
        height = bar.get_height()
        ax.annotate(f'{rate:.1f}/hr\n({int(hits)} total)',
                    xy=(bar.get_x() + bar.get_width() / 2, height),
                    xytext=(0, 3), textcoords="offset points",
                    ha='center', va='bottom', fontsize=8)
    
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("Opportunities per Hour")
    ax.set_ylim(bottom=0, top=max(avg_per_hour) * 1.3 if avg_per_hour else 1)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    
    fig.suptitle(f"Figure 6: Opportunity Frequency by Threshold ({total_hours:.1f} hours observed)", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "opportunity_frequency.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_opportunity_timeline(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """Time series of opportunity frequency over time."""
    if len(all_rows) < 2:
        return
    
    setup_deepseek_style()
    th_cols = threshold_cols(all_rows)
    
    # Sort and compute rolling rates
    df = all_rows.sort_values("timestamp").copy()
    df["time_delta_hours"] = df["timestamp"].diff().dt.total_seconds() / 3600
    
    for c in th_cols:
        df[f"{c}_delta"] = df[c].diff()
        df[f"{c}_per_hour"] = df[f"{c}_delta"] / df["time_delta_hours"]
    
    df = df.iloc[1:].copy()
    df = df[df["time_delta_hours"] > 0]
    
    if df.empty:
        return
    
    # Select key thresholds to plot (avoid clutter)
    key_thresholds = ["hits_le_0.98", "hits_le_0.99", "hits_le_0.995", "hits_le_1"]
    plot_cols = [c for c in key_thresholds if c in th_cols]
    
    if not plot_cols:
        plot_cols = th_cols[:4]  # fallback to first 4
    
    fig, ax = plt.subplots(figsize=(14, 5))
    
    # Use rolling average for smoother visualization (window=5)
    for idx, c in enumerate(plot_cols):
        col_per_hour = f"{c}_per_hour"
        # Rolling mean with min_periods=1 to handle edge cases
        smoothed = df[col_per_hour].rolling(window=5, min_periods=1).mean()
        label = c.replace("hits_le_", "≤")
        ax.plot(df["timestamp"], smoothed, 
                label=label, color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)],
                linewidth=1.5, alpha=0.8)
    
    ax.set_xlabel("Time")
    ax.set_ylabel("Opportunities per Hour (5-point rolling avg)")
    ax.legend(loc='upper right', frameon=True)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    
    # Format x-axis
    fig.autofmt_xdate()
    
    fig.suptitle("Figure 7: Opportunity Frequency Over Time", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "opportunity_timeline.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def print_frequency_summary(all_rows: pd.DataFrame) -> None:
    """Print summary of opportunity frequency per hour."""
    if len(all_rows) < 2:
        return
    
    th_cols = threshold_cols(all_rows)
    df = all_rows.sort_values("timestamp").copy()
    
    # Total time span
    time_span = (df["timestamp"].max() - df["timestamp"].min()).total_seconds() / 3600
    if time_span <= 0:
        return
    
    # Get first and last row to compute total deltas
    first_row = df.iloc[0]
    last_row = df.iloc[-1]
    
    print(f"\nOpportunity Frequency (over {time_span:.1f} hours):")
    print("-" * 60)
    print(f"{'Threshold':<12} {'Total Hits':<15} {'Per Hour':<15} {'Per Minute':<15}")
    print("-" * 60)
    
    for c in sorted(th_cols, key=lambda x: float(x.replace("hits_le_", ""))):
        th = c.replace("hits_le_", "≤")
        total_hits = last_row[c] - first_row[c]
        per_hour = total_hits / time_span
        per_minute = per_hour / 60
        print(f"{th:<12} {int(total_hits):<15} {per_hour:<15.2f} {per_minute:<15.3f}")


def load_buckets(csv_path: Path) -> pd.DataFrame:
    """Load time bucket CSV data."""
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def load_liquidity(csv_path: Path) -> pd.DataFrame:
    """Load liquidity CSV data."""
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def print_bucket_summary(df: pd.DataFrame) -> None:
    """Print summary of time-to-expiry bucket distribution."""
    if df.empty:
        print("\nNo bucket data available.")
        return
    
    print("\n" + "="*60)
    print("TIME-TO-EXPIRY BUCKET ANALYSIS")
    print("="*60)
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    
    buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
    
    print(f"\n{'Threshold':<12}", end="")
    for b in buckets:
        print(f"{b+'min':<12}", end="")
    print()
    print("-" * (12 + 12 * len(buckets)))
    
    for _, row in latest.sort_values("threshold", ascending=False).iterrows():
        th = row["threshold"]
        print(f"≤{th:<11}", end="")
        for b in buckets:
            hits = row.get(f"hits_{b}min", 0)
            pct = row.get(f"pct_{b}min", 0)
            print(f"{int(hits):>4} ({pct:>5.1f}%)", end=" ")
        print()


def print_liquidity_summary(df: pd.DataFrame) -> None:
    """Print summary of liquidity at each threshold."""
    if df.empty:
        print("\nNo liquidity data available.")
        return
    
    print("\n" + "="*60)
    print("LIQUIDITY ANALYSIS (USD available at threshold)")
    print("="*60)
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    
    print(f"\n{'Threshold':<12} {'Avg USD':<15} {'Max USD':<15} {'Samples':<12}")
    print("-" * 55)
    
    for _, row in latest.sort_values("threshold").iterrows():
        th = row["threshold"]
        avg_usd = row["avg_usd"]
        max_usd = row["max_usd"]
        samples = row["samples"]
        print(f"≤{th:<11} ${avg_usd:<14.2f} ${max_usd:<14.2f} {int(samples):<12}")


def plot_time_bucket_distribution(df: pd.DataFrame, out_dir: Path) -> None:
    """Stacked bar chart showing hit distribution by time-to-expiry bucket."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold", ascending=False)
    
    buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
    thresholds = latest["threshold"].tolist()
    
    fig, ax = plt.subplots(figsize=(12, 6))
    
    x = range(len(thresholds))
    bar_width = 0.7
    bottom = [0] * len(thresholds)
    
    for idx, bucket in enumerate(buckets):
        col = f"pct_{bucket}min"
        if col not in latest.columns:
            continue
        values = latest[col].tolist()
        ax.bar(x, values, bar_width, bottom=bottom, 
               label=f"{bucket} min", color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)])
        bottom = [b + v for b, v in zip(bottom, values)]
    
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("% of Hits")
    ax.set_xticks(list(x))
    ax.set_xticklabels([f"≤{t}" for t in thresholds])
    ax.set_ylim(0, 105)
    ax.legend(title="Time to Expiry", loc='upper center', bbox_to_anchor=(0.5, 1.15),
              ncol=len(buckets), frameon=True)
    
    fig.suptitle("Figure 8: Opportunity Distribution by Time-to-Expiry", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.88])
    out_path = out_dir / "time_bucket_distribution.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_time_bucket_heatmap(df: pd.DataFrame, out_dir: Path) -> None:
    """Heatmap showing opportunity concentration by threshold and time bucket."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold")
    
    buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
    thresholds = latest["threshold"].tolist()
    
    # Build matrix
    matrix = []
    for _, row in latest.iterrows():
        row_data = []
        for bucket in buckets:
            col = f"pct_{bucket}min"
            row_data.append(row.get(col, 0))
        matrix.append(row_data)
    
    fig, ax = plt.subplots(figsize=(10, 6))
    
    import numpy as np
    matrix = np.array(matrix)
    
    im = ax.imshow(matrix, cmap='Blues', aspect='auto')
    
    ax.set_xticks(range(len(buckets)))
    ax.set_xticklabels([f"{b} min" for b in buckets])
    ax.set_yticks(range(len(thresholds)))
    ax.set_yticklabels([f"≤{t}" for t in thresholds])
    
    ax.set_xlabel("Time to Expiry")
    ax.set_ylabel("Threshold")
    
    # Add colorbar
    cbar = plt.colorbar(im, ax=ax)
    cbar.set_label("% of Hits")
    
    # Add text annotations
    for i in range(len(thresholds)):
        for j in range(len(buckets)):
            val = matrix[i, j]
            if val > 0:
                color = 'white' if val > 50 else 'black'
                ax.text(j, i, f"{val:.0f}%", ha='center', va='center', 
                       color=color, fontsize=8)
    
    fig.suptitle("Figure 9: Opportunity Heatmap (Threshold vs Time-to-Expiry)", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.98])
    out_path = out_dir / "time_bucket_heatmap.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_liquidity_by_threshold(df: pd.DataFrame, out_dir: Path) -> None:
    """Bar chart showing average and max liquidity by threshold."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold")
    
    thresholds = latest["threshold"].tolist()
    avg_usd = latest["avg_usd"].tolist()
    max_usd = latest["max_usd"].tolist()
    
    fig, ax = plt.subplots(figsize=(12, 5))
    
    x = range(len(thresholds))
    bar_width = 0.35
    
    bars_avg = ax.bar([i - bar_width/2 for i in x], avg_usd, bar_width,
                       label='Avg USD', color=DEEPSEEK_COLORS[0])
    bars_max = ax.bar([i + bar_width/2 for i in x], max_usd, bar_width,
                       label='Max USD', color=DEEPSEEK_COLORS[3])
    
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("USD Available")
    ax.set_xticks(list(x))
    ax.set_xticklabels([f"≤{t}" for t in thresholds])
    ax.set_ylim(bottom=0)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.legend(loc='upper right')
    
    # Add value labels
    for bar in bars_avg:
        height = bar.get_height()
        if height > 0:
            ax.annotate(f'${height:.0f}',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=7)
    
    fig.suptitle("Figure 10: Liquidity Available at Each Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "liquidity_by_threshold.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def print_opportunity_evaluation(all_rows: pd.DataFrame, buckets_df: pd.DataFrame, liquidity_df: pd.DataFrame) -> None:
    """Print comprehensive evaluation of arbitrage opportunities."""
    print("\n" + "="*70)
    print("OPPORTUNITY EVALUATION SUMMARY")
    print("="*70)
    
    th_cols = threshold_cols(all_rows)
    if all_rows.empty or not th_cols:
        print("Insufficient data for evaluation.")
        return
    
    latest = all_rows.iloc[-1]
    samples = latest["samples"]
    
    print(f"\nTotal samples analyzed: {samples:,}")
    
    # Key metrics for each threshold
    print("\n--- Threshold Analysis ---")
    print(f"{'Threshold':<12} {'Hit Rate':<12} {'Avg Liq':<12} {'Best Bucket':<15} {'Recommendation'}")
    print("-" * 65)
    
    for c in sorted(th_cols, key=lambda x: float(x.replace("hits_le_", ""))):
        th_val = float(c.replace("hits_le_", ""))
        hits = latest[c]
        hit_rate = (hits / samples) * 100 if samples else 0
        
        # Get liquidity info
        avg_liq = "N/A"
        if not liquidity_df.empty:
            liq_row = liquidity_df[liquidity_df["threshold"] == th_val]
            if not liq_row.empty:
                liq_latest = liq_row.sort_values("timestamp").iloc[-1]
                avg_liq = f"${liq_latest['avg_usd']:.2f}"
        
        # Get best time bucket
        best_bucket = "N/A"
        if not buckets_df.empty:
            bucket_row = buckets_df[buckets_df["threshold"] == th_val]
            if not bucket_row.empty:
                bucket_latest = bucket_row.sort_values("timestamp").iloc[-1]
                buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
                max_pct = 0
                for b in buckets:
                    pct = bucket_latest.get(f"pct_{b}min", 0)
                    if pct > max_pct:
                        max_pct = pct
                        best_bucket = f"{b}min ({pct:.0f}%)"
        
        # Recommendation
        if hit_rate >= 1.0:
            rec = "✓ High frequency"
        elif hit_rate >= 0.1:
            rec = "○ Moderate"
        elif hit_rate >= 0.01:
            rec = "△ Low frequency"
        else:
            rec = "✗ Very rare"
        
        print(f"≤{th_val:<11} {hit_rate:<11.3f}% {avg_liq:<12} {best_bucket:<15} {rec}")
    
    # Trading recommendations
    print("\n--- Trading Recommendations ---")
    
    # Find best threshold (balance of frequency and edge)
    best_th = None
    best_score = 0
    for c in th_cols:
        th_val = float(c.replace("hits_le_", ""))
        hits = latest[c]
        hit_rate = (hits / samples) * 100 if samples else 0
        edge = 1.0 - th_val  # theoretical edge
        score = hit_rate * edge * 100  # frequency * edge
        if score > best_score:
            best_score = score
            best_th = th_val
    
    if best_th:
        print(f"  • Best threshold for trading: ≤{best_th} (score: {best_score:.2f})")
        print(f"  • Theoretical edge at ≤{best_th}: {(1.0 - best_th) * 100:.1f}%")
    
    # Time bucket recommendation
    if not buckets_df.empty:
        # Check if opportunities concentrate near expiry
        th_1 = buckets_df[buckets_df["threshold"] == 1.0]
        if not th_1.empty:
            latest_bucket = th_1.sort_values("timestamp").iloc[-1]
            near_expiry_pct = latest_bucket.get("pct_0-5min", 0) + latest_bucket.get("pct_5-10min", 0)
            if near_expiry_pct > 50:
                print(f"  • ⚠️  {near_expiry_pct:.0f}% of opportunities occur <10min to expiry")
                print("    → Consider focusing on markets close to expiration")
            else:
                print(f"  • Opportunities spread across time buckets (only {near_expiry_pct:.0f}% near expiry)")
    
    # Liquidity recommendation
    if not liquidity_df.empty:
        liq_1 = liquidity_df[liquidity_df["threshold"] == 1.0]
        if not liq_1.empty:
            latest_liq = liq_1.sort_values("timestamp").iloc[-1]
            avg_usd = latest_liq["avg_usd"]
            max_usd = latest_liq["max_usd"]
            if avg_usd < 10:
                print(f"  • ⚠️  Low average liquidity: ${avg_usd:.2f} (max: ${max_usd:.2f})")
                print("    → Small position sizes recommended")
            else:
                print(f"  • Good liquidity: avg ${avg_usd:.2f}, max ${max_usd:.2f}")
    
    print()


def plot_liquidity_timeline(df: pd.DataFrame, out_dir: Path) -> None:
    """Time series of liquidity over time for key thresholds."""
    if df.empty or len(df) < 2:
        return
    
    setup_deepseek_style()
    
    # Drop the initial warmup period (first 2 hours) so the averages stabilize
    warmup_cutoff = df["timestamp"].min() + pd.Timedelta(hours=2)
    df = df[df["timestamp"] >= warmup_cutoff]
    if df.empty or len(df) < 2:
        return
    
    # Select key thresholds
    key_thresholds = [0.98, 0.99, 0.995, 1.0]
    available_thresholds = df["threshold"].unique()
    plot_thresholds = [t for t in key_thresholds if t in available_thresholds]
    
    if not plot_thresholds:
        plot_thresholds = sorted(available_thresholds)[:4]
    
    fig, ax = plt.subplots(figsize=(14, 5))
    
    has_data = False
    for idx, th in enumerate(plot_thresholds):
        th_data = df[df["threshold"] == th].sort_values("timestamp")
        if len(th_data) < 2:
            continue
        has_data = True
        ax.plot(th_data["timestamp"], th_data["avg_usd"],
                label=f"≤{th}", color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)],
                linewidth=1.5, alpha=0.8)
    
    if not has_data:
        plt.close()
        return
    
    ax.set_xlabel("Time")
    ax.set_ylabel("Average USD Available")
    ax.legend(loc='upper right', frameon=True)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    ax.set_ylim(bottom=0)
    
    fig.autofmt_xdate()
    
    fig.suptitle("Figure 11: Liquidity Over Time by Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "liquidity_timeline.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_price_distribution_analysis(all_rows: pd.DataFrame, out_dir: Path) -> None:
    """Analyze if 'buy below 50cts' rule makes sense based on avg prices."""
    if all_rows.empty:
        return
    
    yes_cols = avg_yes_cols(all_rows)
    no_cols = avg_no_cols(all_rows)
    if not yes_cols:
        return
    
    setup_deepseek_style()
    latest = all_rows.iloc[-1]
    
    thresholds = []
    pct_yes_below_50 = []  # % of time YES is the cheaper side (<0.50)
    
    for yc, nc in zip(yes_cols, no_cols):
        th = float(yc.replace("avg_yes_le_", ""))
        avg_yes = latest[yc] if pd.notna(latest[yc]) else None
        avg_no = latest[nc] if pd.notna(latest[nc]) else None
        if avg_yes is not None and avg_no is not None:
            thresholds.append(th)
            # If avg_yes < 0.50, YES tends to be the cheaper side
            pct_yes_below_50.append(1 if avg_yes < 0.50 else 0)
    
    if not thresholds:
        return
    
    # Create summary text plot
    fig, ax = plt.subplots(figsize=(10, 6))
    ax.axis('off')
    
    text_lines = ["Price Analysis Summary\n" + "="*50 + "\n"]
    text_lines.append(f"{'Threshold':<12} {'Avg YES':<12} {'Avg NO':<12} {'Cheaper Side':<15} {'Recommendation'}")
    text_lines.append("-" * 70)
    
    for yc, nc in zip(yes_cols, no_cols):
        th = yc.replace("avg_yes_le_", "")
        avg_yes = latest[yc] if pd.notna(latest[yc]) else None
        avg_no = latest[nc] if pd.notna(latest[nc]) else None
        if avg_yes is not None and avg_no is not None:
            cheaper = "YES" if avg_yes < avg_no else "NO"
            cheaper_price = min(avg_yes, avg_no)
            rec = "✓ Buy below 0.50" if cheaper_price < 0.50 else "✗ Above 0.50"
            text_lines.append(f"≤{th:<11} {avg_yes:<12.4f} {avg_no:<12.4f} {cheaper:<15} {rec}")
    
    text_lines.append("\n" + "="*70)
    text_lines.append("\nConclusion:")
    
    # Calculate overall recommendation
    yc_1 = [c for c in yes_cols if c.endswith("_1")]
    nc_1 = [c for c in no_cols if c.endswith("_1")]
    if yc_1:
        avg_yes_1 = latest[yc_1[0]] if pd.notna(latest[yc_1[0]]) else 0.5
        avg_no_1 = latest[nc_1[0]] if pd.notna(latest[nc_1[0]]) else 0.5
        if avg_yes_1 < avg_no_1:
            text_lines.append(f"  • YES side is typically cheaper ({avg_yes_1:.4f} vs {avg_no_1:.4f})")
            if avg_yes_1 < 0.50:
                text_lines.append(f"  • 'Buy YES below 50cts' rule IS viable (avg={avg_yes_1:.4f})")
            else:
                text_lines.append(f"  • 'Buy YES below 50cts' rule may miss opportunities (avg={avg_yes_1:.4f})")
        else:
            text_lines.append(f"  • NO side is typically cheaper ({avg_no_1:.4f} vs {avg_yes_1:.4f})")
            if avg_no_1 < 0.50:
                text_lines.append(f"  • 'Buy NO below 50cts' rule IS viable (avg={avg_no_1:.4f})")
            else:
                text_lines.append(f"  • 'Buy NO below 50cts' rule may miss opportunities (avg={avg_no_1:.4f})")
    
    ax.text(0.05, 0.95, "\n".join(text_lines), transform=ax.transAxes,
            fontfamily='monospace', fontsize=9, verticalalignment='top')
    
    plt.tight_layout()
    out_path = out_dir / "price_analysis_summary.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
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
    latest_sym = latest_symbol_snapshot(df)

    # Print frequency summary
    print_frequency_summary(all_rows)

    plot_hit_rates(latest_sym, args.out_dir)
    plot_market_inefficiency(all_rows, args.out_dir)
    plot_inefficiency_by_symbol(latest_sym, args.out_dir)
    plot_avg_prices_by_threshold(all_rows, args.out_dir)
    plot_avg_prices_by_symbol(latest_sym, args.out_dir)
    plot_price_distribution_analysis(all_rows, args.out_dir)
    plot_opportunity_frequency(all_rows, args.out_dir)
    plot_opportunity_timeline(all_rows, args.out_dir)

    # Load and analyze time bucket data if available
    buckets_csv = Path(str(args.csv).replace(".csv", "-buckets.csv"))
    buckets_df = pd.DataFrame()
    if buckets_csv.exists():
        buckets_df = load_buckets(buckets_csv)
        print_bucket_summary(buckets_df)
        plot_time_bucket_distribution(buckets_df, args.out_dir)
        plot_time_bucket_heatmap(buckets_df, args.out_dir)
    else:
        print(f"\nNo buckets CSV found at {buckets_csv}")

    # Load and analyze liquidity data if available
    liquidity_csv = Path(str(args.csv).replace(".csv", "-liquidity.csv"))
    liquidity_df = pd.DataFrame()
    if liquidity_csv.exists():
        liquidity_df = load_liquidity(liquidity_csv)
        print_liquidity_summary(liquidity_df)
        plot_liquidity_by_threshold(liquidity_df, args.out_dir)
        plot_liquidity_timeline(liquidity_df, args.out_dir)
    else:
        print(f"\nNo liquidity CSV found at {liquidity_csv}")

    # Print comprehensive opportunity evaluation
    print_opportunity_evaluation(all_rows, buckets_df, liquidity_df)

    print(f"\nPlots saved to: {args.out_dir.resolve()}")


if __name__ == "__main__":
    main()
