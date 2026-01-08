/**
 * Stats script: subscribes to all crypto 15m and 4h markets and tracks how often
 * the combined best-ask (yes+no) falls under configured thresholds.
 *
 * Run: bun run stats.ts
 *
 * Env:
 *  - STATS_THRESHOLDS: comma-separated list (default: "1,0.995,0.99,0.985,0.98,0.95,0.9")
 *  - STATS_LOG_SECONDS: summary interval (seconds, default 60)
 *  - STATS_REFRESH_MINUTES: refresh markets periodically (minutes, default 10; 0 = off)
 *  - STATS_OUT_CSV: path to append summary CSV (default: stats-summary.csv)
 *  - STATS_TIMEFRAMES: comma-separated timeframes to track (default: "15m,1h,4h")
 *  - STATS_LOW_PRICE_THRESHOLDS: comma-separated low-price thresholds for dust (default: "0.01,0.02,0.03,0.05")
 *  - STATS_HIGH_PRICE_THRESHOLDS: comma-separated high-price thresholds (default: "0.95,0.97,0.99")
 */
import { RealTimeDataClient, ConnectionStatus } from "@polymarket/real-time-data-client";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fetchCrypto15mMarkets, fetchCrypto1hMarkets, fetchCrypto4hMarkets } from "../core/gamma";
import { BybitSpotClient, type SpotMomentumEvent, type SpotPriceUpdate } from "../services/bybit-ws";
import type {
  MarketState,
  StatsMarketTracker,
  ThresholdHits,
  ThresholdPriceSums,
  TimeToExpiryHits,
  ThresholdLiquidity,
  ThresholdDuration,
  OrderbookLevel,
  HighPriceExpiryHits,
  LowPriceExpiryHits,
} from "../core/types";
import {
  bumpThresholdHits,
  bumpThresholdPriceSums,
  getExpiryBucket,
  getFineExpiryBucket,
  bumpTimeToExpiryHits,
  bumpHighPriceExpiryHits,
  bumpLowPriceExpiryHits,
  FINE_EXPIRY_BUCKETS,
} from "./utils";
import { getMarketExpiry, formatExpiry, extractSymbol } from "../core/utils";

const durationSampleCap = 1000; // keep last N durations per threshold for rolling stats
const durationHardCapMs = 20000; // cap single duration to avoid WS-stall inflation
const reconnectGapMs = 5000; // treat longer gaps as reconnect and reset active windows

let lastPrintSamples = 0;
let lastPrintAt = Date.now();
let lastPrintMessages = 0;

let totalMessages = 0;
let totalBookEvents = 0;
let totalCombinedSamples = 0;
let overallHits: ThresholdHits = {};
let overallPriceSums: ThresholdPriceSums = {};
let overallExpiryHits: TimeToExpiryHits = {};
let overallLiquidity: ThresholdLiquidity = {};
let overallDuration: ThresholdDuration = {};
let highPriceExpiryYes: HighPriceExpiryHits = {};
let highPriceExpiryNo: HighPriceExpiryHits = {};
let lowPriceExpiryYes: LowPriceExpiryHits = {};
let lowPriceExpiryNo: LowPriceExpiryHits = {};

// Duration by time-to-expiry: tracks how opportunity duration varies with market age
// Key: threshold -> expiryBucket -> { sumMs, count, maxMs, minMs }
type DurationByExpiry = Record<number, Record<string, { sumMs: number; count: number; maxMs: number; minMs: number }>>;
let durationByExpiry: DurationByExpiry = {};

function recordDurationByExpiry(th: number, expiresAt: number, durationMs: number) {
  const bucket = getFineExpiryBucket(expiresAt);
  if (!durationByExpiry[th]) durationByExpiry[th] = {};
  if (!durationByExpiry[th][bucket]) {
    durationByExpiry[th][bucket] = { sumMs: 0, count: 0, maxMs: 0, minMs: Number.POSITIVE_INFINITY };
  }
  const b = durationByExpiry[th][bucket];
  b.sumMs += durationMs;
  b.count += 1;
  b.maxMs = Math.max(b.maxMs, durationMs);
  b.minMs = Math.min(b.minMs, durationMs);
}
// Per-market duration stats
function ensureOverallDuration(th: number): Required<ThresholdDuration>[number] {
  if (!overallDuration[th]) {
    overallDuration[th] = { sumMs: 0, count: 0, maxMs: 0, minMs: Number.POSITIVE_INFINITY, samples: [] };
  }
  return overallDuration[th] as Required<ThresholdDuration>[number];
}
function ensureMarketDuration(tracker: StatsMarketTracker, th: number): Required<ThresholdDuration>[number] {
  if (!tracker.durations[th]) {
    tracker.durations[th] = { sumMs: 0, count: 0, maxMs: 0, minMs: Number.POSITIVE_INFINITY, samples: [] };
  }
  return tracker.durations[th] as Required<ThresholdDuration>[number];
}

// Momentum tracking: detect rapid price moves (spot-lag exploitation)
const momentumWindowMs = 90_000; // 90s window to detect momentum
const momentumPriceHistoryCap = 100; // keep last N price points per leg
const momentumStartThreshold = 0.5; // price must start below this
const momentumEndThresholds = [0.8, 0.9, 0.95]; // target thresholds to track
interface MomentumMove {
  side: "yes" | "no";
  startPrice: number;
  endPrice: number;
  durationMs: number;
  secondsToExpiry: number;
  targetThreshold: number;
}
let momentumMoves: MomentumMove[] = [];

// Spot-lag tracking: correlate Bybit spot moves with Polymarket adjustments
interface SpotLagEvent {
  symbol: string;
  spotDirection: "up" | "down";
  spotPctChange: number;
  spotMoveTs: number;
  polyAdjustTs: number;
  lagMs: number;
  polyStartPrice: number;
  polyEndPrice: number;
  polyPriceChange: number;
  profitable: boolean;
}
let spotLagEvents: SpotLagEvent[] = [];

// Track pending spot momentum events waiting for Polymarket to catch up
interface PendingSpotMove {
  symbol: string;
  direction: "up" | "down";
  spotPctChange: number;
  spotMoveTs: number;
  polyPriceAtSpotMove: number; // Polymarket YES price when spot moved
  expiresAt: number; // stop tracking after this time
}
let pendingSpotMoves: PendingSpotMove[] = [];
const spotLagWindowMs = 120_000; // track for up to 2 minutes after spot move
const spotLagMinPctChange = 0.3; // minimum spot move % to track

// Latest Polymarket prices per symbol for correlation
const latestPolyPrices: Map<string, { yes: number; no: number; ts: number }> = new Map();

// Counter for Bybit events received
let bybitMomentumEventsReceived = 0;

