# poly-arb

[![Build](https://github.com/SebastianBoehler/poly-arb/actions/workflows/build.yml/badge.svg)](https://github.com/SebastianBoehler/poly-arb/actions/workflows/build.yml)

Real-time Polymarket arbitrage ladder bot for all binary (neg_risk) markets.

## Overview

This bot monitors **all active binary markets** on Polymarket (neg_risk markets with Yes/No outcomes) and uses a ladder DCA strategy to find arbitrage opportunities by buying both outcomes when the combined price is favorable.

## Strategy

For binary markets on Polymarket:

- **Stream real-time prices** via WebSocket using `@polymarket/real-time-data-client`
- **Ladder DCA**: Only enter when combined price is below threshold
- **Exponential sizing**: Increase position size on price drops
- **Target**: Combined avg cost < fee-adjusted payout

### Math

- **Fee-adjusted payout**: `1 - 0.02 * (1 - max_leg_price)`
- **Edge**: `payout - combined_cost`
- **Profitable** when edge > 0

## Requirements

- [Bun](https://bun.sh/) runtime

## Installation

```bash
git clone https://github.com/SebastianBoehler/poly-arb.git
cd poly-arb
bun install
```

## Usage

```bash
# Run with defaults (5 min)
bun run start

# Custom parameters
DURATION_SEC=600 LADDER_STEP=0.005 SIZE_MULTIPLIER=2.0 bun run start
```

## Configuration

| Variable               | Default | Description                               |
| ---------------------- | ------- | ----------------------------------------- |
| `DURATION_SEC`         | 300     | How long to run (seconds)                 |
| `BASE_SIZE_USDC`       | 5       | Base USD per ladder level                 |
| `LADDER_STEP`          | 0.01    | Combined price drop to trigger next level |
| `SIZE_MULTIPLIER`      | 1.5     | Multiply size at each ladder level        |
| `MAX_INITIAL_COMBINED` | 1.005   | Only enter if combined < this             |
| `MAX_MARKETS`          | 100     | Maximum number of markets to track        |

## How It Works

1. Fetches all active `neg_risk` binary markets from Polymarket CLOB API
2. Subscribes to real-time price updates via WebSocket (`clob_market` topic)
3. Waits for favorable combined price (< `MAX_INITIAL_COMBINED`)
4. Enters position and applies ladder DCA on price drops
5. Reports edge and profitability in real-time

## Example Output

```
Fetching ALL active neg_risk (binary) markets from CLOB API...
Found 100 active neg_risk (binary) markets

=== REAL-TIME LADDER ACCUMULATION ===
Markets: 100, Token IDs: 200
Duration: 300s (~5.0 min)

📈 russia-x-ukraine-ceasefire-in-  L1: comb=1.0010 avg=1.0010 edge=-0.10% ❌
📈 dogecoin-all-time-high-before-  L1: comb=1.0020 avg=1.0020 edge=-0.20% ❌
📈 btc-updown-15m-1767139200       L1: comb=0.9900 avg=0.9900 edge=0.20% ✅

--- 60s elapsed ---
✅ PROFITABLE (1):
  btc-updown-15m-1767139200: L1 avg=0.9900 edge=0.20%
```

## Disclaimer

This is for educational purposes only. Trading on prediction markets involves risk. Do your own research before trading.

## License

[MIT](LICENSE)
