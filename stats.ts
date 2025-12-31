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
import { fetchCrypto15mMarkets, fetchCrypto1hMarkets, fetchCrypto4hMarkets } from "./gamma";
import type { MarketState } from "./types";
import { bumpThresholdHits } from "./stats-utils";

let lastPrintSamples = 0;
let lastPrintAt = Date.now();
let lastPrintMessages = 0;

let totalMessages = 0;
let totalPriceChangeEvents = 0;
let totalBookEvents = 0;
let totalCombinedSamples = 0;
let overallHits: ThresholdHits = {};

type ThresholdHits = Record<number, number>;

interface MarketTracker {
  market: MarketState;
  updates: number;
  hits: ThresholdHits;
  lastCombined: number;
}

const thresholds = (process.env.STATS_THRESHOLDS || "1,0.995,0.99,0.985,0.98,0.95,0.9")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => !Number.isNaN(t))
  .sort((a, b) => a - b); // ascending so lower thresholds appear last in logs

const defaultLogSeconds = 60;
const logSecondsRaw = process.env.STATS_LOG_SECONDS;
const logSeconds = Number.isFinite(Number(logSecondsRaw)) && Number(logSecondsRaw) > 0 ? Number(logSecondsRaw) : defaultLogSeconds;
const refreshMinutesRaw = process.env.STATS_REFRESH_MINUTES;
const refreshMinutes = Number.isFinite(Number(refreshMinutesRaw)) && Number(refreshMinutesRaw) > 0 ? Number(refreshMinutesRaw) : 10;
const outCsvPath = process.env.STATS_OUT_CSV || "stats-summary.csv";
const timeframes = (process.env.STATS_TIMEFRAMES || "15m,1h,4h").split(",").map((t) => t.trim());

