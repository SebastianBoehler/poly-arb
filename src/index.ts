/**
 * Real-time ladder accumulation using Polymarket WebSocket streams.
 * Fetches ALL neg_risk (binary) markets and streams real-time prices.
 *
 * Usage: bun run index.ts
 *
 * Env vars:
 *   DURATION_SEC=300            How long to run (5 min default)
 *   BASE_SIZE_USDC=5            Base USD per entry
 *   SIZE_MULTIPLIER=1.2         Mild size scale on each reload (optional)
 *   PER_SYMBOL_BUDGET_USDC=100  Max open cost per symbol (caps entries per asset)
 *   MAX_MARKETS=100             Maximum number of markets to track
 *   MAX_INITIAL_COMBINED=0.99   First entry allowed if combined <= this
 *   RELOAD_THRESHOLD=0.995      Subsequent entries allowed if combined <= this
 *   MIN_IMPROVEMENT=0.002       Required improvement vs last fill to reload
 */

import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { MarketState, MarketTracker, ClosedPosition } from "./core/types";
import { fetchCrypto15mMarkets } from "./core/gamma";
import { getMarketExpiry, formatExpiry, formatDuration, clearScreen, formatUSD, formatPercent } from "./core/utils";

const closedPositions: ClosedPosition[] = [];
let totalClosedProfit = 0;
let totalClosedCost = 0;
let sessionStartTime = Date.now();

type SymbolPnL = {
  openCost: number;
  openPnL: number;
  closedPnL: number;
};

