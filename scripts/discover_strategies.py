#!/usr/bin/env python3
"""Discover simple strategy candidates from collected Polymarket snapshots."""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path
from statistics import median


def fnum(row: dict[str, str], key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except ValueError:
        return 0.0


def is_tradeable(row: dict[str, str]) -> bool:
    title = row.get("title", "").lower()
    yes = fnum(row, "yes_price")
    no = fnum(row, "no_price")
    if "completed match" in title or "completed game" in title:
        return False
    if abs(yes - 0.5) < 1e-9 and abs(no - 0.5) < 1e-9:
        return False
    return True


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    rows.sort(key=lambda r: (r["id"], int(r["scan_id"])))
    return rows


def by_market(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        if fnum(row, "yes_price") > 0 and fnum(row, "no_price") > 0 and is_tradeable(row):
            grouped[row["id"]].append(row)
    return grouped


def fmt_row(row: dict[str, str], extra: str = "") -> str:
    return (
        f"- `{row['category']}` vol={fnum(row, 'volume'):.0f} "
        f"spread={fnum(row, 'spread_pct'):.2f}% yes={fnum(row, 'yes_price'):.3f} "
        f"{extra} {row['title'][:120]}"
    )


def latest_rows(grouped: dict[str, list[dict[str, str]]], latest_scan: int) -> list[dict[str, str]]:
    return [rows[-1] for rows in grouped.values() if rows and int(rows[-1]["scan_id"]) == latest_scan]


def is_recent(rows: list[dict[str, str]], latest_scan: int, max_age: int = 2) -> bool:
    return bool(rows) and int(rows[-1]["scan_id"]) >= latest_scan - max_age


def persistent_tight(grouped: dict[str, list[dict[str, str]]], latest_scan: int, limit: int) -> list[str]:
    scored = []
    for rows in grouped.values():
        if len(rows) < 20 or not is_recent(rows, latest_scan):
            continue
        spreads = [fnum(r, "spread_pct") for r in rows[-30:]]
        vols = [fnum(r, "volume") for r in rows[-30:]]
        if median(spreads) <= 2 and max(vols) >= 100:
            scored.append((max(vols), -median(spreads), rows[-1]))
    scored.sort(reverse=True, key=lambda x: (x[0], x[1]))
    return [fmt_row(r, f"median30_spread={-neg_spread:.2f}%") for _, neg_spread, r in scored[:limit]]


def momentum_candidates(grouped: dict[str, list[dict[str, str]]], latest_scan: int, limit: int) -> list[str]:
    scored = []
    for rows in grouped.values():
        if len(rows) < 7 or not is_recent(rows, latest_scan):
            continue
        prev, cur = rows[-7], rows[-1]
        delta = fnum(cur, "yes_price") - fnum(prev, "yes_price")
        if abs(delta) >= 0.08 and fnum(cur, "volume") >= 100 and fnum(cur, "spread_pct") <= 8:
            scored.append((abs(delta), fnum(cur, "volume"), delta, cur))
    scored.sort(reverse=True, key=lambda x: (x[0], x[1]))
    return [fmt_row(r, f"move_6scans={delta:+.3f}") for _, _, delta, r in scored[:limit]]


def spread_compression(grouped: dict[str, list[dict[str, str]]], latest_scan: int, limit: int) -> list[str]:
    scored = []
    for rows in grouped.values():
        if len(rows) < 10 or not is_recent(rows, latest_scan):
            continue
        old = [fnum(r, "spread_pct") for r in rows[-20:-5]]
        cur = fnum(rows[-1], "spread_pct")
        if old and median(old) >= 10 and cur <= 3 and fnum(rows[-1], "volume") >= 100:
            scored.append((median(old) - cur, fnum(rows[-1], "volume"), median(old), rows[-1]))
    scored.sort(reverse=True, key=lambda x: (x[0], x[1]))
    return [fmt_row(r, f"spread_compressed={old_med:.2f}%->{fnum(r, 'spread_pct'):.2f}%") for _, _, old_med, r in scored[:limit]]


def wide_liquid(latest: list[dict[str, str]], limit: int) -> list[str]:
    rows = [
        r for r in latest
        if fnum(r, "volume") >= 100 and fnum(r, "spread_pct") >= 20
    ]
    rows.sort(key=lambda r: (fnum(r, "spread_pct"), fnum(r, "volume")), reverse=True)
    return [fmt_row(r, "wide_book") for r in rows[:limit]]


def backtest_momentum(grouped: dict[str, list[dict[str, str]]], lookback: int = 6) -> list[str]:
    stats: dict[str, list[float]] = defaultdict(list)
    for rows in grouped.values():
        if len(rows) <= lookback + 1:
            continue
        for idx in range(lookback, len(rows) - 1):
            cur = rows[idx]
            if fnum(cur, "volume") < 100 or fnum(cur, "spread_pct") > 8:
                continue
            move = fnum(cur, "yes_price") - fnum(rows[idx - lookback], "yes_price")
            if abs(move) < 0.05:
                continue
            nxt = fnum(rows[idx + 1], "yes_price") - fnum(cur, "yes_price")
            stats[cur["category"]].append(nxt if move > 0 else -nxt)
    out = []
    for cat, vals in sorted(stats.items(), key=lambda kv: len(kv[1]), reverse=True):
        if len(vals) < 10:
            continue
        hit = sum(1 for v in vals if v > 0) / len(vals)
        avg = sum(vals) / len(vals)
        out.append(f"- `{cat}` signals={len(vals)} hit_next={hit:.1%} avg_next={avg:+.4f}")
    return out[:12]


def write_report(rows: list[dict[str, str]], out: Path | None, limit: int) -> str:
    grouped = by_market(rows)
    latest_scan = max(int(r["scan_id"]) for r in rows)
    latest = latest_rows(grouped, latest_scan)
    lines = [
        "# Strategy Discovery Snapshot",
        "",
        f"- latest_scan: `{latest_scan}`",
        f"- markets: `{len(grouped)}`",
        f"- latest_markets: `{len(latest)}`",
        "",
        "## Momentum Backtest",
        *backtest_momentum(grouped),
        "",
        "## Momentum Candidates",
        *momentum_candidates(grouped, latest_scan, limit),
        "",
        "## Spread Compression Candidates",
        *spread_compression(grouped, latest_scan, limit),
        "",
        "## Persistent Tight/Liquid Markets",
        *persistent_tight(grouped, latest_scan, limit),
        "",
        "## Wide Liquid Books For Passive/Source Research",
        *wide_liquid(latest, limit),
        "",
    ]
    text = "\n".join(lines)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n")
    return text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=Path("data/all-polymarket-20260512T171924Z/market-snapshots.csv"))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()
    print(write_report(load_rows(args.csv), args.out, args.limit))


if __name__ == "__main__":
    main()
