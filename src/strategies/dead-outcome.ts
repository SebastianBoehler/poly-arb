/**
 * Dead-outcome probe strategy.
 *
 * Tracks when a single leg trades at dust prices (1-5c), logs threshold
 * crossings, and records the eventual outcome to estimate win rates.
 * Intended to evaluate the "stress tape" idea.
 *
 * Run: bun run src/strategies/dead-outcome.ts
 *
 * Env:
 *   SYMBOL=btc
 *   TIMEFRAME=15m           // 15m | 1h | 4h (crypto mode only)
 *   MARKET_SOURCE=crypto    // crypto | neg_risk
 *   MARKET_QUERY=           // substring to filter slug/title (neg_risk only)
 *   MAX_MARKETS=100         // neg_risk only
 *   LOW_PRICE_THRESHOLDS=0.01,0.02,0.03,0.05
 *   REFRESH_MS=1500
 *   RECHECK_MS=10000
 */
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { fetchCrypto15mMarkets, fetchCrypto1hMarkets, fetchCrypto4hMarkets, fetchNegRiskMarkets } from "../core/gamma";
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
const MARKET_SOURCE = (process.env.MARKET_SOURCE ?? "crypto").toLowerCase();
const MARKET_QUERY = (process.env.MARKET_QUERY ?? "").toLowerCase();
const MAX_MARKETS = Number(process.env.MAX_MARKETS ?? "100");
const REFRESH_MS = Number(process.env.REFRESH_MS ?? "1500");
const RECHECK_MS = Number(process.env.RECHECK_MS ?? "10000");
const LOW_PRICE_THRESHOLDS = (process.env.LOW_PRICE_THRESHOLDS ?? "0.01,0.02,0.03,0.05")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b);
const DATA_API = "https://data-api.polymarket.com";

let activeMarket: MarketState | null = null;
let activeExpiryMs = 0;
let activeTokens: string[] = [];
let client: RealTimeDataClient | null = null;
let connected = false;
const latestBook = new Map<string, AggOrderBook>();
const lastThresholdIndex: Record<"yes" | "no", number> = { yes: -1, no: -1 };

type DustEvent = {
  side: "yes" | "no";
  threshold: number;
  price: number;
  size: number;
  ts: number;
};

const dustEventsByMarket = new Map<string, DustEvent[]>();
let dustEventCount = 0;
let dustWinCount = 0;
const dustWinByThreshold = new Map<number, { wins: number; total: number }>();
const pendingOutcomeMarkets = new Map<string, MarketState>();

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

function pickNegRiskMarket(markets: MarketState[]): MarketState | null {
  const filtered = MARKET_QUERY
    ? markets.filter((m) => m.slug.toLowerCase().includes(MARKET_QUERY) || m.title.toLowerCase().includes(MARKET_QUERY))
    : markets;
  return filtered.length ? filtered[0] : null;
}

async function loadMarkets(): Promise<MarketState[]> {
  if (MARKET_SOURCE === "neg_risk") {
    return fetchNegRiskMarkets(MAX_MARKETS);
  }
  if (TIMEFRAME === "1h") return fetchCrypto1hMarkets();
  if (TIMEFRAME === "4h") return fetchCrypto4hMarkets();
  return fetchCrypto15mMarkets();
}

async function loadActiveMarket(): Promise<void> {
  const markets = await loadMarkets();
  const chosen = MARKET_SOURCE === "neg_risk" ? pickNegRiskMarket(markets) : pickSymbolMarket(markets, TIMEFRAME);
  if (!chosen) {
    if (MARKET_SOURCE === "neg_risk") {
      throw new Error("No active neg_risk market found for query");
    }
    throw new Error(`No active ${SYMBOL.toUpperCase()} ${TIMEFRAME} market found`);
  }
  activeMarket = chosen;
  activeTokens = [chosen.tokenYes, chosen.tokenNo];
  activeExpiryMs = MARKET_SOURCE === "neg_risk" ? Number.POSITIVE_INFINITY : getMarketExpiry(chosen.slug, TIMEFRAME);
  console.log(
    MARKET_SOURCE === "neg_risk"
      ? `Tracking market: ${chosen.slug}`
      : `Tracking ${SYMBOL.toUpperCase()} market: ${chosen.slug}`
  );
  console.log(`  YES token: ${chosen.tokenYes}`);
  console.log(`  NO  token: ${chosen.tokenNo}`);
  if (MARKET_SOURCE !== "neg_risk") {
    console.log(`  Expires:   ${formatExpiry(activeExpiryMs)} UTC\n`);
  } else {
    console.log("");
  }
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
  if (activeMarket) {
    const key = activeMarket.conditionId;
    const events = dustEventsByMarket.get(key) ?? [];
    events.push({ side, threshold, price, size, ts: Date.now() });
    dustEventsByMarket.set(key, events);
    dustEventCount += 1;
    const bucket = dustWinByThreshold.get(threshold) ?? { wins: 0, total: 0 };
    bucket.total += 1;
    dustWinByThreshold.set(threshold, bucket);
  }
  console.log(
    `[DUST ${side.toUpperCase()}] price=${price.toFixed(4)} size=${size.toFixed(2)} threshold<=${threshold.toFixed(
      2
    )}x payout=${multiple}x`
  );
  lastThresholdIndex[side] = idx;
}

