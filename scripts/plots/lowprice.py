"""Low-price dust opportunity plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .common import setup_deepseek_style


def plot_lowprice_heatmap(df: pd.DataFrame, out_dir: Path) -> None:
    """Heatmap showing low-price dust hits by expiry bucket."""
    if df.empty:
        return

    setup_deepseek_style()

    latest = df.sort_values("timestamp").groupby(["side", "threshold"]).tail(1)

    buckets = [
        "0-5s",
        "5-15s",
        "15-30s",
        "30-60s",
        "60-300s",
        "5-15m",
        "15-60m",
        "60+m",
    ]

    sides = ["yes", "no"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 5), sharey=True)
    im = None

    for idx, side in enumerate(sides):
        ax = axes[idx]
        side_df = latest[latest["side"] == side].sort_values("threshold")
        if side_df.empty:
            ax.axis("off")
            ax.set_title(f"{side.upper()} (no data)")
            continue

        thresholds = side_df["threshold"].tolist()
        matrix = []
        for _, row in side_df.iterrows():
            row_data = []
            for bucket in buckets:
                col = f"pct_{bucket}"
                row_data.append(row.get(col, 0))
            matrix.append(row_data)

        matrix = np.array(matrix)
        im = ax.imshow(matrix, cmap="Purples", aspect="auto")
        ax.set_title(f"{side.upper()} dust hits")
        ax.set_xticks(range(len(buckets)))
        ax.set_xticklabels(buckets, rotation=45, ha="right")
        ax.set_yticks(range(len(thresholds)))
        ax.set_yticklabels([f"≤{t}" for t in thresholds])
        ax.set_xlabel("Time to Expiry")
        if idx == 0:
            ax.set_ylabel("Low-price Threshold")

        for i in range(len(thresholds)):
            for j in range(len(buckets)):
                val = matrix[i, j]
                if val > 0:
                    color = "white" if val > 50 else "black"
                    ax.text(j, i, f"{val:.0f}%", ha="center", va="center", color=color, fontsize=8)

    if im is not None:
        fig.colorbar(im, ax=axes.ravel().tolist(), shrink=0.9, label="% of Hits")
    fig.suptitle("Figure 12: Low-Price Dust Heatmap (1-5c legs)", y=0.02, fontsize=10, style="italic")

    plt.tight_layout(rect=[0, 0.05, 1, 0.95])
    out_path = out_dir / "lowprice_heatmap.png"
    plt.savefig(out_path, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out_path}")
