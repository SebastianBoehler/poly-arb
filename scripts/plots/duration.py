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
    """Horizontal bar chart comparing duration across thresholds with error bars."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold
    latest = df.sort_values("timestamp").groupby("threshold").tail(1)
    latest = latest.sort_values("threshold", ascending=False)
    
    thresholds = [f"≤{t}" for t in latest["threshold"].tolist()]
    avg_ms = latest["avg_ms"].tolist()
    med_ms = pd.to_numeric(latest.get("med_ms", pd.Series([None]*len(latest))), errors="coerce").fillna(0).tolist()
    counts = latest["count"].tolist()
    
    fig, ax = plt.subplots(figsize=(10, 5))
    
    colors = [DEEPSEEK_COLORS[i % len(DEEPSEEK_COLORS)] for i in range(len(thresholds))]
    bars = ax.barh(thresholds, avg_ms, color=colors, edgecolor='none', height=0.6)
    
    # Add median markers
    y_positions = [bar.get_y() + bar.get_height() / 2 for bar in bars]
    for y, med in zip(y_positions, med_ms):
        if med > 0:
            ax.plot(med, y, marker='|', color='white', markersize=12, markeredgewidth=2, zorder=5)
    
    # Add count annotations
    for bar, count, avg, med in zip(bars, counts, avg_ms, med_ms):
        width = bar.get_width()
        label = f'{avg:.0f}ms (n={int(count)})'
        if med > 0:
            label += f' med={med:.0f}'
        ax.annotate(label,
                    xy=(width + 2, bar.get_y() + bar.get_height() / 2),
                    xytext=(5, 0), textcoords="offset points",
                    ha='left', va='center', fontsize=8)
    
    ax.set_xlabel("Average Duration (ms) — | marks median")
    ax.set_ylabel("Threshold")
    ax.set_xlim(left=0, right=max(avg_ms) * 1.4 if avg_ms else 100)
    ax.xaxis.grid(True, alpha=0.3)
    ax.yaxis.grid(False)
    ax.set_axisbelow(True)
    
    fig.suptitle("Figure 14: Opportunity Duration Distribution by Threshold", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.98])
    out_path = out_dir / "duration_distribution.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_duration_by_expiry(df: pd.DataFrame, out_dir: Path) -> None:
    """Heatmap showing duration by time-to-expiry bucket for each threshold."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold/bucket
    latest = df.sort_values("timestamp").groupby(["threshold", "expiry_bucket"]).tail(1)
    
    # Define bucket order (from far to near expiry)
    bucket_order = ["60+m", "15-60m", "5-15m", "60-300s", "30-60s", "15-30s", "5-15s", "0-5s"]
    bucket_labels = ["60+m", "15-60m", "5-15m", "1-5m", "30-60s", "15-30s", "5-15s", "0-5s"]
    
    # Get all thresholds
    all_thresholds = sorted(latest["threshold"].unique(), reverse=True)
    
    # Build matrix for heatmap (thresholds x buckets)
    matrix = []
    annotations = []
    for th in all_thresholds:
        th_data = latest[latest["threshold"] == th]
        row = []
        ann_row = []
        for bucket in bucket_order:
            bucket_row = th_data[th_data["expiry_bucket"] == bucket]
            if bucket_row.empty:
                row.append(0)
                ann_row.append("")
            else:
                avg = bucket_row.iloc[0]["avg_ms"]
                count = int(bucket_row.iloc[0]["count"])
                mx = bucket_row.iloc[0]["max_ms"]
                row.append(avg)
                ann_row.append(f"{avg:.0f}\nn={count}\nmax={mx:.0f}")
        matrix.append(row)
        annotations.append(ann_row)
    
    import numpy as np
    matrix = np.array(matrix)
    
    fig, ax = plt.subplots(figsize=(14, 6))
    
    # Create heatmap
    im = ax.imshow(matrix, cmap='YlOrRd', aspect='auto')
    
    # Add colorbar
    cbar = ax.figure.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label('Avg Duration (ms)')
    
    # Set ticks
    ax.set_xticks(range(len(bucket_order)))
    ax.set_xticklabels(bucket_labels)
    ax.set_yticks(range(len(all_thresholds)))
    ax.set_yticklabels([f"≤{th}" for th in all_thresholds])
    
    # Add text annotations
    for i in range(len(all_thresholds)):
        for j in range(len(bucket_order)):
            if annotations[i][j]:
                text_color = 'white' if matrix[i, j] > matrix.max() * 0.6 else 'black'
                ax.text(j, i, annotations[i][j], ha='center', va='center', 
                       fontsize=7, color=text_color)
    
    ax.set_xlabel("Time to Expiry (← far from expiry | near expiry →)")
    ax.set_ylabel("Threshold")
    
    fig.suptitle("Figure 15: Opportunity Duration by Time-to-Expiry (Heatmap)", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "duration_by_expiry.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")


