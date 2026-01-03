"""Hit rate and market inefficiency plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

from .common import setup_deepseek_style, DEEPSEEK_COLORS, threshold_cols


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
