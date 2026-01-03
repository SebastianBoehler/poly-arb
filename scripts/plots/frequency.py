"""Opportunity frequency plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

from .common import setup_deepseek_style, DEEPSEEK_COLORS, threshold_cols


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