function printDashboard(marketTrackers: Map<string, MarketTracker>, earliestExpiry: number, connected: boolean): void {
  clearScreen();

  const now = Date.now();
  const elapsed = now - sessionStartTime;
  const allMarkets = Array.from(marketTrackers.values()).map((t) => t.market);

  // Calculate unrealized PnL
  let totalUnrealizedProfit = 0;
  let totalUnrealizedCost = 0;
  const activePositions = allMarkets.filter((m) => m.entryCount > 0);
  const symbolPnL = new Map<string, SymbolPnL>();

  for (const m of activePositions) {
    const metrics = computeMetrics(m);
    const minShares = Math.min(m.totalSharesYes, m.totalSharesNo);
    const costPerPair = metrics.avgYes + metrics.avgNo;
    const totalCostForPairs = minShares * costPerPair;
    const grossPayout = minShares;
    const feeOnProfit = minShares * fee * (1 - Math.max(metrics.avgYes, metrics.avgNo));
    const profit = grossPayout - feeOnProfit - totalCostForPairs;
    totalUnrealizedProfit += profit;
    totalUnrealizedCost += totalCostForPairs;

    const sym = m.symbol;
    const entry = symbolPnL.get(sym) ?? { openCost: 0, openPnL: 0, closedPnL: 0 };
    entry.openCost += totalCostForPairs;
    entry.openPnL += profit;
    symbolPnL.set(sym, entry);
  }

  const totalPnL = totalClosedProfit + totalUnrealizedProfit;
  const totalCost = totalClosedCost + totalUnrealizedCost;
  const totalROI = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  const profitableCount = closedPositions.filter((p) => p.profitable).length;
  const winRate = closedPositions.length > 0 ? (profitableCount / closedPositions.length) * 100 : 0;

  // Header
  console.clear();
  console.log("╔════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    🚀 POLY-ARB TRADING DASHBOARD                           ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");

  // Session Stats
  console.log(`║  ⏱️  Session: ${formatDuration(elapsed).padEnd(15)} 📡 Status: ${connected ? "🟢 Connected" : "🔴 Disconnected"}`.padEnd(79) + "║");
  console.log(`║  📊 Markets: ${marketTrackers.size.toString().padEnd(5)} 🎯 Active Positions: ${activePositions.length}`.padEnd(79) + "║");
  console.log(`║  ⏰ Next Expiry: ${formatExpiry(earliestExpiry)} UTC`.padEnd(79) + "║");

  // PnL Section
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                              💰 PROFIT & LOSS                              ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");

  const closedPnLStr = formatUSD(totalClosedProfit, true);
  const unrealizedPnLStr = formatUSD(totalUnrealizedProfit, true);
  const totalPnLStr = formatUSD(totalPnL, true);
  const roiStr = formatPercent(totalROI, true);

  console.log(`║  📈 Realized PnL:    ${closedPnLStr.padEnd(12)} (${closedPositions.length} trades)`.padEnd(79) + "║");
  console.log(`║  📊 Unrealized PnL:  ${unrealizedPnLStr.padEnd(12)} (${activePositions.length} positions)`.padEnd(79) + "║");
  console.log(`║  ────────────────────────────────────────────────────────────────────────  ║`);
  console.log(`║  💵 TOTAL PnL:       ${totalPnLStr.padEnd(12)} ROI: ${roiStr}`.padEnd(79) + "║");

  // Win Rate
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  🎯 Win Rate: ${winRate.toFixed(1)}% (${profitableCount}/${closedPositions.length} profitable)`.padEnd(79) + "║");

  // Per-symbol view (top 5 by total PnL)
  const symbolRows = Array.from(symbolPnL.entries()).map(([symbol, v]) => {
    const closedForSymbol = closedPositions.filter((p) => p.symbol === symbol);
    const closedSum = closedForSymbol.reduce((acc, p) => acc + p.profit, 0);
    const closedCost = closedForSymbol.reduce((acc, p) => acc + p.totalCost, 0);
    v.closedPnL += closedSum;
    return { symbol, openCost: v.openCost, openPnL: v.openPnL, closedPnL: v.closedPnL, closedCost };
  });

  if (symbolRows.length > 0) {
    symbolRows.sort((a, b) => b.openPnL + b.closedPnL - (a.openPnL + a.closedPnL));
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                         🪙 PNL BY SYMBOL                                   ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    for (const row of symbolRows.slice(0, 5)) {
      const totalSymPnL = row.openPnL + row.closedPnL;
      const roiSym = row.openCost + row.closedCost > 0 ? (totalSymPnL / (row.openCost + row.closedCost)) * 100 : 0;
      const line = `║  ${row.symbol.toUpperCase().padEnd(6)} openPnL ${formatUSD(row.openPnL, true).padEnd(8)} closed ${formatUSD(row.closedPnL, true).padEnd(8)} ROI ${roiSym.toFixed(1)}%`;
      console.log(line.padEnd(79) + "║");
    }
  }

  // Active Profitable Positions
  const profitableActive = activePositions
    .map((m) => ({ m, metrics: computeMetrics(m) }))
    .filter(({ metrics }) => metrics.profitable)
    .sort((a, b) => parseFloat(b.metrics.edgePct) - parseFloat(a.metrics.edgePct));

  if (profitableActive.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                         ✅ PROFITABLE POSITIONS                            ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    for (const { m, metrics } of profitableActive.slice(0, 5)) {
      const line = `║  ${m.slug.substring(0, 35).padEnd(35)} L${m.ladderLevel} edge=${metrics.edgePct}%`;
      console.log(line.padEnd(79) + "║");
    }
    if (profitableActive.length > 5) {
      console.log(`║  ... and ${profitableActive.length - 5} more`.padEnd(79) + "║");
    }
  }

  // Near Profitable
  const nearProfitable = activePositions
    .map((m) => ({ m, metrics: computeMetrics(m) }))
    .filter(({ metrics }) => !metrics.profitable && metrics.edge > -0.01)
    .sort((a, b) => b.metrics.edge - a.metrics.edge);

  if (nearProfitable.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                         🔶 NEAR PROFITABLE                                 ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    for (const { m, metrics } of nearProfitable.slice(0, 3)) {
      const line = `║  ${m.slug.substring(0, 35).padEnd(35)} L${m.ladderLevel} edge=${metrics.edgePct}%`;
      console.log(line.padEnd(79) + "║");
    }
  }

  // Recent Closed Trades
  if (closedPositions.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                         📜 RECENT CLOSED TRADES                            ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    const recent = closedPositions.slice(-5).reverse();
    for (const p of recent) {
      const icon = p.profit >= 0 ? "✅" : "❌";
      const profitStr = formatUSD(p.profit, true);
      const line = `║  ${icon} ${p.slug.substring(0, 30).padEnd(30)} ${profitStr.padEnd(10)} (${p.profitPct.toFixed(1)}%)`;
      console.log(line.padEnd(79) + "║");
    }
  }

  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log("║  Press Ctrl+C to stop and see full summary                                 ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════╝");
}

const baseSizeUsdc = Number(process.env.BASE_SIZE_USDC) || 5;
const sizeMultiplier = Number(process.env.SIZE_MULTIPLIER) || 1.2;
const perSymbolBudgetUsdc = Number(process.env.PER_SYMBOL_BUDGET_USDC) || 100;
const maxInitialCombined = Number(process.env.MAX_INITIAL_COMBINED) || 0.99;
const reloadThreshold = Number(process.env.RELOAD_THRESHOLD) || 0.995;
const minImprovement = Number(process.env.MIN_IMPROVEMENT) || 0.002;
const fee = 0.02;
const symbolSpend = new Map<string, number>();

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

export function __resetSymbolSpend(): void {
  symbolSpend.clear();
}

export function __setSymbolSpend(symbol: string, value: number): void {
  symbolSpend.set(symbol, value);
}

export function tryEntry(m: MarketState): void {
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
    const improvement = m.lastEntryCombined - currentCombined;
    const meetsThreshold = currentCombined <= reloadThreshold;
    const improvedEnough = improvement >= minImprovement;
    if (meetsThreshold && improvedEnough) {
      shouldEnter = true;
      m.ladderLevel++;
      entrySize = baseSizeUsdc * Math.pow(sizeMultiplier, m.ladderLevel - 1);
    }
  }

  if (!shouldEnter) return;

  // Buy EQUAL shares on both sides (required for arb to cancel out)
  // entrySize is the USD budget; buy shares such that both sides have equal count
  const costPerPair = m.bestAskYes + m.bestAskNo; // cost to buy 1 YES + 1 NO
  if (costPerPair <= 0) return;

  const currentSymbolSpend = symbolSpend.get(m.symbol) ?? 0;
  const remainingBudget = perSymbolBudgetUsdc - currentSymbolSpend;
  if (remainingBudget <= 0) return;

  const sharesToBuy = Math.min(entrySize / costPerPair, remainingBudget / costPerPair); // number of pairs we can afford
  if (sharesToBuy <= 0) return;

  const costYes = sharesToBuy * m.bestAskYes;
  const costNo = sharesToBuy * m.bestAskNo;
  const totalCost = costYes + costNo;

  m.totalCostYes += costYes;
  m.totalSharesYes += sharesToBuy;
  m.totalCostNo += costNo;
  m.totalSharesNo += sharesToBuy;
  m.entryCount++;
  m.lastEntryCombined = currentCombined;
  symbolSpend.set(m.symbol, currentSymbolSpend + totalCost);

  // Dashboard will show updated positions
}

async function main() {
  // Fetch only crypto 15m markets (actively traded)
  const markets = await fetchCrypto15mMarkets();

  if (markets.length === 0) {
    console.log("\nNo markets found.");
    return;
  }

  const tokenToMarket = new Map<string, { market: MarketTracker; side: "yes" | "no" }>();
  const allTokenIds = new Set<string>();
  const marketTrackers = new Map<string, MarketTracker>();

  for (const m of markets) {
    const tracker: MarketTracker = {
      market: m,
      expiresAt: getMarketExpiry(m.slug),
    };
    tokenToMarket.set(m.tokenYes, { market: tracker, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: tracker, side: "no" });
    allTokenIds.add(m.tokenYes);
    allTokenIds.add(m.tokenNo);
    marketTrackers.set(m.slug, tracker);
  }

  let earliestExpiry = Math.min(...Array.from(marketTrackers.values()).map((t) => t.expiresAt));

  console.log(`=== REAL-TIME LADDER ACCUMULATION ===`);
  console.log(`Markets: ${marketTrackers.size}, Token IDs: ${allTokenIds.size}`);
  console.log(`Earliest expiry: ${formatExpiry(earliestExpiry)} UTC`);
  console.log(`Entry: first <= ${maxInitialCombined}, reload <= ${reloadThreshold}, min improve ${minImprovement}`);
  console.log(`Base size: $${baseSizeUsdc}, Multiplier: ${sizeMultiplier}x, Fee: ${fee * 100}%`);
  console.log(`\nConnecting to WebSocket...\n`);

  sessionStartTime = Date.now();
  let connected = false;
  let activeClient: RealTimeDataClient | null = null;
  let progressInterval: ReturnType<typeof setInterval> | undefined;

  const startProgressInterval = () => {
    if (!progressInterval) {
      progressInterval = setInterval(() => {
        printDashboard(marketTrackers, earliestExpiry, connected);
      }, 10000); // Update every 10 seconds
    }
  };

  const stopProgressInterval = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = undefined;
    }
  };

  const client = new RealTimeDataClient({
    autoReconnect: true,
    onMessage: (_client, message) => {
      if (!connected) return;
      const { topic, type, payload } = message as { topic: string; type: string; payload: any };

      if (topic === "clob_market" && type === "agg_orderbook") {
        const assetId = payload?.asset_id as string;
        const entry = tokenToMarket.get(assetId);
        const asks = payload?.asks as { price: string }[] | undefined;

        if (entry && asks?.length) {
          const bestAsk = Math.min(...asks.map((a) => Number(a.price)));
          if (entry.side === "yes") entry.market.market.bestAskYes = bestAsk;
          else entry.market.market.bestAskNo = bestAsk;
          entry.market.market.priceUpdates++;
          tryEntry(entry.market.market);
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
                if (entry.side === "yes") entry.market.market.bestAskYes = bestAsk;
                else entry.market.market.bestAskNo = bestAsk;
                entry.market.market.priceUpdates++;
                tryEntry(entry.market.market);
              }
            }
          }
        }
      }
    },
    onConnect: (connectedClient: RealTimeDataClient) => {
      connected = true;
      activeClient = connectedClient;
      startProgressInterval();
      console.log("WebSocket connected. Subscribing to clob_market streams...\n");

      // Subscribe in batches
      const tokenArray = Array.from(allTokenIds);
      const batchSize = 30;
      for (let i = 0; i < tokenArray.length; i += batchSize) {
        const batch = tokenArray.slice(i, i + batchSize);
        connectedClient.subscribe({
          subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(batch) }],
        });
      }

      console.log(`Subscribed to ${allTokenIds.size} token IDs\n`);
    },
    onStatusChange: (status: ConnectionStatus) => {
      if (status === ConnectionStatus.DISCONNECTED) {
        connected = false;
        stopProgressInterval();
      }
      if (status === ConnectionStatus.CONNECTING) {
        connected = false;
      }
    },
  });

  client.connect();

  // Market refresh: check every 30s for expired markets
  const refreshInterval = setInterval(async () => {
    const now = Date.now();
    if (earliestExpiry > now + 10000) return; // not yet expired

    // Remove expired markets and calculate closed PnL
    const expiredTokens: string[] = [];
    for (const [slug, tracker] of marketTrackers.entries()) {
      if (tracker.expiresAt < now) {
        const m = tracker.market;

        // Calculate and store closed PnL if there were entries
        if (m.entryCount > 0) {
          const metrics = computeMetrics(m);
          const minShares = Math.min(m.totalSharesYes, m.totalSharesNo);
          const costPerPair = metrics.avgYes + metrics.avgNo;
          const totalCostForPairs = minShares * costPerPair;
          const grossPayout = minShares;
          const feeOnProfit = minShares * fee * (1 - Math.max(metrics.avgYes, metrics.avgNo));
          const profit = grossPayout - feeOnProfit - totalCostForPairs;
          const profitPct = totalCostForPairs > 0 ? (profit / totalCostForPairs) * 100 : 0;

          const closedPos: ClosedPosition = {
            slug: m.slug,
            title: m.title,
            symbol: m.symbol,
            closedAt: new Date(),
            entryCount: m.entryCount,
            ladderLevel: m.ladderLevel,
            avgYes: metrics.avgYes,
            avgNo: metrics.avgNo,
            combined: metrics.combined,
            edge: metrics.edge,
            edgePct: metrics.edgePct,
            profitable: metrics.profitable,
            shares: minShares,
            totalCost: totalCostForPairs,
            profit,
            profitPct,
          };
          closedPositions.push(closedPos);
          totalClosedProfit += profit;
          totalClosedCost += totalCostForPairs;
        }

        expiredTokens.push(m.tokenYes, m.tokenNo);
        tokenToMarket.delete(m.tokenYes);
        tokenToMarket.delete(m.tokenNo);
        allTokenIds.delete(m.tokenYes);
        allTokenIds.delete(m.tokenNo);
        marketTrackers.delete(slug);
      }
    }

    if (expiredTokens.length > 0) {
      // Dashboard will show updated stats
    }

    // Fetch new markets
    const newMarkets = await fetchCrypto15mMarkets();
    const newTokens: string[] = [];
    for (const m of newMarkets) {
      if (!marketTrackers.has(m.slug)) {
        const tracker: MarketTracker = {
          market: m,
          expiresAt: getMarketExpiry(m.slug),
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

    // Subscribe to new tokens
    if (newTokens.length > 0 && connected && activeClient) {
      activeClient.subscribe({
        subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(newTokens) }],
      });
    }

    // Update earliest expiry
    if (marketTrackers.size > 0) {
      earliestExpiry = Math.min(...Array.from(marketTrackers.values()).map((t) => t.expiresAt));
    }
  }, 30 * 1000);

  // Run indefinitely until terminated (Ctrl+C)
  console.log("Running indefinitely. Press Ctrl+C to stop and see summary.\n");

  process.on("SIGINT", () => {
    console.log("\n\nReceived SIGINT. Stopping...\n");
    clearInterval(progressInterval);
    clearInterval(refreshInterval);
    client.disconnect();
    const allMarkets = Array.from(marketTrackers.values()).map((t) => t.market);
    printSummary(allMarkets);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

function printSummary(markets: MarketState[]) {
  console.log("\n\n========== FINAL SUMMARY ==========\n");

  // Closed positions summary
  if (closedPositions.length > 0) {
    const profitableClosed = closedPositions.filter((p) => p.profitable);
    console.log(`📊 CLOSED POSITIONS: ${closedPositions.length} total, ${profitableClosed.length} profitable`);
    console.log(`💰 Total Closed PnL: $${totalClosedProfit.toFixed(2)}\n`);

    console.log("Closed positions detail:");
    for (const p of closedPositions) {
      const icon = p.profit >= 0 ? "✅" : "❌";
      console.log(`  ${icon} ${p.slug.substring(0, 40).padEnd(40)} L${p.ladderLevel} profit=$${p.profit.toFixed(2)} (${p.profitPct.toFixed(2)}%)`);
    }
    console.log("");
  }

  // Active positions summary
  const sorted = [...markets].filter((m) => m.entryCount > 0).sort((a, b) => computeMetrics(b).edge - computeMetrics(a).edge);
  const profitable = sorted.filter((m) => computeMetrics(m).profitable);

  console.log(`Active markets: ${markets.length}, With entries: ${sorted.length}, Profitable: ${profitable.length}\n`);

  // Calculate unrealized PnL for active positions
  let totalUnrealizedProfit = 0;
  for (const m of sorted) {
    const metrics = computeMetrics(m);
    const minShares = Math.min(m.totalSharesYes, m.totalSharesNo);
    const costPerPair = metrics.avgYes + metrics.avgNo;
    const totalCostForPairs = minShares * costPerPair;
    const grossPayout = minShares;
    const feeOnProfit = minShares * fee * (1 - Math.max(metrics.avgYes, metrics.avgNo));
    const profit = grossPayout - feeOnProfit - totalCostForPairs;
    totalUnrealizedProfit += profit;
  }

  if (sorted.length > 0) {
    console.log(`📈 Unrealized PnL (active): $${totalUnrealizedProfit.toFixed(2)}`);
    console.log(`💵 Total PnL (closed + unrealized): $${(totalClosedProfit + totalUnrealizedProfit).toFixed(2)}\n`);
  }

  if (profitable.length > 0) {
    console.log("✅ PROFITABLE ACTIVE MARKETS:\n");
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

  console.log("Top 10 active by edge:\n");
  for (const m of sorted.slice(0, 10)) {
    const metrics = computeMetrics(m);
    console.log(`  ${m.slug.substring(0, 45).padEnd(45)} L${m.ladderLevel} edge=${metrics.edgePct}% ${metrics.profitable ? "✅" : "❌"}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
