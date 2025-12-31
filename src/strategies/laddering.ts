/**
 * Laddering strategy (separate from hybrid).
 *
 * - First entry when combined <= MAX_INITIAL_COMBINED.
 * - Subsequent entries when combined has dropped by LADDER_STEP vs last fill.
 * - Size scales by SIZE_MULTIPLIER per ladder level.
 * - Enforces PER_SYMBOL_BUDGET_USDC independently per symbol.
 *
 * Run: bun run src/strategies/laddering.ts
 *
 * Env:
 *   BASE_SIZE_USDC=5
 *   SIZE_MULTIPLIER=1.5
 *   LADDER_STEP=0.01
 *   MAX_INITIAL_COMBINED=1.01
 *   PER_SYMBOL_BUDGET_USDC=100
 *   MAX_MARKETS=100
 */
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import type { MarketState, MarketTracker } from "../core/types";
import { fetchCrypto15mMarkets } from "../core/gamma";
import { clearScreen, formatDuration, getMarketExpiry } from "../core/utils";

const baseSizeUsdc = Number(process.env.BASE_SIZE_USDC) || 5;
const sizeMultiplier = Number(process.env.SIZE_MULTIPLIER) || 1.5;
const ladderStep = Number(process.env.LADDER_STEP) || 0.01;
const maxInitialCombined = Number(process.env.MAX_INITIAL_COMBINED) || 1.01;
const perSymbolBudgetUsdc = Number(process.env.PER_SYMBOL_BUDGET_USDC) || 100;
const maxMarkets = Number(process.env.MAX_MARKETS) || 100;
const minUsdPerLeg = Number(process.env.MIN_USD_PER_LEG ?? "0.1");
const dryRun = (process.env.DRY_RUN ?? "true") !== "false";
const symbolFilter = (process.env.SYMBOL ?? "").toLowerCase();
const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "1");
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet
const fee = 0.02;

const symbolSpend = new Map<string, number>();
// Track actual filled amounts per market (not planned)
const actualFills = new Map<string, { yesShares: number; yesCost: number; noShares: number; noCost: number }>();
// Track if we're waiting for the other side (prevent repeated orders)
const pendingBalance = new Map<string, "yes" | "no" | null>();
// Lock to prevent concurrent order placement per market
const orderLock = new Map<string, boolean>();
let sessionStart = Date.now();
let clobClient: ClobClient | null = null;

function computeMetrics(state: MarketState) {
  const avgYes = state.totalSharesYes > 0 ? state.totalCostYes / state.totalSharesYes : 0;
  const avgNo = state.totalSharesNo > 0 ? state.totalCostNo / state.totalSharesNo : 0;
  const combined = avgYes + avgNo;
  const maxLeg = Math.max(avgYes, avgNo);
  const payout = 1 - fee * (1 - maxLeg);
  const edge = payout - combined;
  return { avgYes, avgNo, combined, edge };
}

async function ensureClient(): Promise<ClobClient | null> {
  if (dryRun) return null;
  if (clobClient) return clobClient;
  if (!privateKey || !funderAddress) {
    console.error("PRIVATE_KEY and FUNDER_ADDRESS required for live orders. Running in dry-run.");
    return null;
  }
  const signer = new Wallet(privateKey);
  const temp = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let creds;
  try {
    creds = await temp.createOrDeriveApiKey();
  } catch {
    // ignore; type-2 flows may still work
  }
  clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);
  return clobClient;
}

async function placeSingleOrder(
  client: ClobClient,
  m: MarketState,
  side: "yes" | "no",
  amountUsd: number
): Promise<{ filled: boolean; filledUsd: number; filledShares: number }> {
  const tokenId = side === "yes" ? m.tokenYes : m.tokenNo;
  const price = side === "yes" ? m.bestAskYes : m.bestAskNo;
  const sideLabel = side.toUpperCase();

  if (amountUsd < minUsdPerLeg) {
    console.log(`[SKIP ${sideLabel}] ${m.slug} $${amountUsd.toFixed(2)} < min=$${minUsdPerLeg}`);
    return { filled: false, filledUsd: 0, filledShares: 0 };
  }

  try {
    const order = await client.createAndPostMarketOrder(
      { tokenID: tokenId, price, amount: amountUsd, side: Side.BUY },
      { slippageBps: 0 } as any,
      OrderType.FAK
    );
    if (order?.success) {
      // makingAmount is what we spent (USDC)
      const costUsd = Number(order.makingAmount || amountUsd);
      const payoutShares = Number(order.takingAmount || 0);
      // shares = payout / 1 (each share pays $1 if wins)
      const filledShares = payoutShares;
      // Calculate actual fill price vs submitted price
      const actualPrice = costUsd / filledShares;
      const slippage = (((actualPrice - price) / price) * 100).toFixed(2);
      console.log(
        `[FILL ${sideLabel}] ${m.slug} cost=$${costUsd.toFixed(2)} shares=${filledShares.toFixed(2)} submitted@${price.toFixed(4)} filled@${actualPrice.toFixed(4)} slippage=${slippage}% orderId=${order.orderID}`
      );
      return { filled: true, filledUsd: costUsd, filledShares };
    }
    console.log(`[NO FILL ${sideLabel}] ${m.slug} - no match at ${price}`);
    return { filled: false, filledUsd: 0, filledShares: 0 };
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || "unknown";
    if (msg.includes("no orders found to match")) {
      console.log(`[NO FILL ${sideLabel}] ${m.slug} - no liquidity at ${price}`);
    } else {
      console.error(`[ERROR ${sideLabel}] ${m.slug}:`, msg);
    }
    return { filled: false, filledUsd: 0, filledShares: 0 };
  }
}