// Handle spot momentum event from Bybit - record pending move to track lag
function handleSpotMomentum(event: SpotMomentumEvent) {
  bybitMomentumEventsReceived++;
  // Extract symbol (BTCUSDT -> BTC, ETHUSDT -> ETH)
  const symbol = event.symbol.replace("USDT", "");
  const now = Date.now();

  console.log(
    `[SpotLag] Bybit momentum #${bybitMomentumEventsReceived}: ${symbol} ${event.direction} ${event.pctChange.toFixed(3)}% in ${(event.durationMs / 1000).toFixed(1)}s`
  );

  // Only track significant moves (filter already done in bybit-ws, but double-check)
  if (Math.abs(event.pctChange) < spotLagMinPctChange) return;

  // Get current Polymarket price for this symbol
  const polyPrice = latestPolyPrices.get(symbol);
  if (!polyPrice) return;

  // Add to pending moves
  pendingSpotMoves.push({
    symbol,
    direction: event.direction,
    spotPctChange: event.pctChange,
    spotMoveTs: event.timestamp,
    polyPriceAtSpotMove: polyPrice.yes,
    expiresAt: now + spotLagWindowMs,
  });

  // Cap pending moves
  if (pendingSpotMoves.length > 100) {
    pendingSpotMoves.shift();
  }

  console.log(
    `[SpotLag] ${symbol} spot ${event.direction} ${event.pctChange.toFixed(2)}% - tracking for Polymarket adjustment (current YES: ${polyPrice.yes.toFixed(3)})`
  );
}

// Check if Polymarket has caught up to a pending spot move
function checkSpotLagCorrelation(symbol: string, newYesPrice: number, now: number) {
  // Find pending moves for this symbol
  const pendingIdx = pendingSpotMoves.findIndex((p) => p.symbol === symbol && p.expiresAt > now);
  if (pendingIdx === -1) return;

  const pending = pendingSpotMoves[pendingIdx];
  const priceChange = newYesPrice - pending.polyPriceAtSpotMove;
  const priceChangePct = (priceChange / pending.polyPriceAtSpotMove) * 100;

  // Check if Polymarket moved in the expected direction
  const expectedDirection = pending.direction === "up" ? 1 : -1;
  const actualDirection = priceChange > 0 ? 1 : -1;
  const movedEnough = Math.abs(priceChangePct) >= 5; // 5% odds change threshold

  if (movedEnough) {
    const lagMs = now - pending.spotMoveTs;
    const profitable = expectedDirection === actualDirection;

    const event: SpotLagEvent = {
      symbol,
      spotDirection: pending.direction,
      spotPctChange: pending.spotPctChange,
      spotMoveTs: pending.spotMoveTs,
      polyAdjustTs: now,
      lagMs,
      polyStartPrice: pending.polyPriceAtSpotMove,
      polyEndPrice: newYesPrice,
      polyPriceChange: priceChangePct,
      profitable,
    };

    spotLagEvents.push(event);
    if (spotLagEvents.length > 500) {
      spotLagEvents.shift();
    }

    console.log(
      `[SpotLag] ${symbol} Polymarket caught up! Lag: ${(lagMs / 1000).toFixed(1)}s, ` +
        `Poly: ${pending.polyPriceAtSpotMove.toFixed(3)} → ${newYesPrice.toFixed(3)} (${priceChangePct > 0 ? "+" : ""}${priceChangePct.toFixed(1)}%), ` +
        `Profitable: ${profitable ? "YES" : "NO"}`
    );

    // Remove this pending move
    pendingSpotMoves.splice(pendingIdx, 1);
  }
}

// Clean up expired pending moves
function cleanupExpiredPendingMoves(now: number) {
  pendingSpotMoves = pendingSpotMoves.filter((p) => p.expiresAt > now);
}

// Track momentum: detect when price moves from <startThreshold to >endThreshold within window
function trackMomentum(entry: { market: StatsMarketTracker; side: "yes" | "no" }, bestAsk: number, now: number) {
  const history = entry.side === "yes" ? entry.market.priceHistoryYes : entry.market.priceHistoryNo;

  // Add current price to history
  history.push({ price: bestAsk, ts: now });

  // Trim old entries outside window
  while (history.length > 0 && now - history[0].ts > momentumWindowMs) {
    history.shift();
  }

  // Cap history size
  while (history.length > momentumPriceHistoryCap) {
    history.shift();
  }

  if (history.length < 2) return;

  // Look for momentum: find earliest point where price was <0.5, check if current >target
  const earliestLow = history.find((h) => h.price < momentumStartThreshold);
  if (!earliestLow) return;

  // Check each target threshold
  for (const target of momentumEndThresholds) {
    if (bestAsk >= target && earliestLow.price < momentumStartThreshold) {
      const durationMs = now - earliestLow.ts;
      const secondsToExpiry = Math.max(0, (entry.market.expiresAt - now) / 1000);

      // Only record if this is a new crossing (avoid duplicates)
      // Check if we already recorded a similar move recently
      const recentSimilar = momentumMoves.find(
        (m) =>
          m.side === entry.side &&
          m.targetThreshold === target &&
          Math.abs(m.durationMs - durationMs) < 5000 &&
          Math.abs(m.secondsToExpiry - secondsToExpiry) < 60
      );

      if (!recentSimilar) {
        momentumMoves.push({
          side: entry.side,
          startPrice: earliestLow.price,
          endPrice: bestAsk,
          durationMs,
          secondsToExpiry,
          targetThreshold: target,
        });

        // Cap total moves stored
        if (momentumMoves.length > 1000) {
          momentumMoves.shift();
        }
      }
    }
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(0.9 * (sorted.length - 1));
  return sorted[idx];
}

// Preserve historical per-symbol stats when markets expire
const historicalSymbolStats = new Map<string, { samples: number; hits: ThresholdHits; priceSums: ThresholdPriceSums }>();

const thresholds = (process.env.STATS_THRESHOLDS || "0.995,0.99,0.985,0.98,0.95,0.9")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b); // ascending so lower thresholds appear last in logs

const defaultLogSeconds = 60;
const logSecondsRaw = process.env.STATS_LOG_SECONDS;
const logSeconds = Number.isFinite(Number(logSecondsRaw)) && Number(logSecondsRaw) > 0 ? Number(logSecondsRaw) : defaultLogSeconds;
const refreshMinutesRaw = process.env.STATS_REFRESH_MINUTES;
const refreshMinutes = Number.isFinite(Number(refreshMinutesRaw)) && Number(refreshMinutesRaw) > 0 ? Number(refreshMinutesRaw) : 5;
const outCsvPath = process.env.STATS_OUT_CSV || "stats-summary.csv";
const timeframes = (process.env.STATS_TIMEFRAMES || "15m").split(",").map((t) => t.trim());
const highPriceThresholds = (process.env.STATS_HIGH_PRICE_THRESHOLDS || "0.95,0.97,0.99")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b);
const lowPriceThresholds = (process.env.STATS_LOW_PRICE_THRESHOLDS || "0.01,0.02,0.03,0.05")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b);

