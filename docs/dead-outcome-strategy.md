# Dead-Outcome (Dust) Probe Strategy

This strategy monitors Polymarket orderbooks for **dust-priced** legs (e.g., 1–5¢) and logs when they appear. It also tracks the **eventual market outcome** so you can estimate the win rate of these late, low-price entries.

## What it does

- Subscribes to the Polymarket aggregated orderbook for a chosen market.
- Logs when a YES/NO ask price crosses a configured dust threshold (e.g., 0.01, 0.02, 0.03, 0.05).
- Records dust events per market and fetches the **resolved outcome** once the market closes.
- Reports per-market and overall win rates for dust events.

## Usage

```bash
bun run src/strategies/dead-outcome.ts
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `MARKET_SOURCE` | `crypto` | `crypto` (uses up/down crypto markets) or `neg_risk` (uses all active binary markets). |
| `SYMBOL` | `btc` | Crypto symbol to track (crypto mode only). |
| `TIMEFRAME` | `15m` | `15m`, `1h`, or `4h` (crypto mode only). |
| `MARKET_QUERY` | *(empty)* | Substring filter against market slug/title (neg_risk only). |
| `MAX_MARKETS` | `100` | Max markets to scan when using `neg_risk`. |
| `LOW_PRICE_THRESHOLDS` | `0.01,0.02,0.03,0.05` | Dust thresholds to log (in price units). |
| `REFRESH_MS` | `1500` | How often to log a snapshot. |
| `RECHECK_MS` | `10000` | How often to check for market rotation/outcome updates. |

## Notes

- **Outcome tracking**: The strategy queries the Polymarket data API for resolved outcomes. If a market closes before the outcome is published, it is queued and retried on subsequent checks.
- **Extending beyond crypto**: Use `MARKET_SOURCE=neg_risk` and a `MARKET_QUERY` to monitor any active binary market.
