/**
 * Minimal BTC-only streaming strategy.
 *
 * - Chooses the nearest active BTC 15m market.
 * - Subscribes to its YES/NO tokens via the Polymarket RealTimeDataClient.
 * - Streams aggregated orderbooks and logs best bid/ask + combined.
 * - When the market expires, it auto-rotates to the next available BTC market.
 *
 * Run: bun run src/strategies/trading.ts
 *
 * Env:
 *   SYMBOL=btc             // optional, default btc
 *   REFRESH_MS=1000        // how often to log latest book snapshot
 *   RECHECK_MS=10000       // how often to check for a new market/expiry
 */
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { fetchCrypto15mMarkets } from "../core/gamma";
import { formatExpiry, getMarketExpiry } from "../core/utils";
import type { MarketState } from "../core/types";

type AggOrderBook = {
  asset_id: string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  tick_size?: string;
  neg_risk?: boolean;
};

const SYMBOL = (process.env.SYMBOL ?? "btc").toLowerCase();
const REFRESH_MS = Number(process.env.REFRESH_MS ?? "1000");
const RECHECK_MS = Number(process.env.RECHECK_MS ?? "10000");

let activeMarket: MarketState | null = null;
let activeExpiryMs = 0;
let activeTokens: string[] = [];
let client: RealTimeDataClient | null = null;
let connected = false;
const latestBook = new Map<string, AggOrderBook>();

function getBest(levels: { price: string }[] | undefined, isBid: boolean): number | null {
  if (!levels || levels.length === 0) return null;
  const prices = levels.map((l) => Number(l.price)).filter((p) => !Number.isNaN(p));
  if (prices.length === 0) return null;
  return isBid ? Math.max(...prices) : Math.min(...prices);
}

function pickBtcMarket(markets: MarketState[]): MarketState | null {
  const now = Date.now();
  const btcMarkets = markets.filter((m) => m.slug.startsWith("btc-"));
  const withExpiry = btcMarkets
    .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug, "15m") }))
    .filter((m) => m.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  return withExpiry.length ? withExpiry[0].market : null;
}

async function loadActiveMarket(): Promise<void> {
  const markets = await fetchCrypto15mMarkets();
  const chosen = pickBtcMarket(markets);
  if (!chosen) {
    throw new Error("No active BTC 15m market found");
  }
  activeMarket = chosen;
  activeTokens = [chosen.tokenYes, chosen.tokenNo];
  activeExpiryMs = getMarketExpiry(chosen.slug, "15m");
  console.log(`Tracking BTC market: ${chosen.slug}`);
  console.log(`  YES token: ${chosen.tokenYes}`);
  console.log(`  NO  token: ${chosen.tokenNo}`);
  console.log(`  Expires:   ${formatExpiry(activeExpiryMs)} UTC\n`);
}

function logSnapshot(): void {
  if (!activeMarket) return;
  const yes = latestBook.get(activeMarket.tokenYes);
  const no = latestBook.get(activeMarket.tokenNo);
  const bestBidYes = getBest(yes?.bids, true);
  const bestAskYes = getBest(yes?.asks, false);
  const bestBidNo = getBest(no?.bids, true);
  const bestAskNo = getBest(no?.asks, false);

  if (bestAskYes && bestAskNo) {
    const combined = bestAskYes + bestAskNo;
    console.log(
      `[${activeMarket.slug}] YES bid/ask: ${bestBidYes ?? "-"} / ${bestAskYes} | NO bid/ask: ${
        bestBidNo ?? "-"
      } / ${bestAskNo} | combined ask: ${combined.toFixed(4)}`
    );
  } else {
    console.log(`[${activeMarket.slug}] waiting for both orderbooks...`);
  }
}

function subscribeToTokens(tokenIds: string[]): void {
  if (!client) return;
  client.subscribe({
    subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(tokenIds) }],
  });
}

async function restartClient(): Promise<void> {
  if (client) {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    client = null;
  }

  client = new RealTimeDataClient({
    autoReconnect: true,
    onMessage: (_client, message) => {
      if (!connected) return;
      const { topic, type, payload } = message as { topic: string; type: string; payload: AggOrderBook };
      if (topic === "clob_market" && type === "agg_orderbook") {
        latestBook.set(payload.asset_id, payload);
      }
    },
    onConnect: (connectedClient) => {
      connected = true;
      console.log("WebSocket connected. Subscribing to current BTC market...");
      subscribeToTokens(activeTokens);
    },
    onStatusChange: (status) => {
      if (status === ConnectionStatus.DISCONNECTED) connected = false;
      if (status === ConnectionStatus.CONNECTING) connected = false;
    },
  });
}

async function ensureActiveMarket(): Promise<void> {
  const now = Date.now();
  const needsRefresh = !activeMarket || now >= activeExpiryMs;
  if (!needsRefresh) return;

  console.log("\nMarket expired or missing. Fetching next BTC market...");
  await loadActiveMarket();
  latestBook.clear();
  await restartClient();
}

async function main(): Promise<void> {
  console.log("=== BTC STREAMING STRATEGY (orderbook only) ===");
  console.log(`Symbol: ${SYMBOL}`);
  console.log("");

  await loadActiveMarket();
  await restartClient();

  const recheck = setInterval(ensureActiveMarket, RECHECK_MS);
  const refresh = setInterval(logSnapshot, REFRESH_MS);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    clearInterval(recheck);
    clearInterval(refresh);
    if (client) client.disconnect();
    process.exit(0);
  });

  console.log("Streaming orderbooks... Press Ctrl+C to stop.\n");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
