# Polymarket CLOB API Reference

This document provides an overview of the Polymarket CLOB (Central Limit Order Book) API for use in this arbitrage trading bot.

## Quick Links

- **Methods Overview**: https://docs.polymarket.com/developers/CLOB/clients/methods-overview
- **L2 Methods (Trading)**: https://docs.polymarket.com/developers/CLOB/clients/methods-l2
- **Batch Orders**: https://docs.polymarket.com/developers/CLOB/orders/create-order-batch
- **Orders Overview**: https://docs.polymarket.com/developers/CLOB/orders/orders
- **TypeScript Client**: https://github.com/Polymarket/clob-client
- **Python Client**: https://github.com/Polymarket/py-clob-client
- **WebSocket API**: https://docs.polymarket.com/developers/CLOB/websocket
- **Trading Guide**: https://docs.polymarket.com/developers/market-makers/trading
- **Examples**: https://github.com/Polymarket/clob-client/tree/main/examples
- **Check Scoring**: https://docs.polymarket.com/developers/CLOB/orders/check-scoring
- **Inventory**: https://docs.polymarket.com/developers/market-makers/inventory
- **User Activity**: https://docs.polymarket.com/api-reference/core/get-user-activity
- **Closed Positions**: https://docs.polymarket.com/api-reference/core/get-closed-positions-for-a-user
- **Market Channel**: https://docs.polymarket.com/developers/CLOB/websocket/market-channel

## Client Initialization

### Public (No Auth)

```typescript
const client = new ClobClient("https://clob.polymarket.com", 137);
const markets = await client.getMarkets();
const book = await client.getOrderBook(tokenId);
```

### L2 (Trading - Requires Credentials)

```typescript
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const signer = new Wallet(process.env.PRIVATE_KEY);
const temp = new ClobClient("https://clob.polymarket.com", 137, signer);
const creds = await temp.createOrDeriveApiKey();

const client = new ClobClient(
  "https://clob.polymarket.com",
  137,
  signer,
  creds,
  2, // Signature type (2 = Gnosis Safe proxy)
  funderAddress, // Safe wallet address holding funds
);
```

## Order Types

| Type    | Description                                                          |
| ------- | -------------------------------------------------------------------- |
| **GTC** | Good-Til-Cancelled - Limit order active until fulfilled or cancelled |
| **GTD** | Good-Til-Date - Active until specified UTC timestamp                 |
| **FOK** | Fill-Or-Kill - Must execute immediately in entirety or cancel        |
| **FAK** | Fill-And-Kill - Execute as much as possible immediately, cancel rest |

## Key Methods

### Order Creation

#### `createOrder()` - Create a signed limit order

```typescript
const order = await client.createOrder({
  tokenID: string,    // Token to trade
  price: number,      // Limit price (0.01 - 0.99)
  size: number,       // Number of shares
  side: Side.BUY | Side.SELL,
  feeRateBps?: number,
  expiration?: number, // For GTD orders
});
```

#### `createMarketOrder()` - Create a signed market order

```typescript
const order = await client.createMarketOrder({
  tokenID: string,
  amount: number,     // USDC amount for BUY, shares for SELL
  side: Side.BUY | Side.SELL,
  price?: number,     // Optional price limit
});
```

### Order Posting

#### `postOrder()` - Post a single order

```typescript
const result = await client.postOrder(order, OrderType.GTC);
```

#### `postOrders()` - Post multiple orders in batch (RECOMMENDED)

```typescript
// Create orders first (can be parallel)
const orders = await Promise.all([
  client.createOrder({ tokenID: yesTokenId, side: Side.BUY, price: 0.48, size: 100 }),
  client.createOrder({ tokenID: noTokenId, side: Side.BUY, price: 0.48, size: 100 }),
]);

// Post as batch - single API call, faster execution
const results = await client.postOrders(orders.map((order) => ({ order, orderType: OrderType.FOK })));
```

**Batch limit**: Up to 15 orders per batch.

#### `createAndPostOrder()` - Create and post in one call

```typescript
const result = await client.createAndPostOrder({ tokenID, price: 0.5, size: 100, side: Side.BUY }, { tickSize: "0.01" }, OrderType.GTC);
```

#### `createAndPostMarketOrder()` - Market order in one call

```typescript
const result = await client.createAndPostMarketOrder({ tokenID, amount: 50, side: Side.BUY, price: 0.55 }, {}, OrderType.FAK);
```

### Order Management

```typescript
await client.cancelOrder(orderId);
await client.cancelOrders([orderId1, orderId2]);
await client.cancelAll();
await client.cancelMarketOrders(conditionId);
```

### Order Queries

```typescript
const order = await client.getOrder(orderId);
const openOrders = await client.getOpenOrders();
const trades = await client.getTrades();
```

## Response Format

