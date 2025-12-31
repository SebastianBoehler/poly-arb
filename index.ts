/**
 * Real-time ladder accumulation using Polymarket WebSocket streams.
 * Fetches ALL neg_risk (binary) markets and streams real-time prices.
 *
 * Usage: bun run index.ts
 *
 * Env vars:
 *   DURATION_SEC=300        How long to run (5 min default)
 *   BASE_SIZE_USDC=5        Base USD per ladder level
 *   LADDER_STEP=0.01        Combined price drop to trigger next level
 *   SIZE_MULTIPLIER=1.5     Multiply size at each ladder level
 *   MAX_MARKETS=100         Maximum number of markets to track
 *   MAX_INITIAL_COMBINED=1.005  Only enter if combined < this
 */

import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { MarketState } from "./types";
import { fetchCrypto15mMarkets } from "./gamma";

const baseSizeUsdc = Number(process.env.BASE_SIZE_USDC) || 5;
const ladderStep = Number(process.env.LADDER_STEP) || 0.01;
const sizeMultiplier = Number(process.env.SIZE_MULTIPLIER) || 1.5;
const maxMarkets = Number(process.env.MAX_MARKETS) || 100;
const maxInitialCombined = Number(process.env.MAX_INITIAL_COMBINED) || 1.005;
const fee = 0.02;

function computeMetrics(state: MarketState) {
  const avgYes = state.totalSharesYes > 0 ? state.totalCostYes / state.totalSharesYes : 0;
  const avgNo = state.totalSharesNo > 0 ? state.totalCostNo / state.totalSharesNo : 0;
  const combined = avgYes + avgNo;
  const maxLeg = Math.max(avgYes, avgNo);
  const payout = 1 - fee * (1 - maxLeg);
  const edge = payout - combined;
  const edgePct = combined > 0 ? ((edge / combined) * 100).toFixed(2) : "0.00";
  const profitable = edge > 0;
  return { avgYes, avgNo, combined, payout, edge, edgePct, profitable };
}

function tryEntry(m: MarketState): void {
  if (m.bestAskYes <= 0 || m.bestAskNo <= 0) return;

  const currentCombined = m.bestAskYes + m.bestAskNo;
  if (currentCombined < m.lowestCombined) m.lowestCombined = currentCombined;
  if (currentCombined > m.highestCombined) m.highestCombined = currentCombined;

  let shouldEnter = false;
  let entrySize = baseSizeUsdc;

  if (m.entryCount === 0) {
    if (currentCombined <= maxInitialCombined) {
      shouldEnter = true;
      m.ladderLevel = 1;
    }
  } else {
    const combinedDrop = m.lastEntryCombined - currentCombined;
    if (combinedDrop >= ladderStep) {
      shouldEnter = true;
      m.ladderLevel++;
      entrySize = baseSizeUsdc * Math.pow(sizeMultiplier, m.ladderLevel - 1);
    }
  }

  if (!shouldEnter) return;

  const sharesYes = entrySize / m.bestAskYes;
  const sharesNo = entrySize / m.bestAskNo;

  m.totalCostYes += entrySize;
  m.totalSharesYes += sharesYes;
  m.totalCostNo += entrySize;
  m.totalSharesNo += sharesNo;
  m.entryCount++;
  m.lastEntryCombined = currentCombined;

  const metrics = computeMetrics(m);
  const shortSlug = m.slug.substring(0, 30).padEnd(30);
  console.log(
    `  📈 ${shortSlug} L${m.ladderLevel}: comb=${currentCombined.toFixed(4)} avg=${metrics.combined.toFixed(4)} edge=${metrics.edgePct}% ${metrics.profitable ? "✅" : "❌"}`
  );
}

