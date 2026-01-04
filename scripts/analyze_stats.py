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

import pandas as pd

# Import plot functions from submodules
from plots import (
    setup_deepseek_style,
    DEEPSEEK_COLORS,
    plot_hit_rates,
    plot_market_inefficiency,
    plot_inefficiency_by_symbol,
    plot_avg_prices_by_threshold,
    plot_avg_prices_by_symbol,
    plot_price_distribution_analysis,
    plot_opportunity_frequency,
    plot_opportunity_timeline,
    plot_time_bucket_distribution,
    plot_time_bucket_heatmap,
    plot_liquidity_by_threshold,
    plot_liquidity_timeline,
    plot_duration_by_threshold,
    plot_duration_timeline,
    plot_duration_distribution,
)
from plots.common import threshold_cols, avg_yes_cols, avg_no_cols


# -----------------------------------------------------------------------------
# Data Loading
# -----------------------------------------------------------------------------

def load(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


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


def load_duration(csv_path: Path) -> pd.DataFrame:
    """Load duration CSV data."""
    df = pd.read_csv(csv_path, on_bad_lines="skip", engine="python")
    # Backward compatibility: add missing columns if older runs had fewer fields
    for col in ["p90_ms", "med_ms", "rolling_p90_ms"]:
        if col not in df.columns:
            df[col] = pd.NA
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def latest_symbol_snapshot(df: pd.DataFrame) -> pd.DataFrame:
    symbols = df[df["row_type"] == "symbol"].copy()
    if symbols.empty:
        return symbols
    symbols = symbols.sort_values("timestamp")
    return symbols.groupby("symbol").tail(1).reset_index(drop=True)


# -----------------------------------------------------------------------------
# Summary Printing
# -----------------------------------------------------------------------------

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
        print(f"  samples: {row['samples']}")
        for c in th_cols:
            hits = row[c]
            pct = (hits / row["samples"]) * 100 if row["samples"] else 0
            print(f"  {c}: {hits} ({pct:.2f}%)")

    latest_sym = latest_symbol_snapshot(df)
    if not latest_sym.empty:
        print(f"\nSymbols tracked: {len(latest_sym)}")
        for _, r in latest_sym.iterrows():
            print(f"  {r['symbol']} ({r['timeframe']}): {r['samples']} samples")


def print_frequency_summary(all_rows: pd.DataFrame) -> None:
    """Print summary of opportunity frequency over time."""
    if len(all_rows) < 2:
        return
    
    th_cols = threshold_cols(all_rows)
    df = all_rows.sort_values("timestamp").copy()
    df["time_delta_hours"] = df["timestamp"].diff().dt.total_seconds() / 3600
    
    for c in th_cols:
        df[f"{c}_delta"] = df[c].diff()
    
    df = df.iloc[1:].copy()
    df = df[df["time_delta_hours"] > 0]
    
    if df.empty:
        return
    
    total_hours = df["time_delta_hours"].sum()
    
    print("\n" + "="*60)
    print("OPPORTUNITY FREQUENCY ANALYSIS")
    print("="*60)
    print(f"\nTotal observation period: {total_hours:.1f} hours")
    print(f"\n{'Threshold':<15} {'Total Hits':<15} {'Hits/Hour':<15} {'Hits/Day':<15}")
    print("-" * 60)
    
    for c in sorted(th_cols, key=lambda x: float(x.replace("hits_le_", ""))):
        th_val = c.replace("hits_le_", "")
        total_hits = df[f"{c}_delta"].sum()
        hits_per_hour = total_hits / total_hours if total_hours > 0 else 0
        hits_per_day = hits_per_hour * 24
        print(f"≤{th_val:<14} {int(total_hits):<15} {hits_per_hour:<15.2f} {hits_per_day:<15.1f}")


def print_bucket_summary(df: pd.DataFrame) -> None:
    """Print summary of time-to-expiry bucket distribution."""
    if df.empty:
        print("\nNo bucket data available.")
        return
    
    print("\n" + "="*60)
    print("TIME-TO-EXPIRY BUCKET ANALYSIS")
    print("="*60)
    
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold")
    
    buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
    
    print(f"\n{'Threshold':<12}", end="")
    for b in buckets:
        print(f"{b+'min':<10}", end="")
    print()
    print("-" * 72)
    
    for _, row in latest.iterrows():
        th = row["threshold"]
        print(f"≤{th:<11}", end="")
        for b in buckets:
            col = f"pct_{b}min"
            pct = row.get(col, 0)
            print(f"{pct:<10.1f}", end="")
        print()


def print_liquidity_summary(df: pd.DataFrame) -> None:
    """Print summary of liquidity at each threshold."""
    if df.empty:
        print("\nNo liquidity data available.")
        return
    
    print("\n" + "="*60)
    print("LIQUIDITY ANALYSIS (USD available at threshold)")
    print("="*60)
    
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    
    print(f"\n{'Threshold':<12} {'Avg USD':<15} {'Max USD':<15} {'Samples':<12}")
    print("-" * 55)
    
    for _, row in latest.sort_values("threshold").iterrows():
        th = row["threshold"]
        avg_usd = row["avg_usd"]
        max_usd = row["max_usd"]
        samples = row["samples"]
        print(f"≤{th:<11} ${avg_usd:<14.2f} ${max_usd:<14.2f} {int(samples):<12}")


def print_duration_summary(df: pd.DataFrame) -> None:
    """Print summary of opportunity duration at each threshold."""
    if df.empty:
        print("\nNo duration data available.")
        return
    
    print("\n" + "="*60)
    print("OPPORTUNITY DURATION ANALYSIS (how long arb windows stay open)")
    print("="*60)
    
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    
    print(f"\n{'Threshold':<12} {'Avg (ms)':<12} {'Min (ms)':<12} {'Max (ms)':<12} {'Count':<10}")
    print("-" * 60)
    
    for _, row in latest.sort_values("threshold").iterrows():
        th = row["threshold"]
        avg_ms = row["avg_ms"]
        min_ms = row["min_ms"]
        max_ms = row["max_ms"]
        count = row["count"]
        print(f"≤{th:<11} {avg_ms:<12.0f} {min_ms:<12.0f} {max_ms:<12.0f} {int(count):<10}")
    
    # Key insights
    print("\nKey Insights:")
    for _, row in latest.sort_values("threshold").iterrows():
        th = row["threshold"]
        avg_ms = row["avg_ms"]
        if avg_ms < 100:
            print(f"  • ≤{th}: Very fast ({avg_ms:.0f}ms avg) - requires low-latency execution")
        elif avg_ms < 500:
            print(f"  • ≤{th}: Fast ({avg_ms:.0f}ms avg) - sub-second execution needed")
        elif avg_ms < 2000:
            print(f"  • ≤{th}: Moderate ({avg_ms:.0f}ms avg) - standard execution OK")
        else:
            print(f"  • ≤{th}: Comfortable ({avg_ms:.0f}ms avg) - plenty of time to execute")


def print_opportunity_evaluation(
    all_rows: pd.DataFrame, 
    buckets_df: pd.DataFrame, 
    liquidity_df: pd.DataFrame, 
    duration_df: pd.DataFrame = None
) -> None:
    """Print comprehensive evaluation of arbitrage opportunities."""
    if duration_df is None:
        duration_df = pd.DataFrame()
    
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
    print(f"{'Threshold':<12} {'Hit Rate':<12} {'Avg Liq':<12} {'Avg Duration':<14} {'Recommendation'}")
    print("-" * 70)
    
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
        
        # Get duration info
        avg_dur = "N/A"
        if not duration_df.empty:
            dur_row = duration_df[duration_df["threshold"] == th_val]
            if not dur_row.empty:
                dur_latest = dur_row.sort_values("timestamp").iloc[-1]
                avg_dur = f"{dur_latest['avg_ms']:.0f}ms"
        
        # Recommendation based on hit rate and duration
        if hit_rate >= 1.0:
            rec = "✓ High frequency"
        elif hit_rate >= 0.1:
            rec = "○ Moderate"
        elif hit_rate >= 0.01:
            rec = "△ Low frequency"
        else:
            rec = "✗ Very rare"
        
        print(f"≤{th_val:<11} {hit_rate:<11.3f}% {avg_liq:<12} {avg_dur:<14} {rec}")
    
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
    
    # Duration recommendation
    if not duration_df.empty:
        for th_check in [0.99, 0.995, 1.0]:
            dur_th = duration_df[duration_df["threshold"] == th_check]
            if not dur_th.empty:
                latest_dur = dur_th.sort_values("timestamp").iloc[-1]
                avg_ms = latest_dur["avg_ms"]
                min_ms = latest_dur["min_ms"]
                
                if avg_ms < 100:
                    print(f"  • ⚠️  ≤{th_check}: Very short windows ({avg_ms:.0f}ms avg, {min_ms:.0f}ms min)")
                    print("    → Requires low-latency infrastructure (<50ms round-trip)")
                elif avg_ms < 500:
                    print(f"  • ≤{th_check}: Fast windows ({avg_ms:.0f}ms avg) - sub-second execution needed")
                elif avg_ms < 2000:
                    print(f"  • ≤{th_check}: Moderate windows ({avg_ms:.0f}ms avg) - standard execution OK")
                else:
                    print(f"  • ✓ ≤{th_check}: Comfortable windows ({avg_ms:.0f}ms avg) - plenty of time")
                break
    
    print()


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

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

    # Generate plots
    print("\nGenerating plots...")
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

    # Load and analyze duration data if available
    duration_csv = Path(str(args.csv).replace(".csv", "-duration.csv"))
    duration_df = pd.DataFrame()
    if duration_csv.exists():
        duration_df = load_duration(duration_csv)
        print_duration_summary(duration_df)
        plot_duration_by_threshold(duration_df, args.out_dir)
        plot_duration_timeline(duration_df, args.out_dir)
        plot_duration_distribution(duration_df, args.out_dir)
    else:
        print(f"\nNo duration CSV found at {duration_csv}")

    # Print comprehensive opportunity evaluation
    print_opportunity_evaluation(all_rows, buckets_df, liquidity_df, duration_df)

    print(f"\nPlots saved to: {args.out_dir.resolve()}")


if __name__ == "__main__":
    main()