def plot_duration_by_expiry_lines(df: pd.DataFrame, out_dir: Path) -> None:
    """Line chart showing duration distribution across expiry buckets per threshold."""
    if df.empty:
        return
    
    setup_deepseek_style()
    
    # Get latest snapshot per threshold/bucket
    latest = df.sort_values("timestamp").groupby(["threshold", "expiry_bucket"]).tail(1)
    
    # Define bucket order (from far to near expiry)
    bucket_order = ["60+m", "15-60m", "5-15m", "60-300s", "30-60s", "15-30s", "5-15s", "0-5s"]
    bucket_labels = ["60+m", "15-60m", "5-15m", "1-5m", "30-60s", "15-30s", "5-15s", "0-5s"]
    
    # Filter to key thresholds
    key_thresholds = [0.95, 0.98, 0.99, 0.995]
    available = latest["threshold"].unique()
    plot_thresholds = [t for t in key_thresholds if t in available]
    if not plot_thresholds:
        plot_thresholds = sorted(available)[:4]
    
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 5))
    
    x = range(len(bucket_order))
    
    # Left plot: Average duration
    for idx, th in enumerate(plot_thresholds):
        th_data = latest[latest["threshold"] == th]
        avg_values = []
        for bucket in bucket_order:
            row = th_data[th_data["expiry_bucket"] == bucket]
            avg_values.append(row.iloc[0]["avg_ms"] if not row.empty else 0)
        
        ax1.plot(x, avg_values, marker='o', linewidth=2, markersize=6,
                label=f"≤{th}", color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)])
    
    ax1.set_xlabel("Time to Expiry")
    ax1.set_ylabel("Average Duration (ms)")
    ax1.set_xticks(list(x))
    ax1.set_xticklabels(bucket_labels, rotation=45, ha='right')
    ax1.set_ylim(bottom=0)
    ax1.yaxis.grid(True, alpha=0.3)
    ax1.legend(loc='upper left', title='Threshold')
    ax1.set_title("Average Duration")
    
    # Right plot: Max duration (shows where the long opportunities are)
    for idx, th in enumerate(plot_thresholds):
        th_data = latest[latest["threshold"] == th]
        max_values = []
        for bucket in bucket_order:
            row = th_data[th_data["expiry_bucket"] == bucket]
            max_values.append(row.iloc[0]["max_ms"] if not row.empty else 0)
        
        ax2.plot(x, max_values, marker='s', linewidth=2, markersize=6,
                label=f"≤{th}", color=DEEPSEEK_COLORS[idx % len(DEEPSEEK_COLORS)])
    
    ax2.set_xlabel("Time to Expiry")
    ax2.set_ylabel("Max Duration (ms)")
    ax2.set_xticks(list(x))
    ax2.set_xticklabels(bucket_labels, rotation=45, ha='right')
    ax2.set_ylim(bottom=0)
    ax2.yaxis.grid(True, alpha=0.3)
    ax2.legend(loc='upper left', title='Threshold')
    ax2.set_title("Max Duration (where long opportunities occur)")
    
    fig.suptitle("Figure 16: Duration vs Time-to-Expiry Analysis", 
                 y=0.02, fontsize=10, style='italic')
    
    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "duration_expiry_lines.png"
    plt.savefig(out_path, dpi=200, facecolor='white', bbox_inches='tight')
    plt.close()
    print(f"  Saved: {out_path}")