async function main() {
  // Fetch only crypto 15m markets (actively traded)
  const markets = await fetchCrypto15mMarkets();

  if (markets.length === 0) {
    console.log("\nNo markets found.");
    return;
  }

  const tokenToMarket = new Map<string, { market: MarketState; side: "yes" | "no" }>();
  const allTokenIds: string[] = [];

  for (const m of markets) {
    tokenToMarket.set(m.tokenYes, { market: m, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: m, side: "no" });
    allTokenIds.push(m.tokenYes, m.tokenNo);
  }

  console.log(`=== REAL-TIME LADDER ACCUMULATION ===`);
  console.log(`Markets: ${markets.length}, Token IDs: ${allTokenIds.length}`);
  console.log(`Ladder step: ${ladderStep}, Max initial combined: ${maxInitialCombined}`);
  console.log(`Base size: $${baseSizeUsdc}, Multiplier: ${sizeMultiplier}x, Fee: ${fee * 100}%`);
  console.log(`\nConnecting to WebSocket...\n`);

  const startTime = Date.now();

  const client = new RealTimeDataClient({
    onMessage: (_client, message) => {
      const { topic, type, payload } = message as { topic: string; type: string; payload: any };

      if (topic === "clob_market" && type === "agg_orderbook") {
        const assetId = payload?.asset_id as string;
        const entry = tokenToMarket.get(assetId);
        const asks = payload?.asks as { price: string }[] | undefined;

        if (entry && asks?.length) {
          const bestAsk = Math.min(...asks.map((a) => Number(a.price)));
          if (entry.side === "yes") entry.market.bestAskYes = bestAsk;
          else entry.market.bestAskNo = bestAsk;
          entry.market.priceUpdates++;
          tryEntry(entry.market);
        }
      }

      if (topic === "clob_market" && type === "price_change") {
        const priceChanges = (payload?.pc || payload?.price_changes) as { a: string; ba: string; bb: string }[] | undefined;
        if (priceChanges) {
          for (const pc of priceChanges) {
            const assetId = pc.a || (pc as any).asset_id;
            const entry = tokenToMarket.get(assetId);
            if (entry) {
              const bestAsk = Number(pc.ba || (pc as any).best_ask);
              if (bestAsk > 0) {
                if (entry.side === "yes") entry.market.bestAskYes = bestAsk;
                else entry.market.bestAskNo = bestAsk;
                entry.market.priceUpdates++;
                tryEntry(entry.market);
              }
            }
          }
        }
      }
    },
    onConnect: (connectedClient: RealTimeDataClient) => {
      console.log("WebSocket connected. Subscribing to clob_market streams...\n");

      // Single subscription for all tokens (like test-gamma.ts)
      connectedClient.subscribe({
        subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(allTokenIds) }],
      });

      console.log(`Subscribed to ${allTokenIds.length} token IDs\n`);
    },
  });

  client.connect();

  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\n--- ${elapsed.toFixed(0)}s elapsed ---`);

    const profitable = markets.filter((m) => m.entryCount > 0 && computeMetrics(m).profitable);
    const nearProfitable = markets.filter((m) => m.entryCount > 0 && !computeMetrics(m).profitable && computeMetrics(m).edge > -0.01);

    if (profitable.length > 0) {
      console.log(`\n✅ PROFITABLE (${profitable.length}):`);
      for (const m of profitable) {
        const metrics = computeMetrics(m);
        console.log(`  ${m.slug.substring(0, 40)}: L${m.ladderLevel} avg=${metrics.combined.toFixed(4)} edge=${metrics.edgePct}%`);
      }
    }

    if (nearProfitable.length > 0) {
      console.log(`\n🔶 NEAR PROFITABLE (${nearProfitable.length}):`);
      for (const m of nearProfitable) {
        const metrics = computeMetrics(m);
        console.log(`  ${m.slug.substring(0, 40)}: L${m.ladderLevel} avg=${metrics.combined.toFixed(4)} edge=${metrics.edgePct}%`);
      }
    }

    const withEntries = markets.filter((m) => m.entryCount > 0).length;
    const withUpdates = markets.filter((m) => m.priceUpdates > 0).length;
    console.log(`\nMarkets with entries: ${withEntries}/${markets.length}, with updates: ${withUpdates}/${markets.length}`);
  }, 60000);

  // Run indefinitely until terminated (Ctrl+C)
  console.log("Running indefinitely. Press Ctrl+C to stop and see summary.\n");

  process.on("SIGINT", () => {
    console.log("\n\nReceived SIGINT. Stopping...\n");
    clearInterval(progressInterval);
    client.disconnect();
    printSummary(markets);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

function printSummary(markets: MarketState[]) {
  console.log("\n\n========== FINAL SUMMARY ==========\n");

  const sorted = [...markets].filter((m) => m.entryCount > 0).sort((a, b) => computeMetrics(b).edge - computeMetrics(a).edge);
  const profitable = sorted.filter((m) => computeMetrics(m).profitable);

  console.log(`Total markets: ${markets.length}, With entries: ${sorted.length}, Profitable: ${profitable.length}\n`);

  if (profitable.length > 0) {
    console.log("✅ PROFITABLE MARKETS:\n");
    for (const m of profitable) {
      const metrics = computeMetrics(m);
      const minShares = Math.min(m.totalSharesYes, m.totalSharesNo);
      const costPerPair = metrics.avgYes + metrics.avgNo;
      const totalCostForPairs = minShares * costPerPair;
      const grossPayout = minShares;
      const feeOnProfit = minShares * fee * (1 - Math.max(metrics.avgYes, metrics.avgNo));
      const profit = grossPayout - feeOnProfit - totalCostForPairs;
      const profitPct = (profit / totalCostForPairs) * 100;

      console.log(`${m.title}`);
      console.log(`  Slug: ${m.slug}`);
      console.log(`  Entries: ${m.entryCount} (L${m.ladderLevel}), Avg: Yes=${metrics.avgYes.toFixed(4)}, No=${metrics.avgNo.toFixed(4)}`);
      console.log(`  Combined: ${metrics.combined.toFixed(4)}, Edge: ${metrics.edge.toFixed(4)} (${metrics.edgePct}%)`);
      console.log(`  💰 Profit: $${profit.toFixed(2)} (${profitPct.toFixed(2)}% ROI on ${minShares.toFixed(0)} pairs)\n`);
    }
  }

  console.log("Top 10 by edge:\n");
  for (const m of sorted.slice(0, 10)) {
    const metrics = computeMetrics(m);
    console.log(`  ${m.slug.substring(0, 45).padEnd(45)} L${m.ladderLevel} edge=${metrics.edgePct}% ${metrics.profitable ? "✅" : "❌"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
