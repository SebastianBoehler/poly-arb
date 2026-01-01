# Polymarket real-time streaming guide

This guide summarizes how the repository wires up the `@polymarket/real-time-data-client` WebSocket
SDK to stream market data (order books and price changes). It is designed to be copied into other
projects as a quick reference for the available event types, payload shapes, and subscription
patterns.

## Core client setup

```ts
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";

const client = new RealTimeDataClient({
  autoReconnect: true,
  onMessage: (c, message) => {
    // message: { topic: string; type: string; payload: unknown }
  },
  onConnect: (c) => {
    // subscribe here
  },
  onStatusChange: (status) => {
    // status is ConnectionStatus.CONNECTING | CONNECTED | DISCONNECTED
  },
});

client.connect();
```

A subscription request has the shape:

```ts
client.subscribe({
  subscriptions: [
    {
      topic: "clob_market",         // stream namespace
      type: "price_change",         // see event types below
      filters: JSON.stringify([...]) // stringified array of token IDs
    },
  ],
});
```

Batch subscriptions (e.g., 30 token IDs at a time) help avoid request size errors when tracking many
markets at once.【F:src/index.ts†L340-L368】【F:src/stats/stats.ts†L136-L171】

## Event types and payloads

All messages share the envelope `{ topic, type, payload }`. The repository listens for two `clob_market`
message types:

### `price_change`

*Purpose*: Lightweight top-of-book updates for a list of token IDs.

*Subscription example*
```ts
client.subscribe({
  subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(tokenIds) }],
});
```

*Payload shape*
```ts
type PriceChangeMessage = {
  topic: "clob_market";
  type: "price_change";
  payload: {
    pc?: Array<{
      a: string;   // asset_id (token ID)
      ba?: string; // best ask as string
      bb?: string; // best bid as string (sometimes present)
    }>;
    price_changes?: Array<{ asset_id: string; best_ask?: string; best_bid?: string }>; // legacy alias
  };
};
```

Either `pc` or `price_changes` may be present. The best ask is the key field for arbitrage logic; the
client maps the asset ID back to a tracked market and updates `bestAskYes`/`bestAskNo` before
recomputing combined prices.【F:src/index.ts†L316-L351】【F:src/stats/stats.ts†L120-L152】

### `agg_orderbook`

*Purpose*: Full aggregated order book snapshots (bids + asks) for specific token IDs. Useful for
front-ends that want depth and not just top-of-book prices.

*Subscription example*
```ts
client.subscribe({
  subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(tokenIds) }],
});
```

*Payload shape*
```ts
type OrderBookLevel = { price: string; size: string };
type AggOrderBookMessage = {
  topic: "clob_market";
  type: "agg_orderbook";
  payload: {
    asset_id: string;          // token ID
    bids?: OrderBookLevel[];   // sorted descending by price
    asks?: OrderBookLevel[];   // sorted ascending by price
    tick_size?: string;        // quoted tick size
    neg_risk?: boolean;        // true for binary neg-risk markets
  };
};
```

The trading and order-smoke scripts keep the latest book per token in a `Map`, then compute best bid
/ ask and combined spread. This is a handy pattern for UI components that need a live view of the
current depth.【F:src/strategies/trading.ts†L16-L87】【F:src/scripts/order-smoke.ts†L15-L74】

## Minimal streaming examples

### Stream price changes for arbitrary tokens

```ts
const tokenIds = ["123", "456"]; // YES/NO token IDs
const latestAsks = new Map<string, number>();

const client = new RealTimeDataClient({
  autoReconnect: true,
  onMessage: (_c, message) => {
    const { topic, type, payload } = message as { topic: string; type: string; payload: any };
    if (topic !== "clob_market" || type !== "price_change") return;
    const priceChanges = (payload?.pc || payload?.price_changes) as { a: string; ba?: string }[] | undefined;
    priceChanges?.forEach((pc) => {
      const bestAsk = Number(pc.ba ?? (pc as any).best_ask);
      if (pc.a && Number.isFinite(bestAsk)) {
        latestAsks.set(pc.a, bestAsk);
      }
    });
  },
  onConnect: (c) => c.subscribe({ subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(tokenIds) }] }),
});

client.connect();
```

### Stream aggregated order books for a YES/NO pair

```ts
const [yesToken, noToken] = ["token_yes", "token_no"];
const latestBooks = new Map<string, { bids?: OrderBookLevel[]; asks?: OrderBookLevel[] }>();

const client = new RealTimeDataClient({
  autoReconnect: true,
  onMessage: (_c, message) => {
    const { topic, type, payload } = message as { topic: string; type: string; payload: any };
    if (topic !== "clob_market" || type !== "agg_orderbook") return;
    latestBooks.set(payload.asset_id, payload);
    // compute best bid/ask for UI
  },
  onConnect: (c) => c.subscribe({
    subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify([yesToken, noToken]) }],
  }),
});

client.connect();
```

## Tips for front-end consumers

- **Throttle UI updates**: Order book snapshots can be noisy. The repository logs snapshots every
  `REFRESH_MS` to avoid spamming the console; apply the same idea to React state updates.
- **Handle reconnects**: `autoReconnect: true` simplifies reconnection, but you should re-send
  subscriptions in `onConnect` because a new socket means a fresh session.
- **Batch filters**: If you watch dozens of markets, subscribe in batches of ~30 token IDs per call
  to stay under request body limits used by the WebSocket gateway.【F:src/stats/stats.ts†L144-L171】
- **Map token → market**: Keep a lookup from token ID to market metadata so incoming events can be
  merged into the correct UI model (as seen in the ladder strategy and stats collector).

With these patterns and type aliases, you can drop the snippets into another project and quickly
stand up live order book or price-change visualizations backed by Polymarket's real-time feed.