function normalizeOutcome(raw: string | null): "yes" | "no" | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "yes" || value === "up") return "yes";
  if (value === "no" || value === "down") return "no";
  return null;
}

async function fetchMarketOutcome(conditionId: string): Promise<"yes" | "no" | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = `${DATA_API}/markets?condition_id=${conditionId}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      console.warn(`[Outcome] Failed to fetch market outcome (${response.status})`);
      return null;
    }
    const data = (await response.json()) as Array<Record<string, any>>;
    const market = data?.[0];
    if (!market) return null;
    const resolved = market.resolved ?? market.closed ?? market.isResolved ?? false;
    const outcome = normalizeOutcome(market.outcome || market.result || market.resolution || market.resolved_outcome);
    if (!resolved && !outcome) return null;
    return outcome;
  } catch (error: any) {
    if (error.name !== "AbortError") {
      console.warn("[Outcome] Error fetching outcome:", error?.message || error);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function finalizeMarket(market: MarketState): Promise<void> {
  const events = dustEventsByMarket.get(market.conditionId);
  if (!events || events.length === 0) return;
  const outcome = await fetchMarketOutcome(market.conditionId);
  if (!outcome) {
    console.log(`[Outcome] Market ${market.slug} not resolved yet. Will retry later.`);
    pendingOutcomeMarkets.set(market.conditionId, market);
    return;
  }
  let wins = 0;
  for (const event of events) {
    if (event.side === outcome) {
      wins += 1;
      dustWinCount += 1;
      const bucket = dustWinByThreshold.get(event.threshold) ?? { wins: 0, total: 0 };
      bucket.wins += 1;
      dustWinByThreshold.set(event.threshold, bucket);
    }
  }
  const winRate = events.length > 0 ? (wins / events.length) * 100 : 0;
  const overallRate = dustEventCount > 0 ? (dustWinCount / dustEventCount) * 100 : 0;
  console.log(
    `[Outcome] ${market.slug} resolved=${outcome.toUpperCase()} | dust wins ${wins}/${events.length} (${winRate.toFixed(
      1
    )}%) | overall ${dustWinCount}/${dustEventCount} (${overallRate.toFixed(1)}%)`
  );
  dustEventsByMarket.delete(market.conditionId);
  pendingOutcomeMarkets.delete(market.conditionId);
}

async function retryPendingOutcomes(): Promise<void> {
  if (pendingOutcomeMarkets.size === 0) return;
  const pending = Array.from(pendingOutcomeMarkets.values());
  for (const market of pending) {
    await finalizeMarket(market);
  }
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
  if (MARKET_SOURCE === "neg_risk") {
    await retryPendingOutcomes();
    const markets = await loadMarkets();
    const stillActive = activeMarket && markets.some((m) => m.conditionId === activeMarket.conditionId);
    if (activeMarket && !stillActive) {
      console.log("\nMarket closed or missing. Resolving outcome and rotating...");
      await finalizeMarket(activeMarket);
      activeMarket = null;
    }
    if (!activeMarket) {
      await loadActiveMarket();
      latestBook.clear();
      await restartClient();
    }
    return;
  }

  const needsRefresh = !activeMarket || now >= activeExpiryMs;
  if (!needsRefresh) return;

  if (activeMarket) {
    console.log("\nMarket expired. Resolving outcome...");
    await finalizeMarket(activeMarket);
  }

  console.log("Fetching next market...");
  await retryPendingOutcomes();
  await loadActiveMarket();
  latestBook.clear();
  await restartClient();
}

async function main(): Promise<void> {
  console.log("=== DEAD-OUTCOME PROBE (orderbook only) ===");
  console.log(
    MARKET_SOURCE === "neg_risk"
      ? `Market source: neg_risk | Query: ${MARKET_QUERY || "none"}`
      : `Symbol: ${SYMBOL.toUpperCase()} | Timeframe: ${TIMEFRAME}`
  );
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