async function main() {
  // Fetch markets based on configured timeframes
  const marketsWithTf: { market: MarketState; timeframe: string }[] = [];
  if (timeframes.includes("15m")) {
    const m15 = await fetchCrypto15mMarkets();
    for (const m of m15) marketsWithTf.push({ market: m, timeframe: "15m" });
  }
  if (timeframes.includes("1h")) {
    const m1h = await fetchCrypto1hMarkets();
    for (const m of m1h) marketsWithTf.push({ market: m, timeframe: "1h" });
  }
  if (timeframes.includes("4h")) {
    const m4h = await fetchCrypto4hMarkets();
    for (const m of m4h) marketsWithTf.push({ market: m, timeframe: "4h" });
  }

  if (marketsWithTf.length === 0) {
    console.log("No crypto markets found. Exiting.");
    return;
  }

  const tokenToMarket = new Map<string, { market: StatsMarketTracker; side: "yes" | "no" }>();
  const allTokenIds = new Set<string>();
  const marketTrackers = new Map<string, StatsMarketTracker>();

  for (const { market: m, timeframe } of marketsWithTf) {
    const expiresAt = getMarketExpiry(m.slug, timeframe);
    const tracker: StatsMarketTracker = {
      market: { ...m },
      timeframe,
      expiresAt,
      updates: 0,
      hits: {},
      priceSums: {},
      lastCombined: Number.POSITIVE_INFINITY,
      asksYes: [],
      asksNo: [],
      activeOpportunities: new Map(),
      momentumYes: null,
      momentumNo: null,
      priceHistoryYes: [],
      priceHistoryNo: [],
      durations: {},
    };
    tokenToMarket.set(m.tokenYes, { market: tracker, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: tracker, side: "no" });
    allTokenIds.add(m.tokenYes);
    allTokenIds.add(m.tokenNo);
    marketTrackers.set(m.slug, tracker);
  }

  // Find earliest expiry for smart refresh
  let earliestExpiry = Math.min(...Array.from(marketTrackers.values()).map((t) => t.expiresAt));

  console.log(`=== STATS: Crypto ${timeframes.join("/")} markets ===`);
  console.log(`Markets: ${marketTrackers.size}, Token IDs: ${allTokenIds.size}`);
  console.log(`Earliest market expires at: ${formatExpiry(earliestExpiry)} UTC`);
  console.log(`Thresholds: ${thresholds.join(", ")}`);
  console.log(`Summary interval: ${logSeconds}s\n`);

  // Initialize Bybit WebSocket for spot price monitoring
  const bybitSymbols = ["BTCUSDT", "ETHUSDT"];
  const bybitClient = new BybitSpotClient(bybitSymbols);

  bybitClient.setOnMomentum((event) => {
    handleSpotMomentum(event);
  });

  bybitClient.setOnConnect(() => {
    console.log(`[Bybit] Connected and monitoring: ${bybitSymbols.join(", ")}`);
  });

  bybitClient.setOnDisconnect(() => {
    console.log(`[Bybit] Disconnected`);
  });

  console.log("Connecting to Bybit WebSocket for spot prices...");
  bybitClient.connect();

  console.log("Connecting to Polymarket WebSocket...\n");

  ensureCsvHeader(outCsvPath, thresholds);

  let connected = false;
  let activeClient: RealTimeDataClient | null = null;

  let lastConnectTime = Date.now();
  let disconnectCount = 0;

  const client = new RealTimeDataClient({
    autoReconnect: true,
    pingInterval: 3000, // More aggressive ping to keep connection alive
    onMessage: (_client, message) => {
      totalMessages += 1;
      if (!connected) return;
      const { topic, type, payload } = message as { topic: string; type: string; payload: any };

      // Only use agg_orderbook - it provides full depth and best prices
      if (topic === "clob_market" && type === "agg_orderbook") {
        totalBookEvents += 1;
        const assetId = (payload as any)?.asset_id as string;
        const asks = (payload as any)?.asks as { price: string; size: string }[] | undefined;
        if (!assetId || !asks || asks.length === 0) return;

        const entry = tokenToMarket.get(assetId);
        if (!entry) return;

        // Parse and store full orderbook
        const parsedAsks: OrderbookLevel[] = asks
          .map((a) => ({
            price: Number(a.price),
            size: Number(a.size),
          }))
          .filter((a) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.price > 0);

        if (entry.side === "yes") {
          entry.market.asksYes = parsedAsks;
        } else {
          entry.market.asksNo = parsedAsks;
        }

        const bestAsk = Math.min(...parsedAsks.map((a) => a.price));
        if (!Number.isFinite(bestAsk) || bestAsk <= 0) return;

        // Update latest Polymarket prices for spot-lag correlation
        const symbol = extractSymbol(entry.market.market.slug);
        const now = Date.now();
        const existing = latestPolyPrices.get(symbol) || { yes: 0, no: 0, ts: 0 };
        if (entry.side === "yes") {
          existing.yes = bestAsk;
        } else {
          existing.no = bestAsk;
        }
        existing.ts = now;
        latestPolyPrices.set(symbol, existing);

        // Check for spot-lag correlation (did Polymarket catch up to a pending spot move?)
        if (entry.side === "yes") {
          checkSpotLagCorrelation(symbol, bestAsk, now);
        }

        // Clean up expired pending moves periodically
        if (totalBookEvents % 100 === 0) {
          cleanupExpiredPendingMoves(now);
        }

        applyBestAskWithLiquidity(entry, bestAsk);
      }
    },
    onConnect: (connectedClient: RealTimeDataClient) => {
      const now = Date.now();
      const uptime = lastConnectTime ? ((now - lastConnectTime) / 1000).toFixed(1) : "N/A";
      lastConnectTime = now;
      connected = true;
      activeClient = connectedClient;
      console.log(`[${new Date().toISOString()}] WebSocket connected (previous session: ${uptime}s, disconnects: ${disconnectCount})`);
      console.log("Subscribing to clob_market agg_orderbook...\n");

      // Subscribe in batches to avoid "Invalid request body" error
      // Only use agg_orderbook - provides full depth for size calculation
      const tokenArray = Array.from(allTokenIds);
      const batchSize = 30;
      for (let i = 0; i < tokenArray.length; i += batchSize) {
        const batch = tokenArray.slice(i, i + batchSize);
        connectedClient.subscribe({
          subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(batch) }],
        });
        console.log(`  Subscribed batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tokens (agg_orderbook)`);
      }
      console.log(`\nSubscribed to ${allTokenIds.size} token IDs total\n`);
    },
    onStatusChange: (status: ConnectionStatus) => {
      const ts = new Date().toISOString();
      if (status === ConnectionStatus.DISCONNECTED) {
        disconnectCount += 1;
        const sessionDuration = ((Date.now() - lastConnectTime) / 1000).toFixed(1);
        connected = false;
        activeClient = null;
        console.log(`[${ts}] WebSocket DISCONNECTED after ${sessionDuration}s (total disconnects: ${disconnectCount})`);
      }
      if (status === ConnectionStatus.CONNECTING) {
        connected = false;
        console.log(`[${ts}] WebSocket CONNECTING...`);
      }
    },
  });

  client.connect();

  const logInterval = setInterval(() => {
    // Check for expired markets
    const now = Date.now();
    const expiredCount = Array.from(marketTrackers.values()).filter((t) => t.expiresAt < now).length;
    const activeCount = marketTrackers.size - expiredCount;
    console.log(`Active markets: ${activeCount}/${marketTrackers.size} (${expiredCount} expired, next expiry: ${formatExpiry(earliestExpiry)} UTC)`);
    printSummary(tokenToMarket, overallHits, totalCombinedSamples, false, outCsvPath);
  }, logSeconds * 1000);

  // Smart refresh: check every 30s if earliest market expired
  const refreshInterval = setInterval(
    async () => {
      const now = Date.now();
      // Only refresh if earliest market has expired (with 10s buffer)
      if (earliestExpiry > now + 10000) return;

      console.log(`\n[${new Date().toISOString()}] Market expired, fetching new markets...`);

      // Find and remove expired markets, preserving their stats
      const expiredTokens: string[] = [];
      for (const [slug, tracker] of marketTrackers.entries()) {
        if (tracker.expiresAt < now) {
          // Preserve stats before removing
          const symbol = extractSymbol(slug);
          const key = `${symbol}_${tracker.timeframe}`;
          const existing = historicalSymbolStats.get(key) || { samples: 0, hits: {} as ThresholdHits, priceSums: {} as ThresholdPriceSums };
          existing.samples += tracker.updates;
          for (const th of thresholds) {
            existing.hits[th] = (existing.hits[th] || 0) + (tracker.hits[th] || 0);
            // Merge price sums
            if (tracker.priceSums[th]) {
              if (!existing.priceSums[th]) {
                existing.priceSums[th] = { sumYes: 0, sumNo: 0, count: 0 };
              }
              existing.priceSums[th].sumYes += tracker.priceSums[th].sumYes;
              existing.priceSums[th].sumNo += tracker.priceSums[th].sumNo;
              existing.priceSums[th].count += tracker.priceSums[th].count;
            }
          }
          historicalSymbolStats.set(key, existing);

          // Collect tokens to unsubscribe
          expiredTokens.push(tracker.market.tokenYes, tracker.market.tokenNo);
          // Remove from tracking
          tokenToMarket.delete(tracker.market.tokenYes);
          tokenToMarket.delete(tracker.market.tokenNo);
          allTokenIds.delete(tracker.market.tokenYes);
          allTokenIds.delete(tracker.market.tokenNo);
          marketTrackers.delete(slug);
        }
      }

      if (expiredTokens.length > 0) {
        console.log(`Removed ${expiredTokens.length / 2} expired markets (${expiredTokens.length} tokens)`);
        // Note: Polymarket WS doesn't support unsubscribe for clob_market topic
        // Expired tokens will simply stop sending data after market resolution
      }

      // Fetch new markets
      const newMarketsWithTf: { market: MarketState; timeframe: string }[] = [];
      if (timeframes.includes("15m")) {
        const m15 = await fetchCrypto15mMarkets();
        for (const m of m15) newMarketsWithTf.push({ market: m, timeframe: "15m" });
      }
      if (timeframes.includes("1h")) {
        const m1h = await fetchCrypto1hMarkets();
        for (const m of m1h) newMarketsWithTf.push({ market: m, timeframe: "1h" });
      }
      if (timeframes.includes("4h")) {
        const m4h = await fetchCrypto4hMarkets();
        for (const m of m4h) newMarketsWithTf.push({ market: m, timeframe: "4h" });
      }

      const newTokens: string[] = [];
      for (const { market: m, timeframe } of newMarketsWithTf) {
        if (!marketTrackers.has(m.slug)) {
          const expiresAt = getMarketExpiry(m.slug, timeframe);
          const tracker: StatsMarketTracker = {
            market: { ...m },
            timeframe,
            expiresAt,
            updates: 0,
            hits: {},
            priceSums: {},
            lastCombined: Number.POSITIVE_INFINITY,
            asksYes: [],
            asksNo: [],
            activeOpportunities: new Map(),
            momentumYes: null,
            momentumNo: null,
            priceHistoryYes: [],
            priceHistoryNo: [],
            durations: {},
          };
          marketTrackers.set(m.slug, tracker);
          if (!allTokenIds.has(m.tokenYes)) {
            allTokenIds.add(m.tokenYes);
            tokenToMarket.set(m.tokenYes, { market: tracker, side: "yes" });
            newTokens.push(m.tokenYes);
          }
          if (!allTokenIds.has(m.tokenNo)) {
            allTokenIds.add(m.tokenNo);
            tokenToMarket.set(m.tokenNo, { market: tracker, side: "no" });
            newTokens.push(m.tokenNo);
          }
        }
      }

      // Update earliest expiry from remaining active markets
      if (marketTrackers.size > 0) {
        earliestExpiry = Math.min(...Array.from(marketTrackers.values()).map((t) => t.expiresAt));
      }

      // Re-subscribe to ALL active tokens to ensure connection is fresh
      // This fixes issues where subscriptions become stale after market expiry
      if (connected && activeClient && allTokenIds.size > 0) {
        const allTokensArray = Array.from(allTokenIds);
        console.log(`Re-subscribing to all ${allTokensArray.length} active tokens...`);
        // Subscribe in batches of 30 - only agg_orderbook
        for (let i = 0; i < allTokensArray.length; i += 30) {
          const batch = allTokensArray.slice(i, i + 30);
          activeClient.subscribe({
            subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(batch) }],
          });
        }
      }

      console.log(`Now tracking: ${marketTrackers.size} markets, ${allTokenIds.size} tokens, next expiry: ${formatExpiry(earliestExpiry)} UTC`);
    },
    30 * 1000 // Check every 30 seconds
  );

  process.on("SIGINT", () => {
    console.log("\nStopping and printing final summary...\n");
    clearInterval(logInterval);
    if (refreshInterval) clearInterval(refreshInterval);
    client.disconnect();
    bybitClient.disconnect();
    printSummary(tokenToMarket, overallHits, totalCombinedSamples, true, outCsvPath);
    process.exit(0);
  });

  await new Promise(() => {});
}