```typescript
interface OrderResponse {
  success: boolean;
  errorMsg: string;
  orderID: string;
  transactionsHashes: string[];
  status: string;
  takingAmount: string; // Shares received
  makingAmount: string; // USDC spent
}
```

## WebSocket Real-Time Data

```typescript
import { RealTimeDataClient, ConnectionStatus } from "@polymarket/real-time-data-client";

const client = new RealTimeDataClient({
  autoReconnect: true,
  onMessage: (c, message) => {
    const { topic, type, payload } = message;
    if (topic === "clob_market" && type === "agg_orderbook") {
      const { asset_id, asks, bids } = payload;
      // asks/bids: [{ price: string, size: string }, ...]
    }
  },
  onConnect: (c) => {
    c.subscribe({
      subscriptions: [
        {
          topic: "clob_market",
          type: "agg_orderbook",
          filters: JSON.stringify([tokenId1, tokenId2]),
        },
      ],
    });
  },
});

client.connect();
```

## Arbitrage Strategy Notes

### Why Batch Orders?

- **Single API call** for multiple orders = faster execution
- Both orders hit the matching engine closer together
- Reduces risk of one side filling before the other

### Recommended Flow for Arb

1. Monitor orderbook via WebSocket for `bestAskYes + bestAskNo < threshold`
2. Check liquidity depth on both sides
3. Create both orders with `createOrder()` (parallel)
4. Post both with `postOrders()` using `OrderType.FOK`
5. If partial fill, rollback by selling the filled side

### Price Considerations

- Polymarket has NO market orders - all orders are limit orders
- To execute immediately: set limit price = best ask (for buys)
- Add slippage buffer to increase fill probability
- Use FOK for "all-or-nothing" per order (but not atomic across both)

### Fees

- Current fees: **0% for both makers and takers**
- Fee calculation details in CLOB Introduction docs

## Environment Variables

```bash
PRIVATE_KEY=0x...           # Wallet private key
FUNDER_ADDRESS=0x...        # Gnosis Safe address holding funds
SIGNATURE_TYPE=2            # 1 = EOA, 2 = Gnosis Safe proxy
SIZE_USDC=5                 # Size per leg in USDC
TRIGGER_COMBINED=0.98       # Trigger when sum < this
MAX_COMBINED=0.99           # Max price with slippage
DRY_RUN=true                # Set to "false" for live trading
```

## Project Scripts

```bash
# Run arbitrage smoke test
bun run src/scripts/arb-smoke.ts

# Run laddering strategy
bun run src/scripts/laddering-smoke.ts

# Run stats collection
bun run src/stats/stats.ts

# Analyze collected stats
bun run src/scripts/analyze-markets.ts

# Copy trading (monitor wallets and mirror trades)
COPY_WALLETS=0xabc,0xdef DRY_RUN=true bun run copy-trade

# Cross-market opportunity analysis (one-shot)
bun run analyze

# Cross-market analysis (continuous + CSV export)
DAEMON=true CSV=true bun run analyze
```

## Copy Trading

Monitors target Polymarket wallets and mirrors their trades in real-time.

**Architecture:**

- `src/services/wallet-monitor.ts` — Polls `data-api.polymarket.com/activity` for target wallet trades
- `src/strategies/copy-trade.ts` — Strategy entry point with size scaling, slippage limits, market filtering

**Key env vars:**

```bash
COPY_WALLETS=0xabc,0xdef   # Comma-separated wallet addresses
COPY_SCALE=1.0             # Size multiplier (0.5 = half, 2.0 = double)
COPY_MAX_SLIPPAGE=0.03     # Max price slippage (3 cents)
COPY_MAX_USDC=50           # Max USDC per copy trade
DRY_RUN=true               # Simulate without executing
```

**Flow:**

1. Seed: fetch existing trades to avoid copying old history
2. Poll every 5s for new trades (dedup by tx hash)
3. For each new trade: scale size, check filters, execute via CLOB with FOK

## Cross-Market Opportunity Finder

Scans Polymarket (all categories) and Kalshi for exploitable edges.

**Architecture:**

- `src/services/market-data.ts` — Fetches/normalizes data from Polymarket Gamma API, Kalshi API, CLOB orderbook
- `src/services/opportunity-finder.ts` — Analysis engine: intra-spread, cross-platform arb, timezone edge, category inefficiency
- `src/scripts/analyze-markets.ts` — CLI entry point (one-shot or daemon mode)

**Opportunity types detected:**

1. **Intra-platform mispricing** — YES+NO < 0.97 on same platform
2. **Cross-platform arbitrage** — Same event priced differently on Polymarket vs Kalshi
3. **Timezone edge** — US markets with stale pricing during Asian hours (and vice versa)
4. **Category inefficiency** — Categories with abnormally wide spreads vs market average

**Data sources:**

