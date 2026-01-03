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
  funderAddress // Safe wallet address holding funds
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
python scripts/analyze_stats.py --csv stats-summary.csv --out-dir plots
```
