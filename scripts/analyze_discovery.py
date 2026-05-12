#!/usr/bin/env python3
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


def expiry_from_slug(slug):
    match = re.search(r"-(\d{10})$", slug)
    return int(match.group(1)) if match else None


def symbol_from_slug(slug):
    return slug.split("-")[0] if slug else "unknown"


def load_events(path):
    snapshots = []
    signals = []
    skipped = 0
    with Path(path).open() as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if event.get("kind") == "snapshot":
                snapshots.append(event)
            elif event.get("kind") == "signal":
                signals.append(event)
    return snapshots, signals, skipped


def bucket_ttl(seconds):
    if seconds is None:
        return "unknown"
    minutes = seconds / 60
    if minutes < 2:
        return "<2m"
    if minutes < 5:
        return "2-5m"
    if minutes < 10:
        return "5-10m"
    if minutes < 15:
        return "10-15m"
    return "15m+"


def summarize_group(rows):
    if not rows:
        return None
    fillable = [r for r in rows if r["sweep"].get("fillable")]
    edge_rows = fillable if fillable else rows
    edges = [r["sweep"]["edge_cents"] for r in edge_rows]
    combined = [r["combined_best_ask"] for r in rows]
    depths = [r.get("top_depth_usdc", 0) for r in rows]
    positive = [r for r in rows if r["sweep"].get("fillable") and r["sweep"]["edge_cents"] > 0]
    return {
        "count": len(rows),
        "fillable_pct": len(fillable) / len(rows) * 100,
        "positive_pct": len(positive) / len(rows) * 100,
        "best_edge": max(edges),
        "avg_edge": sum(edges) / len(edges),
        "min_combined": min(combined),
        "avg_depth": sum(depths) / len(depths),
    }


def print_table(title, grouped):
    print(f"\n{title}")
    print("group,count,fillable_pct,positive_pct,best_edge_cents,avg_edge_cents,min_combined,avg_top_depth_usdc")
    for key, rows in sorted(grouped.items()):
        summary = summarize_group(rows)
        if not summary:
            continue
        print(
            f"{key},{summary['count']},{summary['fillable_pct']:.1f},"
            f"{summary['positive_pct']:.1f},{summary['best_edge']:.3f},"
            f"{summary['avg_edge']:.3f},{summary['min_combined']:.4f},"
            f"{summary['avg_depth']:.2f}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", default="data/discovery-live.jsonl")
    parser.add_argument("--top", type=int, default=12)
    args = parser.parse_args()

    rows, signals, skipped = load_events(args.path)
    if not rows:
        raise SystemExit(f"No snapshot rows found in {args.path}")

    for row in rows:
        expiry = expiry_from_slug(row["slug"])
        timestamp_sec = row["timestamp_ns"] / 1_000_000_000
        row["symbol"] = symbol_from_slug(row["slug"])
        row["ttl_bucket"] = bucket_ttl(expiry - timestamp_sec if expiry else None)

    print(f"Snapshots: {len(rows)}")
    print(f"Markets: {len({r['condition_id'] for r in rows})}")
    print(f"Signals: {len(signals)}")
    if skipped:
        print(f"Skipped incomplete/non-JSON lines: {skipped}")

    top = sorted(
        [r for r in rows if r["sweep"].get("fillable")],
        key=lambda r: r["sweep"]["edge_cents"],
        reverse=True,
    )[: args.top]
    print("\nTop snapshots")
    print("edge_cents,combined,best_combined,depth,yes_slip_bps,no_slip_bps,ttl_bucket,slug")
    for row in top:
        sweep = row["sweep"]
        print(
            f"{sweep['edge_cents']:.3f},{sweep['combined_avg_price']:.4f},"
            f"{row['combined_best_ask']:.4f},{row.get('top_depth_usdc', 0):.2f},"
            f"{sweep['yes']['slippage_bps']:.2f},{sweep['no']['slippage_bps']:.2f},"
            f"{row['ttl_bucket']},{row['slug']}"
        )

    by_symbol = defaultdict(list)
    by_ttl = defaultdict(list)
    for row in rows:
        by_symbol[row["symbol"]].append(row)
        by_ttl[row["ttl_bucket"]].append(row)

    print_table("By symbol", by_symbol)
    print_table("By time-to-expiry", by_ttl)

    if signals:
        by_type = defaultdict(list)
        for signal in signals:
            by_type[signal.get("type", "unknown")].append(signal)
        print("\nSignals by type")
        print("type,count,best_score,best_edge_cents,avg_depth")
        for signal_type, group in sorted(by_type.items()):
            scores = [row.get("score", 0) for row in group]
            edges = [row.get("edge_cents", 0) for row in group]
            depths = [row.get("executable_depth_usdc", 0) for row in group]
            print(
                f"{signal_type},{len(group)},{max(scores):.2f},"
                f"{max(edges):.3f},{sum(depths) / len(depths):.2f}"
            )


if __name__ == "__main__":
    main()