- Polymarket Gamma API (`gamma-api.polymarket.com/events`) — all categories (crypto, sports, politics, esports, etc.)
- Polymarket CLOB API (`clob.polymarket.com/book`) — real orderbook prices
- Kalshi API (`api.elections.kalshi.com/trade-api/v2/markets`) — politics, sports, weather, economics

**Key env vars:**

```bash
INCLUDE_KALSHI=true        # Include Kalshi markets
MAX_PAGES=10               # Polymarket pages to fetch (50 markets/page)
DAEMON=true                # Continuous scanning mode
ANALYSIS_INTERVAL_MS=60000 # Scan interval
CSV=true                   # Export to opportunities.csv
```

**Research references:**

- Stömmer 2023 — "Beating the average" (sports betting inefficiency)
- Lopez-Lira 2023 — "Can ChatGPT Forecast Stock Price Movements?" (LLM news edge)
- Sarkar 2023 — "Deep Q-Learning for Statistical Arbitrage in HFT" (RL for arb)

## Market Data Collector & Analysis Plots

Long-running data collector that snapshots all markets every N minutes, then a Python script generates plots for offline analysis.

**Architecture:**

- `src/scripts/collect-market-data.ts` — Periodic scanner, writes CSVs to `./data/`
- `bun run src/scripts/analyze-markets.ts` — Generates market opportunity summaries from collected data

**Outputs (CSVs in `./data/`):**

- `market-snapshots.csv` — Per-market row every scan (id, title, category, prices, spread, volume, hour, session, day)
- `category-snapshots.csv` — Per-category aggregate every scan
- `spread-timeseries.csv` — Lightweight per-market spread+combined over time

**Plots generated (in `./market-plots/`):**

1. Spread distribution by category (boxplot)
2. Spread heatmap by hour-of-day (timezone patterns)
3. Category spread evolution over time
4. Combined price distribution (arb detection)
5. Liquidity vs spread scatter
6. Session comparison (Asia/EU/US)
7. Top mispriced markets over time
8. Day-of-week patterns

**Usage:**

```bash
# Start collector (runs in background, Ctrl+C to stop)
bun run collect

# Custom interval (2 min) and more pages
INTERVAL_MS=120000 MAX_PAGES=15 bun run collect

# Generate market summaries from collected data
bun run plots

# Minimum scans for market summaries
bun run plots
```

**Key env vars:**

```bash
INTERVAL_MS=300000       # Scan interval (default 5 min)
MAX_PAGES=10             # Polymarket pages to fetch
INCLUDE_KALSHI=true      # Include Kalshi data
OUT_DIR=./data           # Output directory for CSVs
```

## Market Making Strategy

Places GTC limit orders on both YES and NO sides of binary markets with moderate spreads, capturing the bid-ask spread when both sides fill.

**Architecture:**

- `src/strategies/market-maker.ts` — Strategy entry point: scans for candidates, places/manages orders, tracks inventory and round-trips

**How it works:**

1. Scan Polymarket for binary markets with 2-20% spread and decent volume
2. Score markets by spread × volume × liquidity × price balance × time-to-expiry
3. Place GTC BUY orders on both YES and NO inside the spread (at `bestBid + spread × capture_fraction`)
4. When both sides fill → round-trip complete → profit = `1.00 - (yesBid + noBid)`
5. Refresh orders every 30s, rotate markets every 60s
6. Cancel stale orders when prices move >1¢

**Key constraint:** `yesBid + noBid < 1.00` always enforced — ensures positive EV on every round-trip.

**Usage:**

```bash
# Dry run (simulated fills, no real orders)
DRY_RUN=true bun run market-maker

# Live trading (requires VPN for geoblocked regions)
DRY_RUN=false bun run market-maker

# Custom parameters
MM_SIZE_USDC=100 MM_MAX_MARKETS=15 MM_SPREAD_CAPTURE=0.3 bun run market-maker
```

**Key env vars:**

```bash
MM_SIZE_USDC=50            # USDC per side per market
MM_MAX_MARKETS=10          # Max simultaneous markets
MM_MIN_SPREAD_PCT=2        # Min spread % to consider
MM_MAX_SPREAD_PCT=20       # Max spread % to consider
MM_MIN_VOLUME=200          # Min volume to consider
MM_SPREAD_CAPTURE=0.4      # Fraction of spread to capture (0.3-0.5)
MM_REFRESH_INTERVAL_MS=60000  # Market list refresh interval
MM_ORDER_REFRESH_MS=30000  # Order refresh interval
MM_MAX_INVENTORY=500       # Max USDC inventory per side before pausing
DRY_RUN=true               # Simulate without executing
```

**PnL estimates (from data analysis):**

- Conservative ($2K capital, 10 markets): $50-150/week
- Moderate ($6K capital, 15 markets): $200-600/week
- Key risk: inventory loss when one side fills and event resolves against you
- Best categories: Mentions (3-8% spread, decent volume), Tennis (3-10%), Culture (4-5%)
- Worst during Asian hours (wide spreads but low fill probability)
