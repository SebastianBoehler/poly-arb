/**
 * Dead-outcome probe strategy.
 *
 * Tracks when a single leg trades at dust prices (1-5c) and logs how often
 * it appears before expiry. Intended to evaluate the "stress tape" idea.
 *
 * Run: bun run src/strategies/dead-outcome.ts
 *
 * Env:
 *   SYMBOL=btc
 *   TIMEFRAME=15m           // 15m | 1h | 4h
 *   LOW_PRICE_THRESHOLDS=0.01,0.02,0.03,0.05
 *   REFRESH_MS=1500
 *   RECHECK_MS=10000
 */
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { fetchCrypto15mMarkets, fetchCrypto1hMarkets, fetchCrypto4hMarkets } from "../core/gamma";
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
const TIMEFRAME = (process.env.TIMEFRAME ?? "15m").toLowerCase();
const REFRESH_MS = Number(process.env.REFRESH_MS ?? "1500");
const RECHECK_MS = Number(process.env.RECHECK_MS ?? "10000");
const LOW_PRICE_THRESHOLDS = (process.env.LOW_PRICE_THRESHOLDS ?? "0.01,0.02,0.03,0.05")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b);

let activeMarket: MarketState | null = null;
let activeExpiryMs = 0;
let activeTokens: string[] = [];
let client: RealTimeDataClient | null = null;
let connected = false;
const latestBook = new Map<string, AggOrderBook>();
const lastThresholdIndex: Record<"yes" | "no", number> = { yes: -1, no: -1 };

function getBestAsk(levels?: { price: string; size: string }[]): { price: number; size: number } | null {
  if (!levels || levels.length === 0) return null;
  let bestPrice = Number.POSITIVE_INFINITY;
  let bestSize = 0;
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (price < bestPrice) {
      bestPrice = price;
      bestSize = size;
    } else if (price === bestPrice) {
      bestSize += size;
    }
  }
  if (!Number.isFinite(bestPrice)) return null;
  return { price: bestPrice, size: bestSize };
}

function pickSymbolMarket(markets: MarketState[], timeframe: string): MarketState | null {
  const now = Date.now();
  const filtered = markets.filter((m) => m.symbol.toLowerCase() === SYMBOL);
  const withExpiry = filtered
    .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug, timeframe) }))
    .filter((m) => m.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  return withExpiry.length ? withExpiry[0].market : null;
}

async function loadMarkets(): Promise<MarketState[]> {
  if (TIMEFRAME === "1h") return fetchCrypto1hMarkets();
  if (TIMEFRAME === "4h") return fetchCrypto4hMarkets();
  return fetchCrypto15mMarkets();
}

async function loadActiveMarket(): Promise<void> {
  const markets = await loadMarkets();
  const chosen = pickSymbolMarket(markets, TIMEFRAME);
  if (!chosen) {
    throw new Error(`No active ${SYMBOL.toUpperCase()} ${TIMEFRAME} market found`);
  }
  activeMarket = chosen;
  activeTokens = [chosen.tokenYes, chosen.tokenNo];
  activeExpiryMs = getMarketExpiry(chosen.slug, TIMEFRAME);
  console.log(`Tracking ${SYMBOL.toUpperCase()} market: ${chosen.slug}`);
  console.log(`  YES token: ${chosen.tokenYes}`);
  console.log(`  NO  token: ${chosen.tokenNo}`);
  console.log(`  Expires:   ${formatExpiry(activeExpiryMs)} UTC\n`);
  lastThresholdIndex.yes = -1;
  lastThresholdIndex.no = -1;
}

function findThresholdIndex(price: number): number {
  let idx = -1;
  for (let i = 0; i < LOW_PRICE_THRESHOLDS.length; i += 1) {
    if (price <= LOW_PRICE_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

function logThresholdCrossing(side: "yes" | "no", price: number, size: number): void {
  const idx = findThresholdIndex(price);
  if (idx === -1 || idx === lastThresholdIndex[side]) {
    lastThresholdIndex[side] = idx;
    return;
  }
  const threshold = LOW_PRICE_THRESHOLDS[idx];
  const multiple = price > 0 ? (1 / price).toFixed(1) : "∞";
  console.log(
    `[DUST ${side.toUpperCase()}] price=${price.toFixed(4)} size=${size.toFixed(2)} threshold<=${threshold.toFixed(
      2
    )}x payout=${multiple}x`
  );
  lastThresholdIndex[side] = idx;
}

function logSnapshot(): void {
  if (!activeMarket) return;
  const yes = latestBook.get(activeMarket.tokenYes);
  const no = latestBook.get(activeMarket.tokenNo);
  const bestAskYes = getBestAsk(yes?.asks);
  const bestAskNo = getBestAsk(no?.asks);

  if (bestAskYes && bestAskNo) {
    const combined = bestAskYes.price + bestAskNo.price;
    console.log(
      `[${activeMarket.slug}] YES ask=${bestAskYes.price.toFixed(4)} (${bestAskYes.size.toFixed(2)} sh) | NO ask=${bestAskNo.price.toFixed(
        4
      )} (${bestAskNo.size.toFixed(2)} sh) | combined=${combined.toFixed(4)}`
    );
    logThresholdCrossing("yes", bestAskYes.price, bestAskYes.size);
    logThresholdCrossing("no", bestAskNo.price, bestAskNo.size);
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
      console.log("WebSocket connected. Subscribing to current market...");
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

  console.log("\nMarket expired or missing. Fetching next market...");
  await loadActiveMarket();
  latestBook.clear();
  await restartClient();
}

async function main(): Promise<void> {
  console.log("=== DEAD-OUTCOME PROBE (orderbook only) ===");
  console.log(`Symbol: ${SYMBOL.toUpperCase()} | Timeframe: ${TIMEFRAME}`);
  console.log(`Low price thresholds: ${LOW_PRICE_THRESHOLDS.join(", ")}`);
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
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
