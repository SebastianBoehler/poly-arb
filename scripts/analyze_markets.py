#!/usr/bin/env python3
"""
Analyze cross-market data collected by collect-market-data.ts.

Generates plots for:
  1. Spread distribution by category and platform
  2. Spread heatmap by hour-of-day (timezone patterns)
  3. Category spread evolution over time
  4. Combined price (YES+NO) distribution — arb detection
  5. Liquidity vs spread scatter
  6. Session comparison (Asia/EU/US)
  7. Top mispriced markets over time
  8. Day-of-week patterns

Usage:
  python scripts/analyze_markets.py --data-dir ./data --out-dir market-plots
  python scripts/analyze_markets.py --data-dir ./data --out-dir market-plots --min-scans 5
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import List, Optional

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.colors import LinearSegmentedColormap

# Reuse existing style
import sys
sys.path.insert(0, str(Path(__file__).parent))
from plots.common import setup_deepseek_style, DEEPSEEK_COLORS


# Extended palette for more categories
EXTENDED_COLORS = DEEPSEEK_COLORS + [
    "#e07b39", "#d94f4f", "#8b5cf6", "#10b981",
    "#f59e0b", "#ef4444", "#6366f1", "#14b8a6",
    "#f97316", "#ec4899", "#84cc16", "#06b6d4",
]


# ─── Data Loading ─────────────────────────────────────────────────────────────

def load_market_snapshots(data_dir: Path) -> pd.DataFrame:
    path = data_dir / "market-snapshots.csv"
    if not path.exists():
        raise FileNotFoundError(f"No market-snapshots.csv in {data_dir}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def load_category_snapshots(data_dir: Path) -> pd.DataFrame:
    path = data_dir / "category-snapshots.csv"
    if not path.exists():
        raise FileNotFoundError(f"No category-snapshots.csv in {data_dir}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


def load_spread_timeseries(data_dir: Path) -> pd.DataFrame:
    path = data_dir / "spread-timeseries.csv"
    if not path.exists():
        raise FileNotFoundError(f"No spread-timeseries.csv in {data_dir}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


# ─── Plot 1: Spread Distribution by Category ─────────────────────────────────

def plot_spread_by_category(mkt: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    # Use latest scan only
    latest_scan = mkt["scan_id"].max()
    df = mkt[mkt["scan_id"] == latest_scan].copy()

    # Filter to categories with >= 3 markets
    cat_counts = df["category"].value_counts()
    valid_cats = cat_counts[cat_counts >= 3].index.tolist()
    df = df[df["category"].isin(valid_cats)]

    if df.empty:
        print("  Skipping spread_by_category: no data")
        return

    # Sort categories by median spread
    cat_order = df.groupby("category")["spread_pct"].median().sort_values(ascending=False).index.tolist()

    fig, ax = plt.subplots(figsize=(14, 6))
    positions = range(len(cat_order))
    bp_data = [df[df["category"] == cat]["spread_pct"].dropna().values for cat in cat_order]

    bp = ax.boxplot(bp_data, positions=positions, widths=0.6, patch_artist=True,
                    showfliers=True, flierprops=dict(marker=".", markersize=3, alpha=0.4))

    for i, patch in enumerate(bp["boxes"]):
        patch.set_facecolor(EXTENDED_COLORS[i % len(EXTENDED_COLORS)])
        patch.set_alpha(0.7)

    ax.set_xticks(positions)
    ax.set_xticklabels(cat_order, rotation=45, ha="right", fontsize=8)
    ax.set_ylabel("Spread %  (|1 - YES - NO| × 100)")
    ax.set_title("Spread Distribution by Category (Latest Scan)")
    ax.set_ylim(bottom=0)

    plt.tight_layout()
    out = out_dir / "spread_by_category.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 2: Spread Heatmap by Hour (Timezone Patterns) ──────────────────────

def plot_spread_heatmap_by_hour(spread_ts: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    df = spread_ts.copy()
    if df.empty or df["scan_id"].nunique() < 2:
        print("  Skipping spread_heatmap: need multiple scans")
        return

    # Top categories by count
    top_cats = df["category"].value_counts().head(12).index.tolist()
    df = df[df["category"].isin(top_cats)]

    pivot = df.groupby(["hour_utc", "category"])["spread_pct"].mean().unstack(fill_value=0)
    # Reindex to ensure all 24 hours
    pivot = pivot.reindex(range(24), fill_value=0)

    fig, ax = plt.subplots(figsize=(14, 7))
    cmap = LinearSegmentedColormap.from_list("blues", ["#f0f7ff", "#1a3a5c"])
    im = ax.imshow(pivot.T.values, aspect="auto", cmap=cmap, interpolation="nearest")

    ax.set_xticks(range(24))
    ax.set_xticklabels([f"{h:02d}" for h in range(24)], fontsize=8)
    ax.set_yticks(range(len(pivot.columns)))
    ax.set_yticklabels(pivot.columns, fontsize=8)
    ax.set_xlabel("Hour (UTC)")
    ax.set_ylabel("Category")
    ax.set_title("Average Spread % by Hour of Day and Category")

    # Session annotations
    for start, end, label in [(0, 7, "Asia"), (8, 13, "Europe"), (13, 16, "EU/US"), (16, 22, "US")]:
        mid = (start + end) / 2
        ax.annotate(label, xy=(mid, -0.8), fontsize=7, ha="center", color="#666",
                    annotation_clip=False)

    plt.colorbar(im, ax=ax, label="Avg Spread %", shrink=0.8)
    plt.tight_layout()
    out = out_dir / "spread_heatmap_by_hour.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 3: Category Spread Over Time ───────────────────────────────────────

def plot_category_spread_timeline(cat_df: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    if cat_df.empty or cat_df["scan_id"].nunique() < 2:
        print("  Skipping category_spread_timeline: need multiple scans")
        return

    # Top categories by total volume
    top = cat_df.groupby("category")["total_volume"].sum().nlargest(8).index.tolist()
    df = cat_df[cat_df["category"].isin(top)].copy()

    fig, ax = plt.subplots(figsize=(14, 6))
    for i, cat in enumerate(top):
        sub = df[df["category"] == cat].sort_values("timestamp")
        # Rolling average for smoothness
        spread = sub["avg_spread_pct"].rolling(3, min_periods=1).mean()
        ax.plot(sub["timestamp"], spread, label=cat,
                color=EXTENDED_COLORS[i % len(EXTENDED_COLORS)], linewidth=1.5, alpha=0.85)

    ax.set_xlabel("Time")
    ax.set_ylabel("Avg Spread %")
    ax.set_title("Category Spread Evolution Over Time")
    ax.legend(loc="upper right", fontsize=7, ncol=2)
    ax.set_ylim(bottom=0)
    fig.autofmt_xdate()

    plt.tight_layout()
    out = out_dir / "category_spread_timeline.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 4: Combined Price Distribution (Arb Detection) ─────────────────────

def plot_combined_price_distribution(mkt: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    latest_scan = mkt["scan_id"].max()
    df = mkt[mkt["scan_id"] == latest_scan].copy()
    df = df[(df["yes_price"] > 0) & (df["no_price"] > 0) & (df["combined"] > 0)]

    if df.empty:
        print("  Skipping combined_price_dist: no data")
        return

    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Histogram of combined prices
    ax = axes[0]
    ax.hist(df["combined"], bins=50, color=DEEPSEEK_COLORS[2], edgecolor="white",
            linewidth=0.5, alpha=0.8)
    ax.axvline(x=1.0, color="#d94f4f", linestyle="--", linewidth=1.5, label="Fair value (1.00)")
    ax.axvline(x=0.97, color="#e07b39", linestyle=":", linewidth=1, label="Arb threshold (0.97)")
    ax.set_xlabel("Combined Price (YES + NO)")
    ax.set_ylabel("Count")
    ax.set_title("Combined Price Distribution")
    ax.legend(fontsize=8)

    # Scatter: combined vs volume
    ax = axes[1]
    for i, platform in enumerate(df["platform"].unique()):
        sub = df[df["platform"] == platform]
        ax.scatter(sub["combined"], sub["volume"], alpha=0.4, s=15,
                   color=DEEPSEEK_COLORS[i * 2], label=platform)
    ax.axvline(x=1.0, color="#d94f4f", linestyle="--", linewidth=1, alpha=0.5)
    ax.set_xlabel("Combined Price (YES + NO)")
    ax.set_ylabel("Volume ($)")
    ax.set_title("Combined Price vs Volume")
    ax.legend(fontsize=8)
    ax.set_yscale("symlog", linthresh=100)

    plt.tight_layout()
    out = out_dir / "combined_price_distribution.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 5: Liquidity vs Spread ─────────────────────────────────────────────

def plot_liquidity_vs_spread(mkt: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    latest_scan = mkt["scan_id"].max()
    df = mkt[mkt["scan_id"] == latest_scan].copy()
    df = df[(df["spread_pct"] > 0) & (df["liquidity"] > 0)]

    if df.empty:
        print("  Skipping liquidity_vs_spread: no data")
        return

    # Top categories for coloring
    top_cats = df["category"].value_counts().head(6).index.tolist()

    fig, ax = plt.subplots(figsize=(12, 6))
    for i, cat in enumerate(top_cats):
        sub = df[df["category"] == cat]
        ax.scatter(sub["liquidity"], sub["spread_pct"], alpha=0.5, s=20,
                   color=EXTENDED_COLORS[i], label=cat)

    other = df[~df["category"].isin(top_cats)]
    if not other.empty:
        ax.scatter(other["liquidity"], other["spread_pct"], alpha=0.2, s=10,
                   color="#999999", label="other")

    ax.set_xlabel("Liquidity ($)")
    ax.set_ylabel("Spread %")
    ax.set_title("Liquidity vs Spread by Category")
    ax.set_xscale("symlog", linthresh=100)
    ax.legend(fontsize=7, loc="upper right")
    ax.set_ylim(bottom=0)

    plt.tight_layout()
    out = out_dir / "liquidity_vs_spread.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 6: Session Comparison ──────────────────────────────────────────────

def plot_session_comparison(spread_ts: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    df = spread_ts.copy()
    if df.empty or df["session"].nunique() < 2:
        print("  Skipping session_comparison: need multiple sessions")
        return

    session_order = ["asia", "overlap_asia_eu", "europe", "overlap_eu_us", "us"]
    sessions_present = [s for s in session_order if s in df["session"].unique()]

    if len(sessions_present) < 2:
        print("  Skipping session_comparison: need data from >= 2 sessions")
        return

    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Bar: avg spread by session
    ax = axes[0]
    means = [df[df["session"] == s]["spread_pct"].mean() for s in sessions_present]
    bars = ax.bar(sessions_present, means, color=DEEPSEEK_COLORS[:len(sessions_present)],
                  edgecolor="none", width=0.6)
    for bar, val in zip(bars, means):
        ax.annotate(f"{val:.2f}%", xy=(bar.get_x() + bar.get_width() / 2, bar.get_height()),
                    xytext=(0, 3), textcoords="offset points", ha="center", fontsize=8)
    ax.set_ylabel("Avg Spread %")
    ax.set_title("Average Spread by Trading Session")
    ax.set_ylim(bottom=0)

    # Bar: market count by session
    ax = axes[1]
    counts = [df[df["session"] == s]["id"].nunique() for s in sessions_present]
    bars = ax.bar(sessions_present, counts, color=DEEPSEEK_COLORS[:len(sessions_present)],
                  edgecolor="none", width=0.6)
    for bar, val in zip(bars, counts):
        ax.annotate(str(val), xy=(bar.get_x() + bar.get_width() / 2, bar.get_height()),
                    xytext=(0, 3), textcoords="offset points", ha="center", fontsize=8)
    ax.set_ylabel("Unique Markets Observed")
    ax.set_title("Market Coverage by Session")

    for a in axes:
        a.set_xticklabels(sessions_present, rotation=20, ha="right", fontsize=8)

    plt.tight_layout()
    out = out_dir / "session_comparison.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 7: Top Mispriced Markets Over Time ─────────────────────────────────

def plot_top_mispriced_timeline(spread_ts: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    df = spread_ts.copy()
    df["combined"] = df["combined"].astype(float)
    if df.empty or df["scan_id"].nunique() < 2:
        print("  Skipping top_mispriced_timeline: need multiple scans")
        return

    # Focus on markets near fair value where deviations are actionable
    # Skip illiquid markets with extreme combined prices (e.g. 1.9 = both sides asking high)
    df = df[(df["combined"] > 0.85) & (df["combined"] < 1.15)]

    if df.empty:
        print("  Skipping top_mispriced_timeline: no markets in 0.85-1.15 combined range")
        return

    # Build a label lookup: prefer title column, fall back to id
    has_title = "title" in df.columns and df["title"].notna().any()
    def get_label(market_id: str) -> str:
        if has_title:
            titles = df.loc[df["id"] == market_id, "title"].dropna()
            if not titles.empty:
                t = str(titles.iloc[0])[:35]
                return t + ("..." if len(str(titles.iloc[0])) > 35 else "")
        return market_id[:30] + ("..." if len(market_id) > 30 else "")

    # Only keep markets that appear in >= 2 scans (need a time series)
    scan_counts = df.groupby("id")["scan_id"].nunique()
    multi_scan_ids = scan_counts[scan_counts >= 2].index

    # Markets with combined furthest from 1.0 that have multi-scan data
    df_multi = df[df["id"].isin(multi_scan_ids)]

    if df_multi.empty:
        # Not enough repeated observations yet — show a snapshot bar chart instead
        print("  top_mispriced_timeline: not enough repeated scans per market, showing snapshot instead")
        _plot_mispriced_snapshot(df, out_dir, has_title)
        return

    avg_dev = df_multi.groupby("id")["combined"].apply(lambda x: abs(x - 1.0).mean())
    top_ids = avg_dev.nlargest(10).index.tolist()

    n_arb = len(df_multi[df_multi["combined"] < 0.97]["id"].unique())
    subtitle = f"{n_arb} markets with combined < 0.97" if n_arb > 0 else "Top 10 by deviation from fair value"

    fig, ax = plt.subplots(figsize=(14, 6))
    for i, mid in enumerate(top_ids):
        sub = df_multi[df_multi["id"] == mid].sort_values("timestamp")
        if sub.empty:
            continue
        cat = sub["category"].iloc[0]
        label = f"{cat}: {get_label(mid)}"
        ax.plot(sub["timestamp"], sub["combined"],
                label=label, color=EXTENDED_COLORS[i % len(EXTENDED_COLORS)],
                linewidth=1.5, alpha=0.8, marker="o", markersize=3)

    ax.axhline(y=1.0, color="#d94f4f", linestyle="--", linewidth=1.5, alpha=0.6, label="Fair value (1.00)")
    ax.axhline(y=0.97, color="#e07b39", linestyle=":", linewidth=1, alpha=0.6, label="Arb threshold (0.97)")
    ax.set_xlabel("Time")
    ax.set_ylabel("Combined Price (YES + NO)")
    ax.set_title("Top Mispriced Markets — Combined Price Over Time")

    # Auto-scale y-axis around the data with padding
    all_combined = pd.concat([df_multi[df_multi["id"] == mid]["combined"] for mid in top_ids])
    if not all_combined.empty:
        ymin = all_combined.min() - 0.03
        ymax = all_combined.max() + 0.03
        # Always include the reference lines if they're close to the data
        if ymin > 0.95:
            ymin = 0.95
        if ymax < 1.02:
            ymax = 1.02
        ax.set_ylim(ymin, ymax)

    # Fix x-axis to actual data range
    ax.set_xlim(df["timestamp"].min(), df["timestamp"].max())

    ax.legend(fontsize=6, loc="best", ncol=2)
    fig.autofmt_xdate()

    fig.text(0.5, 0.01, subtitle, ha="center", fontsize=9, style="italic", color="#666")

    plt.tight_layout(rect=[0, 0.04, 1, 1])
    out = out_dir / "top_mispriced_timeline.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


def _plot_mispriced_snapshot(df: pd.DataFrame, out_dir: Path, has_title: bool = False) -> None:
    """Fallback: bar chart of most mispriced markets from latest scan."""
    latest = df[df["scan_id"] == df["scan_id"].max()].copy()
    latest["deviation"] = abs(latest["combined"] - 1.0)
    top = latest.nlargest(15, "deviation")

    if top.empty:
        print("  Skipping mispriced snapshot: no data")
        return

    fig, ax = plt.subplots(figsize=(14, 6))
    def _label(r):
        name = str(r.get("title", r["id"]))[:30] if has_title and pd.notna(r.get("title")) else r["id"][:25]
        return f"{r['category']}: {name}"
    labels = [_label(r) for _, r in top.iterrows()]
    colors = [DEEPSEEK_COLORS[2] if c < 0.97 else DEEPSEEK_COLORS[4] for c in top["combined"]]

    bars = ax.barh(range(len(top)), top["combined"], color=colors, edgecolor="none", height=0.6)
    ax.set_yticks(range(len(top)))
    ax.set_yticklabels(labels, fontsize=7)
    ax.axvline(x=1.0, color="#d94f4f", linestyle="--", linewidth=1.5, alpha=0.6, label="Fair value")
    ax.axvline(x=0.97, color="#e07b39", linestyle=":", linewidth=1, alpha=0.6, label="Arb threshold")
    ax.set_xlabel("Combined Price (YES + NO)")
    ax.set_title("Most Mispriced Markets (Latest Scan)")
    ax.legend(fontsize=8)
    ax.invert_yaxis()

    for bar, val in zip(bars, top["combined"]):
        ax.text(bar.get_width() + 0.005, bar.get_y() + bar.get_height() / 2,
                f"{val:.3f}", va="center", fontsize=7)

    plt.tight_layout()
    out = out_dir / "top_mispriced_timeline.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Plot 8: Day-of-Week Patterns ────────────────────────────────────────────

def plot_day_of_week(mkt: pd.DataFrame, out_dir: Path) -> None:
    setup_deepseek_style()

    df = mkt.copy()
    if "day_of_week" not in df.columns or df["day_of_week"].nunique() < 2:
        print("  Skipping day_of_week: need data from multiple days")
        return

    day_order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    days_present = [d for d in day_order if d in df["day_of_week"].unique()]

    if len(days_present) < 2:
        print("  Skipping day_of_week: need >= 2 days")
        return

    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Avg spread by day
    ax = axes[0]
    means = [df[df["day_of_week"] == d]["spread_pct"].mean() for d in days_present]
    ax.bar(days_present, means, color=DEEPSEEK_COLORS[:len(days_present)], edgecolor="none")
    ax.set_ylabel("Avg Spread %")
    ax.set_title("Average Spread by Day of Week")
    ax.set_ylim(bottom=0)

    # Market count by day
    ax = axes[1]
    counts = [df[df["day_of_week"] == d]["id"].nunique() for d in days_present]
    ax.bar(days_present, counts, color=DEEPSEEK_COLORS[:len(days_present)], edgecolor="none")
    ax.set_ylabel("Unique Markets")
    ax.set_title("Market Count by Day of Week")

    plt.tight_layout()
    out = out_dir / "day_of_week_patterns.png"
    plt.savefig(out, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close()
    print(f"  Saved: {out}")


# ─── Summary Stats ────────────────────────────────────────────────────────────

def print_summary(mkt: pd.DataFrame, cat_df: pd.DataFrame, spread_ts: pd.DataFrame) -> None:
    n_scans = mkt["scan_id"].nunique()
    time_span = mkt["timestamp"].max() - mkt["timestamp"].min()
    hours = time_span.total_seconds() / 3600

    print(f"\n{'='*60}")
    print("MARKET DATA COLLECTION SUMMARY")
    print(f"{'='*60}")
    print(f"  Scans: {n_scans}")
    print(f"  Time span: {time_span} ({hours:.1f} hours)")
    print(f"  First: {mkt['timestamp'].min()}")
    print(f"  Last:  {mkt['timestamp'].max()}")
    print(f"  Total market rows: {len(mkt):,}")
    print(f"  Unique markets: {mkt['id'].nunique():,}")
    print(f"  Platforms: {', '.join(mkt['platform'].unique())}")
    print(f"  Categories: {mkt['category'].nunique()}")
    print(f"  Sessions covered: {', '.join(sorted(mkt['session'].dropna().unique()))}")

    # Arb candidates
    latest = mkt[mkt["scan_id"] == mkt["scan_id"].max()]
    arb = latest[latest["combined"] < 0.97]
    print(f"\n  Arb candidates (combined < 0.97): {len(arb)}")
    if not arb.empty:
        for _, row in arb.head(5).iterrows():
            print(f"    {row['platform']} | {row['category']} | combined={row['combined']:.3f} | {row['title'][:50]}")

    # Category breakdown
    print(f"\n  Category breakdown (latest scan):")
    cat_latest = cat_df[cat_df["scan_id"] == cat_df["scan_id"].max()].sort_values("total_volume", ascending=False)
    for _, row in cat_latest.head(10).iterrows():
        print(f"    {row['platform']:12s} {row['category']:15s} {row['count']:4d} mkts  spread={row['avg_spread_pct']:.1f}%  vol=${row['total_volume']:,.0f}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Analyze cross-market data")
    parser.add_argument("--data-dir", type=str, default="./data", help="Directory with CSV files")
    parser.add_argument("--out-dir", type=str, default="./market-plots", help="Output directory for plots")
    parser.add_argument("--min-scans", type=int, default=1, help="Minimum scans required for time-series plots")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading data from {data_dir}...")
    mkt = load_market_snapshots(data_dir)
    cat_df = load_category_snapshots(data_dir)
    spread_ts = load_spread_timeseries(data_dir)

    print_summary(mkt, cat_df, spread_ts)

    print(f"\nGenerating plots to {out_dir}/...\n")

    # Always generate (single-scan OK)
    plot_spread_by_category(mkt, out_dir)
    plot_combined_price_distribution(mkt, out_dir)
    plot_liquidity_vs_spread(mkt, out_dir)

    # Need multiple scans for time-series
    n_scans = mkt["scan_id"].nunique()
    if n_scans >= args.min_scans:
        plot_spread_heatmap_by_hour(spread_ts, out_dir)
        plot_category_spread_timeline(cat_df, out_dir)
        plot_session_comparison(spread_ts, out_dir)
        plot_top_mispriced_timeline(spread_ts, out_dir)
        plot_day_of_week(mkt, out_dir)
    else:
        print(f"\n  ⏳ Only {n_scans} scan(s) so far. Time-series plots need >= {args.min_scans}.")
        print(f"     Let the collector run longer, then re-run this script.")

    print(f"\n✅ Done. Plots saved to {out_dir}/")


if __name__ == "__main__":
    main()