function printSummary(
  tokenToMarket: Map<string, { market: StatsMarketTracker; side: "yes" | "no" }>,
  overallHits: ThresholdHits,
  totalCombinedSamples: number,
  final = false,
  csvPath?: string
) {
  const trackers = Array.from(new Set(Array.from(tokenToMarket.values()).map((v) => v.market)));
  const marketCount = trackers.length;
  const marketsWithSamples = trackers.filter((t) => t.updates > 0);
  const now = Date.now();
  const deltaSamples = totalCombinedSamples - lastPrintSamples;
  const deltaSeconds = Math.max((now - lastPrintAt) / 1000, 1);
  const deltaMessages = totalMessages - lastPrintMessages;

  console.log(final ? "==== FINAL SUMMARY ====" : "---- STATS ----");
  console.log(`Markets with samples: ${marketsWithSamples.length}/${marketCount}, samples: ${totalCombinedSamples}`);
  console.log(`Delta since last summary: ${deltaSamples} samples in ${deltaSeconds.toFixed(1)}s ` + `(~${(deltaSamples / deltaSeconds).toFixed(2)} samples/s)`);
  console.log(`Messages: +${deltaMessages} (agg_orderbook: ${totalBookEvents})`);
  if (deltaSamples === 0) {
    console.log("⚠️  No new combined samples since last summary (WS idle or system slept?)");
  }

  if (totalCombinedSamples === 0) {
    console.log("No combined samples yet.\n");
    return;
  }

  const hitLines = thresholds
    .map((t) => {
      const hits = overallHits[t] || 0;
      const pct = ((hits / totalCombinedSamples) * 100).toFixed(2);
      return `<=${t}: ${hits} (${pct}%)`;
    })
    .join(" | ");
  console.log(`Threshold hits: ${hitLines}`);

  // Print time-to-expiry distribution for key thresholds
  const keyThresholds = [0.98, 0.99, 1];
  for (const th of keyThresholds) {
    if (!overallExpiryHits[th]) continue;
    const bucketHits = overallExpiryHits[th];
    const totalForTh = Object.values(bucketHits).reduce((a, b) => a + b, 0);
    if (totalForTh === 0) continue;
    const bucketStr = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"]
      .map((b) => {
        const count = bucketHits[b] || 0;
        const pct = totalForTh > 0 ? ((count / totalForTh) * 100).toFixed(1) : "0";
        return `${b}min:${count}(${pct}%)`;
      })
      .join(" ");
    console.log(`  <=${th} by expiry: ${bucketStr}`);
  }

  // Print liquidity stats for key thresholds
  console.log("\nLiquidity at thresholds (USD available):");
  for (const th of keyThresholds) {
    const liq = overallLiquidity[th];
    if (!liq || liq.count === 0) {
      console.log(`  <=${th}: no data`);
      continue;
    }
    const avgUsd = (liq.sumUsd / liq.count).toFixed(2);
    console.log(`  <=${th}: avg=$${avgUsd}, max=$${liq.maxUsd.toFixed(2)}, samples=${liq.count}`);
  }

  // Print opportunity duration stats
  console.log("\nOpportunity duration (how long arb window stayed open):");
  for (const th of keyThresholds) {
    const dur = overallDuration[th];
    if (!dur || dur.count === 0) {
      console.log(`  <=${th}: no completed opportunities`);
      continue;
    }
    const avgMs = dur.sumMs / dur.count;
    const minMs = dur.minMs === Number.POSITIVE_INFINITY ? 0 : dur.minMs;
    console.log(`  <=${th}: avg=${avgMs.toFixed(0)}ms, min=${minMs.toFixed(0)}ms, max=${dur.maxMs.toFixed(0)}ms, count=${dur.count}`);
  }

  // Print momentum (spot-lag) stats
  if (momentumMoves.length > 0) {
    console.log("\nMomentum moves (spot-lag detection: <0.5 → >target within 90s):");
    for (const target of momentumEndThresholds) {
      const moves = momentumMoves.filter((m) => m.targetThreshold === target);
      if (moves.length === 0) continue;
      const avgDur = moves.reduce((a, m) => a + m.durationMs, 0) / moves.length;
      const avgExpiry = moves.reduce((a, m) => a + m.secondsToExpiry, 0) / moves.length;
      console.log(`  →${target}: ${moves.length} moves, avg duration=${(avgDur / 1000).toFixed(1)}s, avg expiry=${avgExpiry.toFixed(0)}s`);
    }
  }

  // Print spot-lag correlation stats (Bybit → Polymarket)
  if (spotLagEvents.length > 0) {
    console.log("\nSpot-Lag Correlation (Bybit spot → Polymarket odds):");
    const bySymbol = new Map<string, SpotLagEvent[]>();
    for (const e of spotLagEvents) {
      const arr = bySymbol.get(e.symbol) || [];
      arr.push(e);
      bySymbol.set(e.symbol, arr);
    }
    for (const [sym, events] of bySymbol) {
      const avgLag = events.reduce((a, e) => a + e.lagMs, 0) / events.length;
      const profitableCount = events.filter((e) => e.profitable).length;
      const profitRate = (profitableCount / events.length) * 100;
      console.log(
        `  ${sym}: ${events.length} events, avg lag=${(avgLag / 1000).toFixed(1)}s, profitable=${profitableCount}/${events.length} (${profitRate.toFixed(0)}%)`
      );
    }
  }

  // Print pending spot moves being tracked
  if (pendingSpotMoves.length > 0) {
    console.log(`  Pending spot moves: ${pendingSpotMoves.length} (waiting for Polymarket to catch up)`);
  }

  // Print Bybit status
  console.log(`\nBybit spot monitoring: ${bybitMomentumEventsReceived} momentum events received`);
  if (latestPolyPrices.size > 0) {
    const polyPriceStr = Array.from(latestPolyPrices.entries())
      .map(([s, p]) => `${s}:YES=${p.yes.toFixed(3)}`)
      .join(", ");
    console.log(`  Polymarket prices tracked: ${polyPriceStr}`);
  }

  const lowestCombos = trackers
    .filter((t) => Number.isFinite(t.lastCombined))
    .sort((a, b) => a.lastCombined - b.lastCombined)
    .slice(0, 5);

  if (lowestCombos.length > 0) {
    console.log("\nLowest observed combined (top 5):");
    for (const t of lowestCombos) {
      const hits = thresholds.map((th) => `${th}:${t.hits[th] || 0}`).join(" ");
      console.log(`  ${t.market.slug.substring(0, 50).padEnd(50)} min=${t.lastCombined.toFixed(4)} updates=${t.updates} hits[${hits}]`);
    }
  }

  console.log("");

  if (csvPath) {
    const symbolStats = aggregateSymbolStats(trackers);
    writeCsvSummary(csvPath, totalCombinedSamples, overallHits, overallPriceSums, symbolStats);
    writeHighPriceCsv(csvPath.replace(".csv", "-nearprice.csv"), new Date().toISOString());
    writeLowPriceCsv(csvPath.replace(".csv", "-lowprice.csv"), new Date().toISOString());
    writeMomentumCsv(csvPath.replace(".csv", "-momentum.csv"), new Date().toISOString());
    writeDurationPerSymbolCsv(csvPath.replace(".csv", "-duration-symbol.csv"), new Date().toISOString(), trackers);
    writeSpotLagCsv(csvPath.replace(".csv", "-spotlag.csv"), new Date().toISOString());
    writeDurationByExpiryCsv(csvPath.replace(".csv", "-duration-expiry.csv"), new Date().toISOString());
  }

  lastPrintSamples = totalCombinedSamples;
  lastPrintAt = now;
  lastPrintMessages = totalMessages;
}

