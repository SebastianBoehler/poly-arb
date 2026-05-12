/**
 * Market Making Strategy for Polymarket.
 *
 * Scans for binary markets with moderate spreads (2-20%) and decent volume,
 * places GTC limit orders on both YES and NO sides inside the spread,
 * and manages inventory by cancelling stale orders and rotating markets.
 *
 * Usage: bun run src/strategies/market-maker.ts
 *
 * Env:
 *   MM_SIZE_USDC=50            USDC per side per market
 *   MM_MAX_MARKETS=10          Max simultaneous markets to make
 *   MM_MIN_SPREAD_PCT=2        Min spread % to consider
 *   MM_MAX_SPREAD_PCT=20       Max spread % to consider
 *   MM_MIN_VOLUME=200          Min volume to consider
 *   MM_SPREAD_CAPTURE=0.4      Fraction of spread to capture (0.3-0.5)
 *   MM_REFRESH_INTERVAL_MS=60000  How often to refresh market list
 *   MM_ORDER_REFRESH_MS=30000  How often to refresh/replace orders
 *   MM_MAX_INVENTORY=500       Max USDC inventory on one side before hedging
 *   DRY_RUN=true               Simulate trades without executing
 *   PRIVATE_KEY=0x...          Wallet private key (required for live)
 *   FUNDER_ADDRESS=0x...       Gnosis Safe address (optional)
 */

import "dotenv/config";
import { fetchAllPolymarketMarkets, enrichWithClobPrices, fetchOrderbook, type NormalizedMarket, type OrderbookSnapshot } from "../services/market-data";
import { formatUSD } from "../core/utils";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN !== "false";
const MM_SIZE_USDC = Number(process.env.MM_SIZE_USDC ?? "50");
const MM_MAX_MARKETS = Number(process.env.MM_MAX_MARKETS ?? "10");
const MM_MIN_SPREAD_PCT = Number(process.env.MM_MIN_SPREAD_PCT ?? "2");
const MM_MAX_SPREAD_PCT = Number(process.env.MM_MAX_SPREAD_PCT ?? "20");
const MM_MIN_VOLUME = Number(process.env.MM_MIN_VOLUME ?? "200");
const MM_SPREAD_CAPTURE = Number(process.env.MM_SPREAD_CAPTURE ?? "0.4");
const MM_REFRESH_INTERVAL_MS = Number(process.env.MM_REFRESH_INTERVAL_MS ?? "60000");
const MM_ORDER_REFRESH_MS = Number(process.env.MM_ORDER_REFRESH_MS ?? "30000");
const MM_MAX_INVENTORY = Number(process.env.MM_MAX_INVENTORY ?? "500");
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "5");

// ─── Types ───────────────────────────────────────────────────────────────────

interface ManagedMarket {
  market: NormalizedMarket;
  yesOrderId: string | null;
  noOrderId: string | null;
  yesBidPrice: number;
  noBidPrice: number;
  yesInventory: number; // shares held
  noInventory: number;
  yesUsdcSpent: number;
  noUsdcSpent: number;
  roundTrips: number;
  grossProfit: number;
  lastRefresh: number;
}

interface MMStats {
  totalRoundTrips: number;
  grossProfit: number;
  inventoryLoss: number;
  marketsActive: number;
  ordersPlaced: number;
  ordersFilled: number;
  startTime: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

const managedMarkets = new Map<string, ManagedMarket>();
const stats: MMStats = {
  totalRoundTrips: 0,
  grossProfit: 0,
  inventoryLoss: 0,
  marketsActive: 0,
  ordersPlaced: 0,
  ordersFilled: 0,
  startTime: Date.now(),
};

let clobClient: any = null;
let Side: any = null;

// ─── CLOB Client ─────────────────────────────────────────────────────────────

async function initClobClient(): Promise<void> {
  if (DRY_RUN) {
    console.log("[MM] DRY RUN mode — no CLOB client needed");
    return;
  }

  const { ClobClient } = await import("@polymarket/clob-client");
  const { Wallet } = await import("@ethersproject/wallet");
  Side = (await import("@polymarket/clob-client")).Side;

  const privateKey = process.env.PRIVATE_KEY;
  const funderAddress = process.env.FUNDER_ADDRESS;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY required for live trading");
  }

  const signer = new Wallet(privateKey);
  const sigType = Number(process.env.SIGNATURE_TYPE ?? "2");
  const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
  const creds = await tempClient.createOrDeriveApiKey();

  clobClient = new ClobClient("https://clob.polymarket.com", 137, signer, creds, sigType, funderAddress);

