# Polymarket Market Discovery Findings

Finalized: 2026-05-15.

## Collection Status

The all-market Gamma collector and hourly Codex heartbeat automation were stopped after the dataset became large enough for offline strategy discovery.

- Automation deleted: `polymarket-overnight-discovery`.
- Collector screen stopped: `polyarb-gamma-all`.
- Old C++ broad CLOB depth collector remains stopped; it produced no JSONL rows and repeatedly hit timeout/parse errors.

## Dataset Inventory

Collected all-market Polymarket top-of-book snapshots across two output directories:

- `data/all-polymarket-20260512T171924Z/`
- `data/all-polymarket-20260514T194748Z/`

Final combined sample:

- First snapshot: `2026-05-12T17:19:27Z`.
- Last snapshot: `2026-05-15T05:43:29Z`.
- Duration: about `2 days 12 hours 24 minutes`.
- Scans: `711`.
- Market snapshot rows: `1,771,673`.
- Unique markets: `21,902`.

This is sufficient for first-pass strategy discovery and paper backtesting.

## Backtest Model

The current backtester is intentionally conservative for top-of-book CSV data:

- Entry: buy YES or NO at the recorded ask.
- Exit: sell after the configured horizon at synthetic bid `1 - opposite_ask`.
- This penalizes spread.
- It does not model queue priority, order book depth, partial fills, fees, or latency.

The backtester is in `scripts/backtest_strategies.py`.

## Strategy Results

Simple unfiltered strategy families were not profitable.

Earlier full-sample run on the first long dataset:

| Strategy | Trades | PnL | Win Rate | Profit Factor |
|---|---:|---:|---:|---:|
| `momentum_30m` | 1067 | -1319.11 | 12.6% | 0.17 |
| `fade_30m` | 1067 | -2086.79 | 9.2% | 0.24 |
| `momentum_60m` | 764 | -733.85 | 12.4% | 0.25 |
| `fade_60m` | 764 | -1454.68 | 9.6% | 0.21 |
| `compression_follow` | 270 | -163.54 | 17.4% | 0.30 |
| `compression_fade` | 270 | -338.77 | 13.7% | 0.35 |

Restart-window run:

| Strategy | Trades | PnL | Win Rate | Profit Factor |
|---|---:|---:|---:|---:|
| `momentum_30m` | 148 | -91.70 | 15.5% | 0.32 |
| `fade_30m` | 148 | -476.52 | 6.1% | 0.05 |
| `momentum_60m` | 95 | -71.11 | 8.4% | 0.12 |
| `fade_60m` | 95 | -220.77 | 3.2% | 0.00 |
| `compression_follow` | 52 | -3.98 | 25.0% | 0.88 |
| `compression_fade` | 52 | -93.70 | 11.5% | 0.39 |

Main conclusion: naive momentum and naive fade are not viable on this top-of-book model. Spread and adverse selection dominate.

## Promising Directions

`compression_follow` is the least bad family and should be the first target for refinement. It was still negative overall, but it came closest to break-even in the restart window.

Potential next filters:

- Category-specific rules instead of global thresholds.
- Exclude stale/completed sports and tennis markets more aggressively.
- Require repeated tightness before entry.
- Require stable volume growth, not just absolute volume.
- Avoid extreme YES prices near 0 or 1 unless testing settlement/near-expiry logic.
- Run BTC/ETH/Tech-specific variants separately.
- Add full order book depth before considering live execution.

Specific observations:

- BTC/ETH often have tight spreads, but large threshold moves are mostly near-expiry settlement effects, not clean alpha.
- Esports and Tennis provide large volume but many stale/completed or very wide books.
- Weather has enough data for source-based strategies, but price-only momentum was weak.
- Finance/Sports wide books are source-research leads, not automatic trading signals.

## Next Build Recommendation

Implement a second-generation backtester before live trading:

- Add category-specific strategy configs.
- Add slippage/depth from order books.
- Add fee assumptions.
- Add train/test split by time.
- Add per-category reports with minimum sample thresholds.
- Add signal export for live paper trading only.

Do not live trade the current simple strategies.