async function balancePosition(m: MarketState): Promise<void> {
  // Prevent concurrent order placement for same market
  if (orderLock.get(m.slug)) return;
  orderLock.set(m.slug, true);

  try {
    await _balancePositionInner(m);
  } finally {
    orderLock.set(m.slug, false);
  }
}

async function _balancePositionInner(m: MarketState): Promise<void> {
  const client = await ensureClient();
  if (!client) return;

  const fills = actualFills.get(m.slug) ?? { yesShares: 0, yesCost: 0, noShares: 0, noCost: 0 };
  const currentSymbolSpend = symbolSpend.get(m.symbol) ?? 0;
  const remainingBudget = perSymbolBudgetUsdc - currentSymbolSpend;

  if (remainingBudget < minUsdPerLeg) {
    return; // Budget exhausted, silent
  }

  // Calculate current avg prices
  const avgYes = fills.yesShares > 0 ? fills.yesCost / fills.yesShares : 0;
  const avgNo = fills.noShares > 0 ? fills.noCost / fills.noShares : 0;

  let side: "yes" | "no";
  let amountUsd: number;

  const pending = pendingBalance.get(m.slug);

  // Allow up to 2 orders on first side before requiring balance (to average down and increase chance of finding opposite)
  const maxFirstSideOrders = 2;
  const firstSideCount =
    fills.yesShares > 0 && fills.noShares === 0
      ? Math.ceil(fills.yesCost / minUsdPerLeg)
      : fills.noShares > 0 && fills.yesShares === 0
        ? Math.ceil(fills.noCost / minUsdPerLeg)
        : 0;

  if (fills.yesShares === 0 && fills.noShares === 0) {
    // First entry - place $1 on YES
    if (pending) return; // Already placed first order, waiting
    side = "yes";
    amountUsd = minUsdPerLeg; // Exactly $1
    pendingBalance.set(m.slug, "yes"); // Mark as pending before placing
  } else if (fills.yesShares > 0 && fills.noShares === 0 && firstSideCount < maxFirstSideOrders) {
    // Can still average down YES before needing NO
    const currentCombined = avgYes + m.bestAskNo;
    // Only add more YES if it would lower our avg (current ask < our avg)
    if (m.bestAskYes < avgYes) {
      side = "yes";
      amountUsd = minUsdPerLeg;
      console.log(`[AVG DOWN] ${m.slug} adding YES to lower avg from ${avgYes.toFixed(4)} (bestAsk=${m.bestAskYes})`);
    } else {
      // Current YES price not better, wait for NO
      const maxNoPrice = 1.0 - avgYes;
      if (m.bestAskNo <= maxNoPrice) {
        side = "no";
        // Match BET AMOUNT (cost), not shares
        const targetNoCost = fills.yesCost;
        amountUsd = Math.min(targetNoCost, remainingBudget);
        if (amountUsd < minUsdPerLeg) amountUsd = minUsdPerLeg;
        console.log(`[BALANCE] ${m.slug} have $${fills.yesCost.toFixed(2)} YES@${avgYes.toFixed(4)}, buying $${amountUsd.toFixed(2)} NO@${m.bestAskNo}`);
      } else {
        if (!pending) {
          console.log(`[WAIT] ${m.slug} YES@${avgYes.toFixed(4)} - need NO<=${maxNoPrice.toFixed(4)} or better YES<${avgYes.toFixed(4)}`);
          pendingBalance.set(m.slug, "no");
        }
        return;
      }
    }
  } else if (fills.yesShares > 0 && fills.noShares === 0) {
    // Have YES, need NO - match BET AMOUNT
    const maxNoPrice = 1.0 - avgYes;
    if (m.bestAskNo <= maxNoPrice) {
      side = "no";
      // Match BET AMOUNT (cost), not shares
      const targetNoCost = fills.yesCost;
      amountUsd = Math.min(targetNoCost, remainingBudget);
      if (amountUsd < minUsdPerLeg) amountUsd = minUsdPerLeg;
      console.log(`[BALANCE] ${m.slug} have $${fills.yesCost.toFixed(2)} YES@${avgYes.toFixed(4)}, buying $${amountUsd.toFixed(2)} NO@${m.bestAskNo}`);
    } else {
      // Only log occasionally to reduce spam
      if (!pending) {
        console.log(`[WAIT NO] ${m.slug} bestAskNo=${m.bestAskNo} > maxNoPrice=${maxNoPrice.toFixed(4)} (need sum<=1)`);
        pendingBalance.set(m.slug, "no");
      }
      return;
    }
  } else if (fills.noShares > 0 && fills.yesShares === 0) {
    // Have NO, need YES - match BET AMOUNT
    const maxYesPrice = 1.0 - avgNo;
    if (m.bestAskYes <= maxYesPrice) {
      side = "yes";
      // Match BET AMOUNT (cost), not shares
      const targetYesCost = fills.noCost;
      amountUsd = Math.min(targetYesCost, remainingBudget);
      if (amountUsd < minUsdPerLeg) amountUsd = minUsdPerLeg;
      console.log(`[BALANCE] ${m.slug} have $${fills.noCost.toFixed(2)} NO@${avgNo.toFixed(4)}, buying $${amountUsd.toFixed(2)} YES@${m.bestAskYes}`);
    } else {
      // Only log occasionally to reduce spam
      if (!pending) {
        console.log(`[WAIT YES] ${m.slug} bestAskYes=${m.bestAskYes} > maxYesPrice=${maxYesPrice.toFixed(4)} (need sum<=1)`);
        pendingBalance.set(m.slug, "yes");
      }
      return;
    }
  } else {
    // Have both sides - check if BET AMOUNTS are balanced and if we can improve
    const currentCombined = avgYes + avgNo;
    const costImbalance = Math.abs(fills.yesCost - fills.noCost);
    const minCost = Math.min(fills.yesCost, fills.noCost);

    // First priority: balance BET AMOUNTS if imbalanced (> 10% difference)
    if (costImbalance > minCost * 0.1) {
      if (fills.yesCost > fills.noCost) {
        // Need more NO $ to balance
        const maxNoPrice = 1.0 - avgYes;
        if (m.bestAskNo <= maxNoPrice) {
          side = "no";
          const neededCost = fills.yesCost - fills.noCost;
          amountUsd = Math.min(neededCost, remainingBudget);
          if (amountUsd < minUsdPerLeg) amountUsd = minUsdPerLeg;
          console.log(
            `[REBALANCE] ${m.slug} YES=$${fills.yesCost.toFixed(2)} NO=$${fills.noCost.toFixed(2)} - adding $${amountUsd.toFixed(2)} NO@${m.bestAskNo}`
          );
        } else {
          if (!pending) {
            console.log(`[WAIT REBAL] ${m.slug} need NO<=${maxNoPrice.toFixed(4)} to rebalance (bestAsk=${m.bestAskNo})`);
            pendingBalance.set(m.slug, "no");
          }
          return;
        }
      } else {
        // Need more YES $ to balance
        const maxYesPrice = 1.0 - avgNo;
        if (m.bestAskYes <= maxYesPrice) {
          side = "yes";
          const neededCost = fills.noCost - fills.yesCost;
          amountUsd = Math.min(neededCost, remainingBudget);
          if (amountUsd < minUsdPerLeg) amountUsd = minUsdPerLeg;
          console.log(
            `[REBALANCE] ${m.slug} YES=$${fills.yesCost.toFixed(2)} NO=$${fills.noCost.toFixed(2)} - adding $${amountUsd.toFixed(2)} YES@${m.bestAskYes}`
          );
        } else {
          if (!pending) {
            console.log(`[WAIT REBAL] ${m.slug} need YES<=${maxYesPrice.toFixed(4)} to rebalance (bestAsk=${m.bestAskYes})`);
            pendingBalance.set(m.slug, "yes");
          }
          return;
        }
      }
    } else if (currentCombined >= 1.0) {
      // Balanced but combined >= 1, need to average down
      const yesImprovement = avgYes - m.bestAskYes;
      const noImprovement = avgNo - m.bestAskNo;
      if (yesImprovement > noImprovement && yesImprovement > 0) {
        side = "yes";
        amountUsd = minUsdPerLeg;
        console.log(`[AVG DOWN] ${m.slug} combined=${currentCombined.toFixed(4)} - adding YES to lower avg`);
      } else if (noImprovement > 0) {
        side = "no";
        amountUsd = minUsdPerLeg;
        console.log(`[AVG DOWN] ${m.slug} combined=${currentCombined.toFixed(4)} - adding NO to lower avg`);
      } else {
        return; // No improvement available
      }
    } else {
      // Combined < 1 and balanced - position is profitable, done for now
      if (!pending) {
        console.log(
          `[DONE] ${m.slug} balanced position: YES=${fills.yesShares.toFixed(2)}@${avgYes.toFixed(4)} NO=${fills.noShares.toFixed(2)}@${avgNo.toFixed(4)} combined=${currentCombined.toFixed(4)}`
        );
        pendingBalance.set(m.slug, "yes"); // Mark as done
      }
      return;
    }
  }

  const result = await placeSingleOrder(client, m, side, amountUsd);

  if (result.filled) {
    if (side === "yes") {
      fills.yesShares += result.filledShares;
      fills.yesCost += result.filledUsd;
    } else {
      fills.noShares += result.filledShares;
      fills.noCost += result.filledUsd;
    }
    actualFills.set(m.slug, fills);
    symbolSpend.set(m.symbol, currentSymbolSpend + result.filledUsd);

    // Update market state with actual fills
    m.totalSharesYes = fills.yesShares;
    m.totalCostYes = fills.yesCost;
    m.totalSharesNo = fills.noShares;
    m.totalCostNo = fills.noCost;
    m.entryCount = Math.min(fills.yesShares, fills.noShares) > 0 ? 1 : 0;

    const newAvgYes = fills.yesShares > 0 ? fills.yesCost / fills.yesShares : 0;
    const newAvgNo = fills.noShares > 0 ? fills.noCost / fills.noShares : 0;
    const minShares = Math.min(fills.yesShares, fills.noShares);
    const avgCombined = newAvgYes + newAvgNo;

    console.log(
      `[POSITION] ${m.slug} YES=${fills.yesShares.toFixed(2)}@${newAvgYes.toFixed(4)} NO=${fills.noShares.toFixed(2)}@${newAvgNo.toFixed(4)} ` +
        `pairs=${minShares.toFixed(2)} avgCombined=${avgCombined.toFixed(4)} spend=$${(currentSymbolSpend + result.filledUsd).toFixed(2)}/${perSymbolBudgetUsdc}`
    );
  }
}