  console.log("[MM] CLOB client initialized for live trading");
}

// ─── Market Selection ────────────────────────────────────────────────────────

function scoreMarket(m: NormalizedMarket): number {
  const spreadPct = m.spread * 100;
  if (spreadPct < MM_MIN_SPREAD_PCT || spreadPct > MM_MAX_SPREAD_PCT) return 0;
  if (m.volume < MM_MIN_VOLUME) return 0;
  if (!m.tokenYes || !m.tokenNo) return 0;
  if (m.platform !== "polymarket") return 0;

  // Prefer: moderate spread × decent volume × liquidity
  const spreadScore = Math.min(spreadPct / 10, 1); // 0-1, peaks at 10%
  const volScore = Math.min(m.volume / 5000, 1); // 0-1, peaks at $5K
  const liqScore = Math.min(m.liquidity / 1000, 1); // 0-1, peaks at $1K

  // Penalize extreme prices (one side near 0 or 1 = likely resolved soon)
  const priceBalance = 1 - Math.abs(m.yesPrice - 0.5) * 2; // 1 at 0.50, 0 at 0/1

  // Time to expiry bonus: prefer markets expiring in 1-24h
  let tteScore = 0.5;
  if (m.endDate) {
    const tteHours = (new Date(m.endDate).getTime() - Date.now()) / 3600000;
    if (tteHours > 1 && tteHours < 24) tteScore = 1.0;
    else if (tteHours > 0.25 && tteHours <= 1) tteScore = 0.8;
    else if (tteHours >= 24 && tteHours < 72) tteScore = 0.6;
    else tteScore = 0.3;
  }

  return spreadScore * 0.3 + volScore * 0.25 + liqScore * 0.2 + priceBalance * 0.15 + tteScore * 0.1;
}