function ensureCsvHeader(path: string, ths: number[]) {
  // Add avg_yes and avg_no columns for each threshold
  const hitCols = ths.map((t) => `hits_le_${t}`);
  const avgCols = ths.flatMap((t) => [`avg_yes_le_${t}`, `avg_no_le_${t}`]);
  const expectedHeader = ["timestamp", "row_type", "symbol", "timeframe", "samples", ...hitCols, ...avgCols].join(",") + "\n";
  if (existsSync(path)) {
    try {
      const current = readFileSync(path, "utf8").split("\n")[0] + "\n";
      if (current === expectedHeader) return;
      console.log(`CSV header mismatch; rewriting header to: ${expectedHeader.trim()}`);
    } catch {
      // fall through to rewrite
    }
  }
  writeFileSync(path, expectedHeader, { encoding: "utf8" });
}

// Calculate USD available at each threshold level using full orderbook
function calculateLiquidityAtThreshold(asksYes: OrderbookLevel[], asksNo: OrderbookLevel[], threshold: number): number {
  if (asksYes.length === 0 || asksNo.length === 0) return 0;

  // Sort asks by price ascending
  const sortedYes = [...asksYes].sort((a, b) => a.price - b.price);
  const sortedNo = [...asksNo].sort((a, b) => a.price - b.price);

  let totalUsd = 0;
  let yesIdx = 0;
  let noIdx = 0;

  // Find pairs where combined price <= threshold
  while (yesIdx < sortedYes.length && noIdx < sortedNo.length) {
    const yesLevel = sortedYes[yesIdx];
    const noLevel = sortedNo[noIdx];
    const combined = yesLevel.price + noLevel.price;

    if (combined <= threshold) {
      // Can buy at this combined price - take min shares available
      const shares = Math.min(yesLevel.size, noLevel.size);
      const usd = shares * combined; // approximate USD value
      totalUsd += usd;

      // Consume the smaller side
      if (yesLevel.size <= noLevel.size) {
        sortedNo[noIdx] = { ...noLevel, size: noLevel.size - shares };
        yesIdx++;
      } else {
        sortedYes[yesIdx] = { ...yesLevel, size: yesLevel.size - shares };
        noIdx++;
      }
    } else {
      // Combined too high, try next level on cheaper side
      if (yesLevel.price < noLevel.price) {
        yesIdx++;
      } else {
        noIdx++;
      }
    }
  }

  return totalUsd;
}

