"""Time-to-expiry bucket plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np

from .common import setup_deepseek_style, DEEPSEEK_COLORS


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