async function selectMarkets(): Promise<NormalizedMarket[]> {
  console.log("[MM] Scanning for MM candidates...");
  let markets = await fetchAllPolymarketMarkets(MAX_PAGES);
  markets = await enrichWithClobPrices(markets, 15, 150);

  const scored = markets
    .map((m) => ({ market: m, score: scoreMarket(m) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = scored.slice(0, MM_MAX_MARKETS).map((s) => s.market);

  console.log(`[MM] Found ${scored.length} candidates, selected top ${selected.length}:`);
  for (const m of selected) {
    const spreadPct = m.spread * 100;
    console.log(`  ${m.category.padEnd(15)} | spread=${spreadPct.toFixed(1)}% | vol=${formatUSD(m.volume)} | ${m.title.slice(0, 50)}`);
  }

  return selected;
}

// ─── Order Pricing ───────────────────────────────────────────────────────────

function computeBidPrices(
  yesBook: OrderbookSnapshot | null,
  noBook: OrderbookSnapshot | null,
  market: NormalizedMarket,
): { yesBid: number; noBid: number } | null {
  const bestAskYes = yesBook?.bestAsk ?? market.yesPrice;
  const bestAskNo = noBook?.bestAsk ?? market.noPrice;
  const bestBidYes = yesBook?.bestBid ?? 0;
  const bestBidNo = noBook?.bestBid ?? 0;

  if (bestAskYes <= 0 || bestAskNo <= 0) return null;

  // Place bids inside the spread: between best bid and best ask
  // Capture MM_SPREAD_CAPTURE fraction of the bid-ask spread
  const yesSpread = bestAskYes - bestBidYes;
  const noSpread = bestAskNo - bestBidNo;

  // Our bid = bestBid + (spread * capture_fraction)
  // This places us ahead of existing bids but below the ask
  let yesBid = bestBidYes + yesSpread * MM_SPREAD_CAPTURE;
  let noBid = bestBidNo + noSpread * MM_SPREAD_CAPTURE;

  // Round to tick size (0.01)
  yesBid = Math.round(yesBid * 100) / 100;
  noBid = Math.round(noBid * 100) / 100;

  // Sanity: bids must be > 0.01 and < best ask
  yesBid = Math.max(0.01, Math.min(yesBid, bestAskYes - 0.01));
  noBid = Math.max(0.01, Math.min(noBid, bestAskNo - 0.01));

  // Check combined cost: our bids should sum to < 1.00 for positive EV
  // If yesBid + noBid >= 1.00, we'd lose money on a round-trip
  if (yesBid + noBid >= 0.99) {
    // Reduce both proportionally
    const scale = 0.98 / (yesBid + noBid);
    yesBid = Math.round(yesBid * scale * 100) / 100;
    noBid = Math.round(noBid * scale * 100) / 100;
  }

  return { yesBid, noBid };
}

// ─── Order Management ────────────────────────────────────────────────────────

async function placeOrder(tokenId: string, price: number, size: number, side: "BUY" | "SELL"): Promise<{ orderId: string; success: boolean }> {
  stats.ordersPlaced++;

  if (DRY_RUN) {
    const fakeId = `dry-${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return { orderId: fakeId, success: true };
  }

  try {
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price,
      size,
      side: side === "BUY" ? Side.BUY : Side.SELL,
    });

    const result = await clobClient.postOrder(order, "GTC");
    if (result.success) {
      return { orderId: result.orderID, success: true };
    }
    return { orderId: "", success: false };
  } catch (err: any) {
    console.error(`[MM] Order error: ${err.message}`);
    return { orderId: "", success: false };
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  if (DRY_RUN || !orderId || orderId.startsWith("dry-")) return;

  try {
    await clobClient.cancelOrder(orderId);
  } catch {
    // Order may already be filled or cancelled
  }
}

async function checkOrderFilled(orderId: string): Promise<boolean> {
  if (DRY_RUN) return false; // In dry run, simulate fills probabilistically in the main loop

  try {
    const order = await clobClient.getOrder(orderId);
    return order?.status === "FILLED" || order?.status === "MATCHED";
  } catch {
    return false;
  }
}

// ─── Market Management ───────────────────────────────────────────────────────

async function refreshMarketOrders(managed: ManagedMarket): Promise<void> {
  const m = managed.market;

  // Fetch fresh orderbooks
  const [yesBook, noBook] = await Promise.all([m.tokenYes ? fetchOrderbook(m.tokenYes) : null, m.tokenNo ? fetchOrderbook(m.tokenNo) : null]);

  const prices = computeBidPrices(yesBook, noBook, m);
  if (!prices) {
    console.log(`  [${m.title.slice(0, 30)}] No valid prices, skipping`);
    return;
  }

  // Check if existing orders are filled
  if (managed.yesOrderId) {
    const filled = await checkOrderFilled(managed.yesOrderId);
    if (filled) {
      const shares = MM_SIZE_USDC / managed.yesBidPrice;
      managed.yesInventory += shares;
      managed.yesUsdcSpent += MM_SIZE_USDC;
      stats.ordersFilled++;
      console.log(`  ✅ YES filled @ ${managed.yesBidPrice.toFixed(2)} | ${shares.toFixed(1)} shares | ${m.title.slice(0, 40)}`);
      managed.yesOrderId = null;
    }
  }

  if (managed.noOrderId) {
    const filled = await checkOrderFilled(managed.noOrderId);
    if (filled) {
      const shares = MM_SIZE_USDC / managed.noBidPrice;
      managed.noInventory += shares;
      managed.noUsdcSpent += MM_SIZE_USDC;
      stats.ordersFilled++;
      console.log(`  ✅ NO filled @ ${managed.noBidPrice.toFixed(2)} | ${shares.toFixed(1)} shares | ${m.title.slice(0, 40)}`);
      managed.noOrderId = null;
    }
  }

  // Check for round-trip completion (both sides filled)
  if (managed.yesInventory > 0 && managed.noInventory > 0) {
    const rtShares = Math.min(managed.yesInventory, managed.noInventory);
    const yesAvgPrice = managed.yesUsdcSpent / managed.yesInventory;
    const noAvgPrice = managed.noUsdcSpent / managed.noInventory;
    const combinedCost = yesAvgPrice + noAvgPrice;
    const profit = (1.0 - combinedCost) * rtShares;

    managed.yesInventory -= rtShares;
    managed.noInventory -= rtShares;
    managed.roundTrips++;
    managed.grossProfit += profit;
    stats.totalRoundTrips++;
    stats.grossProfit += profit;

    console.log(`  🔄 ROUND-TRIP: ${rtShares.toFixed(1)} shares | cost=${combinedCost.toFixed(3)} | profit=${formatUSD(profit)} | ${m.title.slice(0, 40)}`);
  }

  // Cancel stale orders and place new ones at updated prices
  if (managed.yesOrderId && Math.abs(prices.yesBid - managed.yesBidPrice) > 0.01) {
    await cancelOrder(managed.yesOrderId);
    managed.yesOrderId = null;
  }
  if (managed.noOrderId && Math.abs(prices.noBid - managed.noBidPrice) > 0.01) {
    await cancelOrder(managed.noOrderId);
    managed.noOrderId = null;
  }

  // Place YES bid if not active and inventory not too high
  if (!managed.yesOrderId && managed.yesUsdcSpent < MM_MAX_INVENTORY) {
    const shares = MM_SIZE_USDC / prices.yesBid;
    const result = await placeOrder(m.tokenYes!, prices.yesBid, shares, "BUY");
    if (result.success) {
      managed.yesOrderId = result.orderId;
      managed.yesBidPrice = prices.yesBid;
    }
  }

  // Place NO bid if not active and inventory not too high
  if (!managed.noOrderId && managed.noUsdcSpent < MM_MAX_INVENTORY) {
    const shares = MM_SIZE_USDC / prices.noBid;
    const result = await placeOrder(m.tokenNo!, prices.noBid, shares, "BUY");
    if (result.success) {
      managed.noOrderId = result.orderId;
      managed.noBidPrice = prices.noBid;
    }
  }

  managed.lastRefresh = Date.now();
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function printDashboard(): void {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const hours = elapsed / 3600;

  console.log("\n" + "═".repeat(70));
  console.log("  MARKET MAKER DASHBOARD");
  console.log("═".repeat(70));
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "🔴 LIVE"}`);
  console.log(`  Uptime: ${(elapsed / 60).toFixed(1)} min`);
  console.log(`  Active markets: ${managedMarkets.size}`);
  console.log(`  Orders placed: ${stats.ordersPlaced} | Filled: ${stats.ordersFilled}`);
  console.log(`  Round-trips: ${stats.totalRoundTrips}`);
  console.log(`  Gross profit: ${formatUSD(stats.grossProfit)}`);
  if (hours > 0) {
    console.log(`  Profit/hour: ${formatUSD(stats.grossProfit / hours)}`);
    console.log(`  Projected daily: ${formatUSD((stats.grossProfit / hours) * 24)}`);
  }
  console.log();

  // Per-market breakdown
  const hdr = "  " + "Market".padEnd(35) + " |  RT | Profit   | YesInv  | NoInv   | YesBid | NoBid";
  console.log(hdr);
  console.log("  " + "-".repeat(95));
  for (const [, mm] of managedMarkets) {
    const title = mm.market.title.slice(0, 33).padEnd(35);
    const rt = mm.roundTrips.toString().padStart(3);
    const profit = formatUSD(mm.grossProfit).padStart(8);
    const yInv = formatUSD(mm.yesUsdcSpent).padStart(7);
    const nInv = formatUSD(mm.noUsdcSpent).padStart(7);
    const yBid = mm.yesBidPrice.toFixed(2).padStart(6);
    const nBid = mm.noBidPrice.toFixed(2).padStart(6);
    console.log(`  ${title} | ${rt} | ${profit} | ${yInv} | ${nInv} | ${yBid} | ${nBid}`);
  }
  console.log("═".repeat(70) + "\n");
}

// ─── Dry Run Simulation ──────────────────────────────────────────────────────

function simulateFills(): void {
  // In dry run, probabilistically simulate order fills based on spread
  for (const [, mm] of managedMarkets) {
    const spreadPct = mm.market.spread * 100;
    // Wider spread = lower fill probability per tick
    // ~5% spread → ~20% fill chance per refresh, ~10% spread → ~10%
    const fillProb = Math.min(0.3, 2 / spreadPct);

    if (mm.yesOrderId && Math.random() < fillProb) {
      const shares = MM_SIZE_USDC / mm.yesBidPrice;
      mm.yesInventory += shares;
      mm.yesUsdcSpent += MM_SIZE_USDC;
      stats.ordersFilled++;
      console.log(`  [SIM] YES filled @ ${mm.yesBidPrice.toFixed(2)} | ${mm.market.title.slice(0, 40)}`);
      mm.yesOrderId = null;
    }

    if (mm.noOrderId && Math.random() < fillProb) {
      const shares = MM_SIZE_USDC / mm.noBidPrice;
      mm.noInventory += shares;
      mm.noUsdcSpent += MM_SIZE_USDC;
      stats.ordersFilled++;
      console.log(`  [SIM] NO filled @ ${mm.noBidPrice.toFixed(2)} | ${mm.market.title.slice(0, 40)}`);
      mm.noOrderId = null;
    }

    // Check round-trip
    if (mm.yesInventory > 0 && mm.noInventory > 0) {
      const rtShares = Math.min(mm.yesInventory, mm.noInventory);
      const yesAvg = mm.yesUsdcSpent / (mm.yesInventory + rtShares); // approx
      const noAvg = mm.noUsdcSpent / (mm.noInventory + rtShares);
      const combinedCost = mm.yesBidPrice + mm.noBidPrice;
      const profit = (1.0 - combinedCost) * rtShares;

      mm.yesInventory -= rtShares;
      mm.noInventory -= rtShares;
      mm.roundTrips++;
      mm.grossProfit += profit;
      stats.totalRoundTrips++;
      stats.grossProfit += profit;

      console.log(
        `  [SIM] 🔄 RT: ${rtShares.toFixed(0)} shares | cost=${combinedCost.toFixed(3)} | profit=${formatUSD(profit)} | ${mm.market.title.slice(0, 40)}`,
      );
    }
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== POLYMARKET MARKET MAKER ===\n");
  console.log(`  Size per side: ${formatUSD(MM_SIZE_USDC)}`);
  console.log(`  Max markets: ${MM_MAX_MARKETS}`);
  console.log(`  Spread range: ${MM_MIN_SPREAD_PCT}-${MM_MAX_SPREAD_PCT}%`);
  console.log(`  Spread capture: ${(MM_SPREAD_CAPTURE * 100).toFixed(0)}%`);
  console.log(`  Min volume: ${formatUSD(MM_MIN_VOLUME)}`);
  console.log(`  Max inventory: ${formatUSD(MM_MAX_INVENTORY)}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (simulated fills)" : "🔴 LIVE TRADING"}`);
  console.log();

  await initClobClient();

  // Initial market selection
  const markets = await selectMarkets();
  for (const m of markets) {
    managedMarkets.set(m.id, {
      market: m,
      yesOrderId: null,
      noOrderId: null,
      yesBidPrice: 0,
      noBidPrice: 0,
      yesInventory: 0,
      noInventory: 0,
      yesUsdcSpent: 0,
      noUsdcSpent: 0,
      roundTrips: 0,
      grossProfit: 0,
      lastRefresh: 0,
    });
  }

  let lastMarketRefresh = Date.now();
  let tick = 0;

  const loop = async () => {
    tick++;

    // Refresh market list periodically
    if (Date.now() - lastMarketRefresh > MM_REFRESH_INTERVAL_MS) {
      console.log("\n[MM] Refreshing market list...");
      const newMarkets = await selectMarkets();

      // Remove markets no longer selected
      const newIds = new Set(newMarkets.map((m) => m.id));
      for (const [id, mm] of managedMarkets) {
        if (!newIds.has(id)) {
          // Cancel outstanding orders
          if (mm.yesOrderId) await cancelOrder(mm.yesOrderId);
          if (mm.noOrderId) await cancelOrder(mm.noOrderId);
          managedMarkets.delete(id);
          console.log(`  Removed: ${mm.market.title.slice(0, 50)}`);
        }
      }

      // Add new markets
      for (const m of newMarkets) {
        if (!managedMarkets.has(m.id)) {
          managedMarkets.set(m.id, {
            market: m,
            yesOrderId: null,
            noOrderId: null,
            yesBidPrice: 0,
            noBidPrice: 0,
            yesInventory: 0,
            noInventory: 0,
            yesUsdcSpent: 0,
            noUsdcSpent: 0,
            roundTrips: 0,
            grossProfit: 0,
            lastRefresh: 0,
          });
          console.log(`  Added: ${m.title.slice(0, 50)}`);
        }
      }

      lastMarketRefresh = Date.now();
    }

    // Refresh orders for each managed market
    for (const [, mm] of managedMarkets) {
      if (Date.now() - mm.lastRefresh < MM_ORDER_REFRESH_MS) continue;

      try {
        await refreshMarketOrders(mm);
      } catch (err: any) {
        console.error(`[MM] Error refreshing ${mm.market.title.slice(0, 30)}: ${err.message}`);
      }

      // Small delay between markets to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    // Simulate fills in dry run
    if (DRY_RUN) {
      simulateFills();
    }

    // Dashboard every 5 ticks
    if (tick % 5 === 0) {
      printDashboard();
    }

    stats.marketsActive = managedMarkets.size;
  };

  // Run loop
  console.log("\n[MM] Starting market making loop...\n");
  await loop(); // Initial run

  const intervalId = setInterval(async () => {
    try {
      await loop();
    } catch (err: any) {
      console.error(`[MM] Loop error: ${err.message}`);
    }
  }, MM_ORDER_REFRESH_MS);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[MM] Shutting down...");
    clearInterval(intervalId);

    // Cancel all outstanding orders
    for (const [, mm] of managedMarkets) {
      if (mm.yesOrderId) await cancelOrder(mm.yesOrderId);
      if (mm.noOrderId) await cancelOrder(mm.noOrderId);
    }

    printDashboard();
    console.log("[MM] All orders cancelled. Goodbye.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[MM] Fatal error:", err);
  process.exit(1);
});
