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
 */
import { RealTimeDataClient, ConnectionStatus } from "@polymarket/real-time-data-client";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fetchCrypto15mMarkets, fetchCrypto1hMarkets, fetchCrypto4hMarkets } from "../core/gamma";
import type { MarketState, StatsMarketTracker, ThresholdHits, ThresholdPriceSums, TimeToExpiryHits, ThresholdLiquidity, OrderbookLevel } from "../core/types";
import { bumpThresholdHits, bumpThresholdPriceSums, getExpiryBucket, bumpTimeToExpiryHits } from "./utils";
import { getMarketExpiry, formatExpiry, extractSymbol } from "../core/utils";

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
  console.log("Connecting to WebSocket...\n");

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

function applyBestAsk(entry: { market: StatsMarketTracker; side: "yes" | "no" }, bestAsk: number) {
  if (entry.side === "yes") entry.market.market.bestAskYes = bestAsk;
  else entry.market.market.bestAskNo = bestAsk;

  const { bestAskYes, bestAskNo } = entry.market.market;
  if (bestAskYes > 0 && bestAskNo > 0) {
    const combined = bestAskYes + bestAskNo;
    entry.market.lastCombined = Math.min(entry.market.lastCombined, combined);
    entry.market.updates += 1;
    totalCombinedSamples += 1;
    bumpThresholdHits(combined, thresholds, entry.market.hits);
    bumpThresholdHits(combined, thresholds, overallHits);
    // Track YES/NO prices when thresholds are hit
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, entry.market.priceSums);
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, overallPriceSums);
    // Track by time-to-expiration bucket
    bumpTimeToExpiryHits(combined, entry.market.expiresAt, thresholds, overallExpiryHits);
  }
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
    entry.market.lastCombined = Math.min(entry.market.lastCombined, combined);
    entry.market.updates += 1;
    totalCombinedSamples += 1;
    bumpThresholdHits(combined, thresholds, entry.market.hits);
    bumpThresholdHits(combined, thresholds, overallHits);
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, entry.market.priceSums);
    bumpThresholdPriceSums(combined, bestAskYes, bestAskNo, thresholds, overallPriceSums);
    bumpTimeToExpiryHits(combined, entry.market.expiresAt, thresholds, overallExpiryHits);

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

main();