async function tryEntryLadder(m: MarketState): Promise<void> {
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

  const costPerPair = m.bestAskYes + m.bestAskNo;
  if (costPerPair <= 0) return;

  const currentSymbolSpend = symbolSpend.get(m.symbol) ?? 0;
  const remainingBudget = perSymbolBudgetUsdc - currentSymbolSpend;
  if (remainingBudget <= 0) return;

  const sharesToBuy = Math.min(entrySize / costPerPair, remainingBudget / costPerPair);
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

  const metrics = computeMetrics(m);
  console.log(
    `[ENTRY] ${m.slug} L${m.ladderLevel} combined=${currentCombined.toFixed(4)} avg=${metrics.avgYes.toFixed(
      4
    )}/${metrics.avgNo.toFixed(4)} symbolSpend=${(currentSymbolSpend + totalCost).toFixed(2)}/${perSymbolBudgetUsdc}`
  );

  if (!dryRun) {
    try {
      await balancePosition(m);
    } catch (e) {
      console.error("[LIVE ERROR] order placement failed", e);
    }
  }
}

function printSnapshot(markets: MarketTracker[], connected: boolean) {
  // Don't clear screen in smoke test - keep all logs visible
  const elapsed = formatDuration(Date.now() - sessionStart);
  const active = markets.filter((t) => t.market.entryCount > 0).length;
  console.log("=== LADDERING STRATEGY ===");
  console.log(`Session: ${elapsed} | Connected: ${connected ? "🟢" : "🔴"} | Markets: ${markets.length} | Active: ${active}`);
  console.log(`Entry first<=${maxInitialCombined} next drop>=${ladderStep} size x${sizeMultiplier} base=$${baseSizeUsdc} budget/sym=$${perSymbolBudgetUsdc}`);

  const bySymbol = new Map<string, { cost: number; edge: number; entries: number }>();
  for (const t of markets) {
    const m = t.market;
    if (m.entryCount === 0) continue;
    const metrics = computeMetrics(m);
    const minShares = Math.min(m.totalSharesYes, m.totalSharesNo);
    const costPerPair = metrics.avgYes + metrics.avgNo;
    const totalCostForPairs = minShares * costPerPair;
    const entry = bySymbol.get(m.symbol) ?? { cost: 0, edge: 0, entries: 0 };
    entry.cost += totalCostForPairs;
    entry.edge += metrics.edge;
    entry.entries += m.entryCount;
    bySymbol.set(m.symbol, entry);
  }

  if (bySymbol.size > 0) {
    console.log("\nBy symbol (open cost, entries, avg edge):");
    for (const [sym, v] of bySymbol.entries()) {
      const avgEdge = v.entries > 0 ? v.edge / v.entries : 0;
      console.log(`  ${sym.toUpperCase()}: cost ~$${v.cost.toFixed(2)} entries ${v.entries} edge ${avgEdge.toFixed(4)}`);
    }
  }
  console.log("\nPress Ctrl+C to exit.");
}

