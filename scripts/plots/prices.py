"""Price analysis plots."""
from __future__ import annotations

from pathlib import Path
import matplotlib.pyplot as plt
import pandas as pd

from .common import setup_deepseek_style, DEEPSEEK_COLORS, avg_yes_cols, avg_no_cols


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