function applyBestAskWithLiquidity(entry: { market: StatsMarketTracker; side: "yes" | "no" }, bestAsk: number) {
  if (entry.side === "yes") entry.market.market.bestAskYes = bestAsk;
  else entry.market.market.bestAskNo = bestAsk;

  const { bestAskYes, bestAskNo } = entry.market.market;
  if (bestAskYes > 0 && bestAskNo > 0) {
    const combined = bestAskYes + bestAskNo;
    const now = Date.now();

    // If we had a long gap since last book update, reset active opportunities to avoid spanning WS stalls
    if (entry.market.lastBookTs && now - entry.market.lastBookTs > reconnectGapMs) {
      entry.market.activeOpportunities.clear();
    }
    entry.market.lastBookTs = now;

    entry.market.lastCombined = Math.min(entry.market.lastCombined, combined);
    entry.market.updates += 1;
    totalCombinedSamples += 1;
    bumpThresholdHits(combined, thresholds, entry.market.hits);
    bumpThresholdHits(combined, thresholds, overallHits);
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, entry.market.priceSums);
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, overallPriceSums);
    bumpTimeToExpiryHits(combined, entry.market.expiresAt, thresholds, overallExpiryHits);
    // Track near-expiry high pricing per leg
    bumpHighPriceExpiryHits(bestAskYes, entry.market.expiresAt, highPriceThresholds, highPriceExpiryYes);
    bumpHighPriceExpiryHits(bestAskNo, entry.market.expiresAt, highPriceThresholds, highPriceExpiryNo);
    // Track near-expiry low pricing per leg (dust opportunities)
    bumpLowPriceExpiryHits(bestAskYes, entry.market.expiresAt, lowPriceThresholds, lowPriceExpiryYes);
    bumpLowPriceExpiryHits(bestAskNo, entry.market.expiresAt, lowPriceThresholds, lowPriceExpiryNo);

    // Track momentum (spot-lag): detect rapid price moves from <0.5 to >0.8/0.9/0.95
    trackMomentum(entry, bestAsk, now);

    // Track opportunity duration per threshold
    for (const th of thresholds) {
      const isOpportunity = combined <= th;
      const wasActive = entry.market.activeOpportunities.has(th);

      if (isOpportunity && !wasActive) {
        // Opportunity just started
        entry.market.activeOpportunities.set(th, now);
      } else if (!isOpportunity && wasActive) {
        // Opportunity just ended - record duration
        const startedAt = entry.market.activeOpportunities.get(th)!;
        const rawDuration = now - startedAt;
        const durationMs = Math.min(rawDuration, durationHardCapMs);
        entry.market.activeOpportunities.delete(th);

        // Update overall duration stats
        const dur = ensureOverallDuration(th);
        dur.sumMs += durationMs;
        dur.count += 1;
        dur.maxMs = Math.max(dur.maxMs, durationMs);
        dur.minMs = Math.min(dur.minMs, durationMs);
        dur.samples.push(durationMs);
        if (dur.samples.length > durationSampleCap) {
          dur.samples.shift();
        }

        // Update per-market duration stats
        const mktDur = ensureMarketDuration(entry.market, th);
        mktDur.sumMs += durationMs;
        mktDur.count += 1;
        mktDur.maxMs = Math.max(mktDur.maxMs, durationMs);
        mktDur.minMs = Math.min(mktDur.minMs, durationMs);
        mktDur.samples.push(durationMs);
        if (mktDur.samples.length > durationSampleCap) {
          mktDur.samples.shift();
        }

        // Track duration by time-to-expiry bucket
        recordDurationByExpiry(th, entry.market.expiresAt, durationMs);
      }
      // If still active (isOpportunity && wasActive), keep tracking
    }

    // Calculate liquidity at each threshold when we have orderbook data
    if (entry.market.asksYes.length > 0 && entry.market.asksNo.length > 0) {
      for (const th of thresholds) {
        if (combined <= th) {
          const usd = calculateLiquidityAtThreshold(entry.market.asksYes, entry.market.asksNo, th);
          if (!overallLiquidity[th]) {
            overallLiquidity[th] = { sumUsd: 0, count: 0, maxUsd: 0 };
          }
          overallLiquidity[th].sumUsd += usd;
          overallLiquidity[th].count += 1;
          overallLiquidity[th].maxUsd = Math.max(overallLiquidity[th].maxUsd, usd);
        }
      }
    }
  }
}