export async function main() {
  console.log("Fetching markets...");
  let markets = (await fetchCrypto15mMarkets()).slice(0, maxMarkets);
  if (symbolFilter) {
    markets = markets.filter((m) => m.symbol.toLowerCase() === symbolFilter);
    if (markets.length === 0) {
      console.log(`No markets found for symbol ${symbolFilter.toUpperCase()}`);
      return;
    }
    // For smoke test: pick market that expires between 5-15 min (enough time to balance, but still active)
    const now = Date.now();
    const fiveMin = 5 * 60 * 1000;
    const fifteenMin = 15 * 60 * 1000;
    const activeMarkets = markets
      .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug) }))
      .filter((x) => x.expiry > now + fiveMin && x.expiry <= now + fifteenMin)
      .sort((a, b) => a.expiry - b.expiry);

    if (activeMarkets.length > 0) {
      const timeLeft = Math.round((activeMarkets[0].expiry - now) / 60000);
      markets = [activeMarkets[0].market];
      console.log(`Smoke test: using market ${markets[0].slug} (expires in ${timeLeft}min)`);
    } else {
      // Fallback to nearest market with >5min remaining
      const validMarkets = markets
        .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug) }))
        .filter((x) => x.expiry > now + fiveMin)
        .sort((a, b) => a.expiry - b.expiry);
      if (validMarkets.length > 0) {
        const timeLeft = Math.round((validMarkets[0].expiry - now) / 60000);
        markets = [validMarkets[0].market];
        console.log(`Smoke test: using market ${markets[0].slug} (expires in ${timeLeft}min)`);
      } else {
        console.log("No markets with >5min remaining");
        return;
      }
    }
  }
  if (markets.length === 0) {
    console.log("No markets found.");
    return;
  }

  const tokenToMarket = new Map<string, { market: MarketTracker; side: "yes" | "no" }>();
  const allTokens: string[] = [];
  const trackers: MarketTracker[] = [];

  for (const m of markets) {
    const tracker: MarketTracker = { market: m, expiresAt: getMarketExpiry(m.slug) };
    trackers.push(tracker);
    tokenToMarket.set(m.tokenYes, { market: tracker, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: tracker, side: "no" });
    allTokens.push(m.tokenYes, m.tokenNo);
  }

  sessionStart = Date.now();
  let connected = false;

  const client = new RealTimeDataClient({
    autoReconnect: true,
    onMessage: async (_c, message) => {
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
          // For smoke test: directly call balancePosition to place $1 orders
          if (!dryRun && entry.market.market.bestAskYes > 0 && entry.market.market.bestAskNo > 0) {
            await balancePosition(entry.market.market);
          }
        }
      }
    },
    onConnect: (c) => {
      connected = true;
      console.log("Connected. Subscribing...");
      const batchSize = 30;
      for (let i = 0; i < allTokens.length; i += batchSize) {
        c.subscribe({
          subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(allTokens.slice(i, i + batchSize)) }],
        });
      }
    },
    onStatusChange: (s) => {
      if (s === ConnectionStatus.DISCONNECTED || s === ConnectionStatus.CONNECTING) connected = false;
    },
  });

  client.connect();

  // Disable periodic dashboard in smoke test to keep logs visible
  // const snapshotInterval = setInterval(() => printSnapshot(trackers, connected), 10_000);

  process.on("SIGINT", () => {
    client.disconnect();
    process.exit(0);
  });

  await new Promise(() => {});
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
