"""Liquidity analysis plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

from .common import setup_deepseek_style, DEEPSEEK_COLORS


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