function aggregateSymbolStats(trackers: StatsMarketTracker[]) {
  // Start with historical stats from expired markets
  const stats = new Map<string, { samples: number; hits: ThresholdHits; priceSums: ThresholdPriceSums }>();
  for (const [key, hist] of historicalSymbolStats.entries()) {
    stats.set(key, { samples: hist.samples, hits: { ...hist.hits }, priceSums: { ...hist.priceSums } });
  }

  // Add current active tracker stats
  for (const t of trackers) {
    const symbol = extractSymbol(t.market.slug);
    const key = `${symbol}_${t.timeframe}`;
    const current = stats.get(key) || { samples: 0, hits: {} as ThresholdHits, priceSums: {} as ThresholdPriceSums };
    current.samples += t.updates;
    for (const th of thresholds) {
      current.hits[th] = (current.hits[th] || 0) + (t.hits[th] || 0);
      // Merge price sums
      if (t.priceSums[th]) {
        if (!current.priceSums[th]) {
          current.priceSums[th] = { sumYes: 0, sumNo: 0, count: 0 };
        }
        current.priceSums[th].sumYes += t.priceSums[th].sumYes;
        current.priceSums[th].sumNo += t.priceSums[th].sumNo;
        current.priceSums[th].count += t.priceSums[th].count;
      }
    }
    stats.set(key, current);
  }

  return Array.from(stats.entries()).map(([key, data]) => {
    const [symbol, timeframe] = key.split("_");
    return { symbol, timeframe, ...data };
  });
}

function writeCsvSummary(
  path: string,
  totalSamples: number,
  hits: ThresholdHits,
  priceSums: ThresholdPriceSums,
  symbolStats: { symbol: string; timeframe: string; samples: number; hits: ThresholdHits; priceSums: ThresholdPriceSums }[]
) {
  const ts = new Date().toISOString();
  const makeLine = (rowType: string, symbol: string, timeframe: string, samples: number, rowHits: ThresholdHits, rowPriceSums: ThresholdPriceSums) => {
    const hitValues = thresholds.map((t) => (rowHits[t] || 0).toString());
    const avgValues = thresholds.flatMap((t) => {
      const ps = rowPriceSums[t];
      if (!ps || ps.count === 0) return ["", ""];
      const avgYes = (ps.sumYes / ps.count).toFixed(4);
      const avgNo = (ps.sumNo / ps.count).toFixed(4);
      return [avgYes, avgNo];
    });
    return [ts, rowType, symbol, timeframe, samples.toString(), ...hitValues, ...avgValues].join(",") + "\n";
  };

  let buf = "";
  buf += makeLine("all", "", "", totalSamples, hits, priceSums);
  for (const s of symbolStats) {
    buf += makeLine("symbol", s.symbol, s.timeframe, s.samples, s.hits, s.priceSums);
  }
  appendFileSync(path, buf, { encoding: "utf8" });

  // Write time bucket data to separate CSV
  writeTimeBucketCsv(path.replace(".csv", "-buckets.csv"), ts);
  // Write liquidity data to separate CSV
  writeLiquidityCsv(path.replace(".csv", "-liquidity.csv"), ts);
  // Write duration data to separate CSV
  writeDurationCsv(path.replace(".csv", "-duration.csv"), ts);
}

