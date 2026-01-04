"""Opportunity duration analysis plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

from .common import setup_deepseek_style, DEEPSEEK_COLORS


def plot_duration_by_threshold(df: pd.DataFrame, out_dir: Path) -> None:
    """Bar chart showing average, p90, and max duration by threshold."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold")
    
    thresholds = latest["threshold"].tolist()
    avg_ms = pd.to_numeric(latest["avg_ms"], errors="coerce").fillna(0).tolist()
    p90_ms = pd.to_numeric(latest.get("p90_ms", pd.Series([None]*len(latest))), errors="coerce").fillna(0).tolist()
    max_ms = pd.to_numeric(latest["max_ms"], errors="coerce").fillna(0).tolist()
    
    fig, ax = plt.subplots(figsize=(12, 5))
    
    x = range(len(thresholds))
    bar_width = 0.25
    
    bars_avg = ax.bar([i - bar_width for i in x], avg_ms, bar_width,
                       label='Avg', color=DEEPSEEK_COLORS[0])
    bars_p90 = ax.bar([i for i in x], p90_ms, bar_width,
                       label='P90', color=DEEPSEEK_COLORS[2])
    bars_max = ax.bar([i + bar_width for i in x], max_ms, bar_width,
                       label='Max', color=DEEPSEEK_COLORS[4])
    
    ax.set_xlabel("Combined Price Threshold")
    ax.set_ylabel("Duration (ms)")
    ax.set_xticks(list(x))
    ax.set_xticklabels([f"≤{t}" for t in thresholds])
    ax.set_ylim(bottom=0)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.legend(loc='upper right')
    
    # Add value labels on avg bars
    for bar in bars_avg:
        height = bar.get_height()
        if height > 0:
            ax.annotate(f'{height:.0f}ms',
                        xy=(bar.get_x() + bar.get_width() / 2, height),
                        xytext=(0, 3), textcoords="offset points",
                        ha='center', va='bottom', fontsize=7)
    
    fig.suptitle("Figure 12: Opportunity Duration by Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "duration_by_threshold.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_duration_timeline(df: pd.DataFrame, out_dir: Path) -> None:
    """Time series of opportunity duration over time (p90 + rolling p90)."""
    if df.empty or len(df) < 2:
        return
    
    setup_deepseek_style()
    
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
        ax.plot(
            th_data["timestamp"],
            th_data.get("p90_ms", th_data["avg_ms"]),
            label=f"≤{th} p90",
            color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)],
            linewidth=1.8,
            alpha=0.9,
        )
        if "rolling_p90_ms" in th_data:
            ax.plot(
                th_data["timestamp"],
                th_data["rolling_p90_ms"],
                label=f"≤{th} roll p90",
                color=DEEPSEEK_COLORS[(idx + 2) % len(DEEPSEEK_COLORS)],
                linewidth=1.2,
                alpha=0.6,
                linestyle="--",
            )
    
    if not has_data:
        plt.close()
        return
    
    ax.set_xlabel("Time")
    ax.set_ylabel("Duration (ms)")
    ax.legend(loc='upper right', frameon=True)
    ax.yaxis.grid(True, alpha=0.3)
    ax.xaxis.grid(False)
    ax.set_axisbelow(True)
    ax.set_ylim(bottom=0)
    
    fig.autofmt_xdate()
    
    fig.suptitle("Figure 13: Opportunity Duration Over Time", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "duration_timeline.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_duration_distribution(df: pd.DataFrame, out_dir: Path) -> None:
    """Horizontal bar chart comparing duration across thresholds."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold", ascending=False)
    
    thresholds = [f"≤{t}" for t in latest["threshold"].tolist()]
    avg_ms = latest["avg_ms"].tolist()
    counts = latest["count"].tolist()
    
    fig, ax = plt.subplots(figsize=(10, 5))
    
    colors = [DEEPSEEK_COLORS[i % len(DEEPSEEK_COLORS)] for i in range(len(thresholds))]
    bars = ax.barh(thresholds, avg_ms, color=colors, edgecolor='none', height=0.6)
    
    # Add count annotations
    for bar, count, ms in zip(bars, counts, avg_ms):
        width = bar.get_width()
        ax.annotate(f'{ms:.0f}ms (n={int(count)})',
                    xy=(width, bar.get_y() + bar.get_height() / 2),
                    xytext=(5, 0), textcoords="offset points",
                    ha='left', va='center', fontsize=8)
    
    ax.set_xlabel("Average Duration (ms)")
    ax.set_ylabel("Threshold")
    ax.set_xlim(left=0, right=max(avg_ms) * 1.3 if avg_ms else 100)
    ax.xaxis.grid(True, alpha=0.3)
    ax.yaxis.grid(False)
    ax.set_axisbelow(True)
    
    fig.suptitle("Figure 14: Average Opportunity Duration by Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.98])
    out_path = out_dir / "duration_distribution.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")
