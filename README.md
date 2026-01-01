# poly-arb

[![Build](https://github.com/SebastianBoehler/poly-arb/actions/workflows/build.yml/badge.svg)](https://github.com/SebastianBoehler/poly-arb/actions/workflows/build.yml)

Real-time Polymarket arbitrage ladder bot for all binary (neg_risk) markets.

## Overview

This bot monitors **all active binary markets** on Polymarket (neg_risk markets with Yes/No outcomes) and uses a ladder DCA strategy to find arbitrage opportunities by buying both outcomes when the combined price is favorable.

## Strategy

### The Core Arbitrage Opportunity

In binary prediction markets, a YES token and a NO token always resolve to a combined payout of exactly **$1.00** (one of them pays $1, the other pays $0). This creates a risk-free arbitrage opportunity whenever:

```
Best Ask (YES) + Best Ask (NO) < 1.00
```

**Example:** If you can buy YES at $0.48 and NO at $0.50, you pay $0.98 total and are guaranteed to receive $1.00 when the market resolves. That's a **2% risk-free profit** (minus fees).

### Why This Works

1. **Guaranteed Payout**: One outcome MUST happen - either YES wins or NO wins
2. **Fixed Return**: The winning token always pays exactly $1.00
3. **No Directional Risk**: You don't need to predict the outcome - you profit regardless of which side wins

### Two Approaches

#### 1. Instant Arbitrage (Combined < 1.0)

When `bestAskYes + bestAskNo < 1.0`, you can immediately fill both sides and lock in profit:

```
Buy 100 YES @ $0.48 = $48.00
Buy 100 NO  @ $0.50 = $50.00
Total Cost:          $98.00
Guaranteed Payout:  $100.00
Profit:               $2.00 (2.04% ROI)
```

This is the **ideal scenario** - pure arbitrage with no execution risk if both orders fill.

#### 2. Ladder DCA Strategy (Combined ≈ 1.0)

When combined prices hover around 1.0, the bot uses dollar-cost averaging:

- **Initial entry** when combined < threshold (e.g., 1.005)
- **Add to position** on price drops (ladder levels)
- **Exponential sizing** to lower average cost faster
- **Target**: Get average combined cost below fee-adjusted payout

### Math

- **Fee-adjusted payout**: `1 - 0.02 * (1 - max_leg_price)`
- **Edge**: `payout - combined_cost`
- **Profitable** when edge > 0

### Real-World Considerations

- **Fees**: Polymarket charges ~2% on profits, reducing effective edge
- **Execution Risk**: Both sides must fill; partial fills create directional exposure
- **Liquidity**: Large orders may not fill at quoted prices
- **Speed**: These opportunities are fleeting - milliseconds matter

## Project Structure

```
poly-arb/
├── src/
│   ├── core/                    # Core business logic
│   │   ├── types.ts             # Shared types
│   │   └── gamma.ts             # Gamma API client (market fetching)
│   ├── strategies/              # Trading strategies
│   │   └── trading.ts           # Order placement logic
│   ├── stats/                   # Statistics tracking
│   │   ├── stats.ts             # Stats streaming
│   │   └── utils.ts             # Stats utilities
│   └── index.ts                 # Main entry point (ladder strategy)
├── scripts/
│   └── analyze_stats.py         # Python analysis script
├── tests/                       # Bun test suite
│   ├── core/
│   ├── stats/
│   └── strategies/
├── data/                        # Output data files
└── plots/                       # Generated plots
```

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
# Run ladder strategy (main bot)
bun run start

# Run trading script (order placement)
bun run trading

# Run stats collection
bun run stats

# Run tests
bun test

# Type check
bun run typecheck

# Custom parameters
LADDER_STEP=0.005 SIZE_MULTIPLIER=2.0 bun run start
```

Real-time streaming reference: [docs/realtime-guide.md](docs/realtime-guide.md)

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

## Analysis & Insights

The bot tracks market inefficiencies across crypto 15-minute prediction markets. Run the analysis script to generate visualizations:

```bash
python scripts/analyze_stats.py --csv output.csv --out-dir plots
```

### Market Inefficiency

Shows the percentage of price updates where combined YES+NO ask prices fall below various thresholds. Combined < 1.0 represents an arbitrage opportunity (before fees).

![Market Inefficiency](plots/market_inefficiency.png)

### Inefficiency by Symbol

Compares arbitrage opportunity frequency across different crypto assets.

![Inefficiency by Symbol](plots/inefficiency_by_symbol.png)

### Hit Rates by Threshold

Detailed breakdown of hit rates per symbol across all tracked thresholds.

![Hit Rates](plots/hit_rates_per_symbol.png)

## Disclaimer

This is for educational purposes only. Trading on prediction markets involves risk. Do your own research before trading.

## License

[MIT](LICENSE)