function writeHighPriceCsv(path: string, ts: string) {
  const header =
    ["timestamp", "side", "threshold", ...FINE_EXPIRY_BUCKETS.map((b) => `hits_${b}`), ...FINE_EXPIRY_BUCKETS.map((b) => `pct_${b}`)].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  const sides: ["yes" | "no", HighPriceExpiryHits][] = [
    ["yes", highPriceExpiryYes],
    ["no", highPriceExpiryNo],
  ];

  let buf = "";
  for (const [side, hits] of sides) {
    for (const th of highPriceThresholds) {
      const buckets = hits[th];
      if (!buckets) continue;
      const total = Object.values(buckets).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const hitValues = FINE_EXPIRY_BUCKETS.map((b) => (buckets[b] || 0).toString());
      const pctValues = FINE_EXPIRY_BUCKETS.map((b) => {
        const count = buckets[b] || 0;
        return total > 0 ? ((count / total) * 100).toFixed(2) : "0";
      });
      buf += [ts, side, th.toString(), ...hitValues, ...pctValues].join(",") + "\n";
    }
  }

  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeLowPriceCsv(path: string, ts: string) {
  const header =
    ["timestamp", "side", "threshold", ...FINE_EXPIRY_BUCKETS.map((b) => `hits_${b}`), ...FINE_EXPIRY_BUCKETS.map((b) => `pct_${b}`)].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  const sides: ["yes" | "no", LowPriceExpiryHits][] = [
    ["yes", lowPriceExpiryYes],
    ["no", lowPriceExpiryNo],
  ];

  let buf = "";
  for (const [side, hits] of sides) {
    for (const th of lowPriceThresholds) {
      const buckets = hits[th];
      if (!buckets) continue;
      const total = Object.values(buckets).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const hitValues = FINE_EXPIRY_BUCKETS.map((b) => (buckets[b] || 0).toString());
      const pctValues = FINE_EXPIRY_BUCKETS.map((b) => {
        const count = buckets[b] || 0;
        return total > 0 ? ((count / total) * 100).toFixed(2) : "0";
      });
      buf += [ts, side, th.toString(), ...hitValues, ...pctValues].join(",") + "\n";
    }
  }

  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeTimeBucketCsv(path: string, ts: string) {
  const buckets = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"];

  // Ensure header exists
  const header = ["timestamp", "threshold", ...buckets.map((b) => `hits_${b}min`), ...buckets.map((b) => `pct_${b}min`)].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const th of thresholds) {
    if (!overallExpiryHits[th]) continue;
    const bucketHits = overallExpiryHits[th];
    const totalForTh = Object.values(bucketHits).reduce((a, b) => a + b, 0);
    if (totalForTh === 0) continue;

    const hitValues = buckets.map((b) => (bucketHits[b] || 0).toString());
    const pctValues = buckets.map((b) => {
      const count = bucketHits[b] || 0;
      return totalForTh > 0 ? ((count / totalForTh) * 100).toFixed(2) : "0";
    });
    buf += [ts, th.toString(), ...hitValues, ...pctValues].join(",") + "\n";
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeLiquidityCsv(path: string, ts: string) {
  // Ensure header exists
  const header = ["timestamp", "threshold", "avg_usd", "max_usd", "samples"].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const th of thresholds) {
    const liq = overallLiquidity[th];
    if (!liq || liq.count === 0) continue;
    const avgUsd = (liq.sumUsd / liq.count).toFixed(2);
    buf += [ts, th.toString(), avgUsd, liq.maxUsd.toFixed(2), liq.count.toString()].join(",") + "\n";
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeDurationCsv(path: string, ts: string) {
  // Ensure header exists
  const header = ["timestamp", "threshold", "avg_ms", "p90_ms", "med_ms", "rolling_p90_ms", "min_ms", "max_ms", "count"].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const th of thresholds) {
    const dur = overallDuration[th];
    if (!dur || dur.count === 0) continue;
    const avgMs = (dur.sumMs / dur.count).toFixed(0);
    const minMs = dur.minMs === Number.POSITIVE_INFINITY ? "0" : dur.minMs.toFixed(0);
    const p90Ms = p90(dur.samples).toFixed(0);
    const medMs = median(dur.samples).toFixed(0);
    const rollingP90 = p90(dur.samples.slice(-durationSampleCap)).toFixed(0);
    buf += [ts, th.toString(), avgMs, p90Ms, medMs, rollingP90, minMs, dur.maxMs.toFixed(0), dur.count.toString()].join(",") + "\n";
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeDurationPerSymbolCsv(path: string, ts: string, trackers: StatsMarketTracker[]) {
  // Per-symbol duration CSV: tracks how long opportunities last per market
  const header = ["timestamp", "symbol", "timeframe", "threshold", "avg_ms", "p90_ms", "med_ms", "min_ms", "max_ms", "count"].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const tracker of trackers) {
    const symbol = extractSymbol(tracker.market.slug);
    for (const th of thresholds) {
      const dur = tracker.durations[th];
      if (!dur || dur.count === 0) continue;
      const avgMs = (dur.sumMs / dur.count).toFixed(0);
      const minMs = dur.minMs === Number.POSITIVE_INFINITY ? "0" : dur.minMs.toFixed(0);
      const p90Ms = p90(dur.samples).toFixed(0);
      const medMs = median(dur.samples).toFixed(0);
      buf += [ts, symbol, tracker.timeframe, th.toString(), avgMs, p90Ms, medMs, minMs, dur.maxMs.toFixed(0), dur.count.toString()].join(",") + "\n";
    }
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeMomentumCsv(path: string, ts: string) {
  // Momentum CSV: tracks rapid price moves (spot-lag exploitation)
  const header =
    ["timestamp", "target_threshold", "count", "avg_duration_s", "min_duration_s", "max_duration_s", "avg_expiry_s", "avg_start_price", "avg_end_price"].join(
      ","
    ) + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const target of momentumEndThresholds) {
    const moves = momentumMoves.filter((m) => m.targetThreshold === target);
    if (moves.length === 0) continue;

    const avgDur = moves.reduce((a, m) => a + m.durationMs, 0) / moves.length / 1000;
    const minDur = Math.min(...moves.map((m) => m.durationMs)) / 1000;
    const maxDur = Math.max(...moves.map((m) => m.durationMs)) / 1000;
    const avgExpiry = moves.reduce((a, m) => a + m.secondsToExpiry, 0) / moves.length;
    const avgStart = moves.reduce((a, m) => a + m.startPrice, 0) / moves.length;
    const avgEnd = moves.reduce((a, m) => a + m.endPrice, 0) / moves.length;

    buf +=
      [
        ts,
        target.toString(),
        moves.length.toString(),
        avgDur.toFixed(1),
        minDur.toFixed(1),
        maxDur.toFixed(1),
        avgExpiry.toFixed(0),
        avgStart.toFixed(3),
        avgEnd.toFixed(3),
      ].join(",") + "\n";
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

function writeSpotLagCsv(path: string, ts: string) {
  // Spot-lag CSV: tracks correlation between Bybit spot moves and Polymarket adjustments
  const header =
    ["timestamp", "symbol", "spot_direction", "spot_pct_change", "lag_ms", "poly_start_price", "poly_end_price", "poly_pct_change", "profitable"].join(",") +
    "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  if (spotLagEvents.length === 0) return;

  // Write individual events
  let buf = "";
  for (const e of spotLagEvents) {
    buf +=
      [
        ts,
        e.symbol,
        e.spotDirection,
        e.spotPctChange.toFixed(3),
        e.lagMs.toString(),
        e.polyStartPrice.toFixed(4),
        e.polyEndPrice.toFixed(4),
        e.polyPriceChange.toFixed(2),
        e.profitable ? "1" : "0",
      ].join(",") + "\n";
  }
  appendFileSync(path, buf, { encoding: "utf8" });

  // Clear events after writing to avoid duplicates
  spotLagEvents = [];
}

function writeDurationByExpiryCsv(path: string, ts: string) {
  // Duration by time-to-expiry CSV: shows how opportunity duration varies with market age
  const header = ["timestamp", "threshold", "expiry_bucket", "avg_ms", "min_ms", "max_ms", "count"].join(",") + "\n";
  if (!existsSync(path)) {
    writeFileSync(path, header, { encoding: "utf8" });
  }

  let buf = "";
  for (const th of thresholds) {
    const buckets = durationByExpiry[th];
    if (!buckets) continue;
    for (const bucket of FINE_EXPIRY_BUCKETS) {
      const data = buckets[bucket];
      if (!data || data.count === 0) continue;
      const avgMs = (data.sumMs / data.count).toFixed(0);
      const minMs = data.minMs === Number.POSITIVE_INFINITY ? "0" : data.minMs.toFixed(0);
      buf += [ts, th.toString(), bucket, avgMs, minMs, data.maxMs.toFixed(0), data.count.toString()].join(",") + "\n";
    }
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

main();