async function main() {
  // Fetch markets based on configured timeframes
  let markets: MarketState[] = [];
  if (timeframes.includes("15m")) {
    const m15 = await fetchCrypto15mMarkets();
    markets = markets.concat(m15);
  }
  if (timeframes.includes("1h")) {
    const m1h = await fetchCrypto1hMarkets();
    markets = markets.concat(m1h);
  }
  if (timeframes.includes("4h")) {
    const m4h = await fetchCrypto4hMarkets();
    markets = markets.concat(m4h);
  }

  if (markets.length === 0) {
    console.log("No crypto markets found. Exiting.");
    return;
  }

  const tokenToMarket = new Map<string, { market: MarketTracker; side: "yes" | "no" }>();
  const allTokenIds = new Set<string>();
  const marketTrackers = new Map<string, MarketTracker>();

  for (const m of markets) {
    const tracker: MarketTracker = {
      market: { ...m },
      updates: 0,
      hits: {},
      lastCombined: Number.POSITIVE_INFINITY,
    };
    tokenToMarket.set(m.tokenYes, { market: tracker, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: tracker, side: "no" });
    allTokenIds.add(m.tokenYes);
    allTokenIds.add(m.tokenNo);
    marketTrackers.set(m.slug, tracker);
  }

  console.log(`=== STATS: Crypto ${timeframes.join("/")} markets ===`);
  console.log(`Markets: ${marketTrackers.size}, Token IDs: ${allTokenIds.size}`);
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

      if (topic === "clob_market" && type === "price_change") {
        totalPriceChangeEvents += 1;
        const priceChanges = (payload?.pc || payload?.price_changes) as { a: string; ba?: string; best_ask?: string }[] | undefined;
        if (!priceChanges) return;

        for (const pc of priceChanges) {
          const assetId = pc.a || (pc as any).asset_id;
          const bestAsk = Number(pc.ba ?? (pc as any).best_ask);
          if (!assetId || !Number.isFinite(bestAsk) || bestAsk <= 0) continue;

          const entry = tokenToMarket.get(assetId);
          if (!entry) continue;

          applyBestAsk(entry, bestAsk);
        }
      }

      if (topic === "clob_market" && type === "agg_orderbook") {
        totalBookEvents += 1;
        const assetId = (payload as any)?.asset_id as string;
        const asks = (payload as any)?.asks as { price: string }[] | undefined;
        if (!assetId || !asks || asks.length === 0) return;
        const bestAsk = Math.min(...asks.map((a) => Number(a.price)));
        if (!Number.isFinite(bestAsk) || bestAsk <= 0) return;
        const entry = tokenToMarket.get(assetId);
        if (!entry) return;
        applyBestAsk(entry, bestAsk);
      }
    },
    onConnect: (connectedClient: RealTimeDataClient) => {
      const now = Date.now();
      const uptime = lastConnectTime ? ((now - lastConnectTime) / 1000).toFixed(1) : "N/A";
      lastConnectTime = now;
      connected = true;
      activeClient = connectedClient;
      console.log(`[${new Date().toISOString()}] WebSocket connected (previous session: ${uptime}s, disconnects: ${disconnectCount})`);
      console.log("Subscribing to clob_market price_change...\n");

      // Subscribe in batches to avoid "Invalid request body" error
      const tokenArray = Array.from(allTokenIds);
      const batchSize = 30;
      for (let i = 0; i < tokenArray.length; i += batchSize) {
        const batch = tokenArray.slice(i, i + batchSize);
        connectedClient.subscribe({
          subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(batch) }],
        });
        console.log(`  Subscribed batch ${Math.floor(i / batchSize) + 1}: ${batch.length} tokens`);
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
    printSummary(tokenToMarket, overallHits, totalCombinedSamples, false, outCsvPath);
  }, logSeconds * 1000);

  const refreshInterval =
    refreshMinutes > 0
      ? setInterval(
          async () => {
            // Refresh markets based on configured timeframes
            let newMarkets: MarketState[] = [];
            if (timeframes.includes("15m")) {
              const m15 = await fetchCrypto15mMarkets();
              newMarkets = newMarkets.concat(m15);
            }
            if (timeframes.includes("1h")) {
              const m1h = await fetchCrypto1hMarkets();
              newMarkets = newMarkets.concat(m1h);
            }
            if (timeframes.includes("4h")) {
              const m4h = await fetchCrypto4hMarkets();
              newMarkets = newMarkets.concat(m4h);
            }
            const newTokens: string[] = [];
            for (const m of newMarkets) {
              if (!marketTrackers.has(m.slug)) {
                const tracker: MarketTracker = {
                  market: { ...m },
                  updates: 0,
                  hits: {},
                  lastCombined: Number.POSITIVE_INFINITY,
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
            if (connected && activeClient && newTokens.length > 0) {
              console.log(`Discovered ${newTokens.length} new token IDs; subscribing...`);
              activeClient.subscribe({
                subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(newTokens) }],
              });
              console.log(`Now tracking markets: ${marketTrackers.size}, token IDs: ${allTokenIds.size}`);
            }
          },
          refreshMinutes * 60 * 1000
        )
      : undefined;

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
  tokenToMarket: Map<string, { market: MarketTracker; side: "yes" | "no" }>,
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
  console.log(`Messages: +${deltaMessages} (price_change: ${totalPriceChangeEvents}, agg_orderbook: ${totalBookEvents})`);
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
    writeCsvSummary(csvPath, totalCombinedSamples, overallHits, symbolStats);
  }

  lastPrintSamples = totalCombinedSamples;
  lastPrintAt = now;
  lastPrintMessages = totalMessages;
}

function ensureCsvHeader(path: string, ths: number[]) {
  const expectedHeader = ["timestamp", "row_type", "symbol", "samples", ...ths.map((t) => `hits_le_${t}`)].join(",") + "\n";
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

function applyBestAsk(entry: { market: MarketTracker; side: "yes" | "no" }, bestAsk: number) {
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
  }
}

function aggregateSymbolStats(trackers: MarketTracker[]) {
  const stats = new Map<
    string,
    {
      samples: number;
      hits: ThresholdHits;
    }
  >();

  for (const t of trackers) {
    const symbol = t.market.slug.split("-")[0] || "unknown";
    const current = stats.get(symbol) || { samples: 0, hits: {} };
    current.samples += t.updates;
    for (const th of thresholds) {
      current.hits[th] = (current.hits[th] || 0) + (t.hits[th] || 0);
    }
    stats.set(symbol, current);
  }

  return Array.from(stats.entries()).map(([symbol, data]) => ({ symbol, ...data }));
}

function writeCsvSummary(path: string, totalSamples: number, hits: ThresholdHits, symbolStats: { symbol: string; samples: number; hits: ThresholdHits }[]) {
  const ts = new Date().toISOString();
  const makeLine = (rowType: string, symbol: string, samples: number, rowHits: ThresholdHits) =>
    [ts, rowType, symbol, samples.toString(), ...thresholds.map((t) => (rowHits[t] || 0).toString())].join(",") + "\n";

  let buf = "";
  buf += makeLine("all", "", totalSamples, hits);
  for (const s of symbolStats) {
    buf += makeLine("symbol", s.symbol, s.samples, s.hits);
  }
  appendFileSync(path, buf, { encoding: "utf8" });
}

main();
