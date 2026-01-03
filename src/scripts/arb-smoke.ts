/**
 * Arbitrage smoke test.
 *
 * Monitors BTC 15m markets for opportunities where bestAskYes + bestAskNo < trigger threshold.
 * When found, places BOTH orders simultaneously with slippage buffer for higher fill chance.
 * Auto-switches to next market when current one expires.
 * If only one side fills, immediately sells to exit the position.
 *
 * Run: bun run src/scripts/arb-smoke.ts
 *
 * Env:
 *   PRIVATE_KEY - Wallet private key
 *   FUNDER_ADDRESS - Funder address for type-2 signatures
 *   SIGNATURE_TYPE - 1 or 2 (default 2)
 *   SIZE_USDC - Size per leg in USDC (default 5)
 *   TRIGGER_COMBINED - Combined price to trigger execution (default 0.98)
 *   MAX_COMBINED - Max combined price with slippage for orders (default 0.99)
 *   DRY_RUN - "true" to skip actual orders (default "true")
 */
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import type { MarketState } from "../core/types";
import { fetchCrypto15mMarkets } from "../core/gamma";
import { getMarketExpiry, formatDuration } from "../core/utils";

let maxSizeUsdc = Number(process.env.SIZE_USDC) || 5; // Max size per leg (will be capped by balance)
const minSizeUsdc = Number(process.env.MIN_SIZE_USDC) || 1; // Min size to execute
const triggerCombined = Number(process.env.TRIGGER_COMBINED) || 0.98; // Trigger when sum < this
const maxCombined = Number(process.env.MAX_COMBINED) || 0.99; // Max price with slippage
const slippageBuffer = (maxCombined - triggerCombined) / 2; // Split slippage between both legs
const dryRun = (process.env.DRY_RUN ?? "true") !== "false";
const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "2");
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

let clobClient: ClobClient | null = null;
let executed = false;
let currentMarket: MarketState | null = null;
let marketExpiry = 0;
let rtClient: RealTimeDataClient | null = null;

// Store orderbook depth for liquidity checks
let yesAsks: { price: number; size: number }[] = [];
let noAsks: { price: number; size: number }[] = [];
let yesBids: { price: number; size: number }[] = [];
let noBids: { price: number; size: number }[] = [];

// Pre-fetched market config to avoid API calls at trigger time
let cachedTickSize: string | null = null;
let cachedNegRisk: boolean | null = null;

async function ensureClient(): Promise<ClobClient | null> {
  if (dryRun) return null;
  if (clobClient) return clobClient;
  if (!privateKey || !funderAddress) {
    console.error("PRIVATE_KEY and FUNDER_ADDRESS required for live orders.");
    return null;
  }
  const signer = new Wallet(privateKey);
  const temp = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let creds;
  try {
    creds = await temp.createOrDeriveApiKey();
  } catch {
    // type-2 may still work
  }
  clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);
  return clobClient;
}

async function getUsdcBalance(client: ClobClient): Promise<number> {
  try {
    const result = await client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
    const balance = Number(result?.balance || 0) / 1e6; // Convert from micro-USDC
    return balance;
  } catch (e: any) {
    console.log(`[WARN] Could not fetch USDC balance: ${e?.message}`);
    return 0;
  }
}

function checkLiquidity(asks: { price: number; size: number }[], maxPrice: number, requiredUsdc: number): { sufficient: boolean; available: number } {
  let available = 0;
  for (const ask of asks) {
    if (ask.price <= maxPrice) {
      available += ask.size * ask.price; // size is in shares, convert to USDC
    }
  }
  return { sufficient: available >= requiredUsdc, available };
}

function getBestBid(bids: { price: number; size: number }[]): number {
  if (bids.length === 0) return 0;
  return Math.max(...bids.map((b) => b.price));
}

async function sellPosition(client: ClobClient, tokenId: string, shares: number, bestBid: number, side: string): Promise<void> {
  console.log(`[ROLLBACK] Selling ${shares.toFixed(2)} ${side} shares @ ${bestBid.toFixed(4)}`);

  // Wait for shares to settle before attempting to sell (Polygon block time ~2s)
  const maxRetries = 5;
  const retryDelayMs = 3000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[ROLLBACK] Attempt ${attempt}/${maxRetries}...`);
      const result = await client.createAndPostMarketOrder({ tokenID: tokenId, price: bestBid, amount: shares, side: Side.SELL }, undefined, OrderType.FAK);
      if ((result as any)?.success && (result as any)?.orderID) {
        console.log(`[ROLLBACK SUCCESS] Sold ${side} position, orderId=${(result as any).orderID}`);
        return;
      } else if ((result as any)?.errorMsg) {
        console.log(`[ROLLBACK] Order error: ${(result as any).errorMsg}`);
      }
    } catch (e: any) {
      const errorMsg = e?.response?.data?.error || e?.message;
      console.log(`[ROLLBACK] Attempt ${attempt} failed: ${errorMsg}`);

      // If it's a balance/allowance error, wait and retry (shares may not have settled)
      if (errorMsg?.includes("balance") || errorMsg?.includes("allowance")) {
        if (attempt < maxRetries) {
          console.log(`[ROLLBACK] Waiting ${retryDelayMs}ms for shares to settle...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
      }
    }
  }

  console.log(`[ROLLBACK FAILED] Could not sell ${side} after ${maxRetries} attempts - manual intervention needed!`);
}

async function placeBothOrders(m: MarketState): Promise<boolean> {
  // Calculate order prices with slippage buffer - round to 2 decimals for API compliance
  const yesPriceWithSlippage = Math.round(Math.min(m.bestAskYes + slippageBuffer, 0.99) * 100) / 100;
  const noPriceWithSlippage = Math.round(Math.min(m.bestAskNo + slippageBuffer, 0.99) * 100) / 100;

  // Check liquidity on both sides
  const yesLiq = checkLiquidity(yesAsks, yesPriceWithSlippage, maxSizeUsdc);
  const noLiq = checkLiquidity(noAsks, noPriceWithSlippage, maxSizeUsdc);

  // Use the minimum available liquidity (capped at maxSizeUsdc)
  const effectiveSizeUsdc = Math.min(yesLiq.available, noLiq.available, maxSizeUsdc);

  console.log(`\n[LIQUIDITY CHECK]`);
  console.log(`  YES: $${yesLiq.available.toFixed(2)} available up to ${yesPriceWithSlippage.toFixed(4)}`);
  console.log(`  NO:  $${noLiq.available.toFixed(2)} available up to ${noPriceWithSlippage.toFixed(4)}`);
  console.log(`  Effective size: $${effectiveSizeUsdc.toFixed(2)} (min of both, max $${maxSizeUsdc})`);

  // Check if effective size meets minimum threshold
  if (effectiveSizeUsdc < minSizeUsdc) {
    console.log(`[SKIP] Effective size $${effectiveSizeUsdc.toFixed(2)} < min $${minSizeUsdc}`);
    return false;
  }

  // Calculate shares from effective USDC amount
  // Polymarket API requires: makerAmount (USDC) max 2 decimals, takerAmount (shares) max 4 decimals
  // CRITICAL: shares * price must result in exactly 2 decimal USDC
  //
  // Strategy: Work backwards from clean USDC amount
  // 1. Round target USDC to 2 decimals
  // 2. Calculate shares = USDC / price, ensuring shares * price = exact USDC
  // 3. For this to work, shares must be a multiple that when multiplied by price gives clean result
  //
  // Simplest approach: use integer cents and calculate shares that give exact cents
  const targetCents = Math.floor(effectiveSizeUsdc * 100); // e.g., 500 cents = $5.00

  // For BUY orders: makerAmount = USDC, takerAmount = shares
  // shares = USDC / price
  // To get clean USDC: shares must be such that shares * price has max 2 decimals
  //
  // Since price is already 2 decimals (e.g., 0.78), and we need shares * price = X.XX
  // shares = X.XX / 0.YY = must result in clean multiplication
  //
  // Use floor division to ensure we don't exceed budget
  const yesUsdc = targetCents / 100;
  const noUsdc = targetCents / 100;

  // Calculate shares - round DOWN to 2 decimals to ensure we stay within budget
  // shares = usdc / price, but we need shares * price to be clean
  // So: shares = floor(usdc * 100 / price) / 100
  const yesShares = Math.floor((yesUsdc / yesPriceWithSlippage) * 100) / 100;
  const noShares = Math.floor((noUsdc / noPriceWithSlippage) * 100) / 100;

  // Recalculate actual USDC that will be spent (this is what goes to API as makerAmount)
  // This MUST have max 2 decimals
  const yesActualUsdc = Math.round(yesShares * yesPriceWithSlippage * 100) / 100;
  const noActualUsdc = Math.round(noShares * noPriceWithSlippage * 100) / 100;

  const client = await ensureClient();
  if (!client) {
    console.log(`[DRY RUN] Would place batch order:`);
    console.log(`  YES: ${yesShares.toFixed(2)} shares ($${yesUsdc.toFixed(2)}) @ ${yesPriceWithSlippage.toFixed(2)} (best ask: ${m.bestAskYes.toFixed(4)})`);
    console.log(`  NO:  ${noShares.toFixed(2)} shares ($${noUsdc.toFixed(2)}) @ ${noPriceWithSlippage.toFixed(2)} (best ask: ${m.bestAskNo.toFixed(4)})`);
    console.log(`  Combined with slippage: ${(yesPriceWithSlippage + noPriceWithSlippage).toFixed(2)}`);
    console.log(`  [DEBUG] YES: ${yesShares} * ${yesPriceWithSlippage} = ${yesShares * yesPriceWithSlippage}`);
    console.log(`  [DEBUG] NO:  ${noShares} * ${noPriceWithSlippage} = ${noShares * noPriceWithSlippage}`);
    return true;
  }

  console.log(`[EXECUTING] Creating batch order (both orders in single API call)...`);
  console.log(`  YES: ${yesShares.toFixed(2)} shares ($${yesUsdc.toFixed(2)}) @ ${yesPriceWithSlippage.toFixed(2)}`);
  console.log(`  NO:  ${noShares.toFixed(2)} shares ($${noUsdc.toFixed(2)}) @ ${noPriceWithSlippage.toFixed(2)}`);
  console.log(`  Combined with slippage: ${(yesPriceWithSlippage + noPriceWithSlippage).toFixed(2)}`);
  console.log(`  [DEBUG] YES: ${yesShares} * ${yesPriceWithSlippage} = ${yesShares * yesPriceWithSlippage}`);
  console.log(`  [DEBUG] NO:  ${noShares} * ${noPriceWithSlippage} = ${noShares * noPriceWithSlippage}`);

  try {
    // Step 1: Create both market orders (sign them) in parallel
    // Use createMarketOrder with USDC amount - library handles precision better
    // Pass pre-fetched tickSize and negRisk to skip API calls at trigger time
    const orderOptions = cachedTickSize && cachedNegRisk !== null ? { tickSize: cachedTickSize as any, negRisk: cachedNegRisk } : undefined;

    const createStart = Date.now();
    const [yesOrder, noOrder] = await Promise.all([
      client.createMarketOrder(
        {
          tokenID: m.tokenYes,
          price: yesPriceWithSlippage,
          amount: yesUsdc,
          side: Side.BUY,
        },
        orderOptions
      ),
      client.createMarketOrder(
        {
          tokenID: m.tokenNo,
          price: noPriceWithSlippage,
          amount: noUsdc,
          side: Side.BUY,
        },
        orderOptions
      ),
    ]);

    const createLatency = Date.now() - createStart;
    console.log(`[BATCH] Orders signed in ${createLatency}ms, posting batch...`);
    console.log(`[DEBUG] YES order:`, JSON.stringify(yesOrder, null, 2));
    console.log(`[DEBUG] NO order:`, JSON.stringify(noOrder, null, 2));

    // Step 2: Post both orders in a single batch API call (faster, more atomic)
    const postStart = Date.now();
    const results = await client.postOrders([
      { order: yesOrder, orderType: OrderType.FOK }, // FOK = Fill-Or-Kill for immediate execution
      { order: noOrder, orderType: OrderType.FOK },
    ]);

    const postLatency = Date.now() - postStart;
    console.log(`[LATENCY] Create: ${createLatency}ms, Post: ${postLatency}ms, Total: ${createLatency + postLatency}ms`);
    console.log(`[DEBUG] postOrders raw response:`, JSON.stringify(results, null, 2));

    const yesResult = results[0];
    const noResult = results[1];

    console.log(`[DEBUG] YES result:`, JSON.stringify(yesResult, null, 2));
    console.log(`[DEBUG] NO result:`, JSON.stringify(noResult, null, 2));

    // Check both success flag AND empty errorMsg - API returns success:true even with errors!
    const yesFilled = yesResult?.success === true && !yesResult?.errorMsg && yesResult?.orderID;
    const noFilled = noResult?.success === true && !noResult?.errorMsg && noResult?.orderID;
    const yesFilledShares = yesFilled ? Number(yesResult.takingAmount || 0) : 0;
    const noFilledShares = noFilled ? Number(noResult.takingAmount || 0) : 0;

    if (yesFilled && noFilled) {
      console.log(`[SUCCESS] Both orders filled!`);
      console.log(`  YES: ${yesFilledShares.toFixed(2)} shares, orderId=${yesResult.orderID}`);
      console.log(`  NO:  ${noFilledShares.toFixed(2)} shares, orderId=${noResult.orderID}`);

      // Verify orders via getOrder if we have orderIDs
      if (yesResult.orderID) {
        try {
          const yesOrderDetails = await client.getOrder(yesResult.orderID);
          console.log(`[DEBUG] YES order details:`, JSON.stringify(yesOrderDetails, null, 2));
        } catch (e: any) {
          console.log(`[DEBUG] Could not fetch YES order: ${e?.message}`);
        }
      }
      if (noResult.orderID) {
        try {
          const noOrderDetails = await client.getOrder(noResult.orderID);
          console.log(`[DEBUG] NO order details:`, JSON.stringify(noOrderDetails, null, 2));
        } catch (e: any) {
          console.log(`[DEBUG] Could not fetch NO order: ${e?.message}`);
        }
      }

      return true;
    }

    console.log(`[PARTIAL FILL] YES=${yesFilled ? "FILLED" : "FAILED"} NO=${noFilled ? "FILLED" : "FAILED"}`);
    if (!yesFilled) console.log(`  YES error: ${yesResult?.errorMsg || "unknown"}`);
    if (!noFilled) console.log(`  NO error: ${noResult?.errorMsg || "unknown"}`);

    // ROLLBACK: If only one side filled, sell it immediately
    if (yesFilled && !noFilled && yesFilledShares > 0) {
      const bestBid = getBestBid(yesBids);
      if (bestBid > 0) {
        await sellPosition(client, m.tokenYes, yesFilledShares, bestBid, "YES");
      } else {
        console.log(`[ROLLBACK SKIP] No YES bids available - position stuck!`);
      }
    } else if (noFilled && !yesFilled && noFilledShares > 0) {
      const bestBid = getBestBid(noBids);
      if (bestBid > 0) {
        await sellPosition(client, m.tokenNo, noFilledShares, bestBid, "NO");
      } else {
        console.log(`[ROLLBACK SKIP] No NO bids available - position stuck!`);
      }
    }

    return false;
  } catch (e: any) {
    console.log(`[ERROR] Batch order failed: ${e?.response?.data?.error || e?.message}`);
    return false;
  }
}

async function getBtcMarket(): Promise<MarketState | null> {
  const markets = await fetchCrypto15mMarkets();
  const btcMarkets = markets.filter((m) => m.symbol.toLowerCase() === "btc");

  if (btcMarkets.length === 0) {
    console.log("No BTC markets found");
    return null;
  }

  const now = Date.now();
  const minTimeLeft = 2 * 60 * 1000; // At least 2 min left

  // Sort by expiry, pick the one expiring soonest but with enough time
  const validMarkets = btcMarkets
    .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug) }))
    .filter((x) => x.expiry > now + minTimeLeft)
    .sort((a, b) => a.expiry - b.expiry);

  if (validMarkets.length === 0) {
    console.log("No BTC markets with sufficient time remaining");
    return null;
  }

  return validMarkets[0].market;
}

async function switchToNextMarket(): Promise<boolean> {
  console.log("\n--- Switching to next market ---\n");

  // Disconnect current subscriptions
  if (rtClient) {
    rtClient.disconnect();
    rtClient = null;
  }

  const market = await getBtcMarket();
  if (!market) return false;

  currentMarket = market;
  marketExpiry = getMarketExpiry(market.slug);
  const timeLeft = Math.round((marketExpiry - Date.now()) / 60000);
  console.log(`Using market: ${market.slug} (expires in ${timeLeft}min)`);

  // Pre-fetch tickSize and negRisk to avoid API calls at trigger time
  cachedTickSize = null;
  cachedNegRisk = null;
  if (!dryRun) {
    const client = await ensureClient();
    if (client) {
      try {
        const prefetchStart = Date.now();
        // Fetch tick size from orderbook
        const book = await client.getOrderBook(market.tokenYes);
        cachedTickSize = (book as any)?.tick_size || "0.01";
        cachedNegRisk = (book as any)?.neg_risk ?? true; // crypto markets are neg_risk
        console.log(`[PREFETCH] tickSize=${cachedTickSize}, negRisk=${cachedNegRisk} (${Date.now() - prefetchStart}ms)`);
      } catch (e: any) {
        console.log(`[PREFETCH] Failed: ${e?.message}, will use defaults`);
        cachedTickSize = "0.01";
        cachedNegRisk = true;
      }
    }
  }
  console.log();

  // Start monitoring
  startMonitoring();
  return true;
}

function startMonitoring() {
  if (!currentMarket) return;

  // Reset orderbook data
  yesAsks = [];
  noAsks = [];
  yesBids = [];
  noBids = [];

  const m = currentMarket;
  const allTokens = [m.tokenYes, m.tokenNo];

  rtClient = new RealTimeDataClient({
    autoReconnect: true,
    onMessage: async (_c, message) => {
      if (executed) return;

      const { topic, type, payload } = message as { topic: string; type: string; payload: any };
      if (topic !== "clob_market" || type !== "agg_orderbook") return;

      const assetId = payload?.asset_id as string;
      const asks = payload?.asks as { price: string; size: string }[] | undefined;
      const bids = payload?.bids as { price: string; size: string }[] | undefined;

      // Store full orderbook for liquidity checks
      if (assetId === m.tokenYes) {
        if (asks?.length) {
          yesAsks = asks.map((a) => ({ price: Number(a.price), size: Number(a.size) }));
          m.bestAskYes = Math.min(...yesAsks.map((a) => a.price));
        }
        if (bids?.length) {
          yesBids = bids.map((b) => ({ price: Number(b.price), size: Number(b.size) }));
        }
      } else if (assetId === m.tokenNo) {
        if (asks?.length) {
          noAsks = asks.map((a) => ({ price: Number(a.price), size: Number(a.size) }));
          m.bestAskNo = Math.min(...noAsks.map((a) => a.price));
        }
        if (bids?.length) {
          noBids = bids.map((b) => ({ price: Number(b.price), size: Number(b.size) }));
        }
      }

      // Check if we have both prices
      if (m.bestAskYes <= 0 || m.bestAskNo <= 0) return;

      const combined = m.bestAskYes + m.bestAskNo;

      // Log every update
      const timeLeft = Math.round((marketExpiry - Date.now()) / 1000);
      process.stdout.write(
        `\r[${m.slug}] YES=${m.bestAskYes.toFixed(4)} NO=${m.bestAskNo.toFixed(4)} SUM=${combined.toFixed(4)} (trigger <${triggerCombined}) TTL=${timeLeft}s   `
      );

      // Check for opportunity - trigger at lower threshold
      if (combined < triggerCombined) {
        console.log(`\n\n🎯 OPPORTUNITY FOUND! Combined=${combined.toFixed(4)} < ${triggerCombined}`);
        console.log(`  Will place orders with slippage up to ${maxCombined}`);
        executed = true;

        const success = await placeBothOrders(m);
        if (success) {
          console.log("\n✅ Arbitrage executed successfully!");
          process.exit(0);
        } else {
          console.log("\n❌ Execution failed, continuing to monitor...");
          executed = false;
        }
      }
    },
    onConnect: (c) => {
      console.log("Connected. Subscribing to orderbook...");
      c.subscribe({
        subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(allTokens) }],
      });
    },
    onStatusChange: (s) => {
      if (s === ConnectionStatus.DISCONNECTED) {
        console.log("\nDisconnected, reconnecting...");
      }
    },
  });

  rtClient.connect();
}

async function main() {
  console.log("=== ARBITRAGE SMOKE TEST ===");

  // Fetch USDC balance and cap maxSizeUsdc
  if (!dryRun) {
    const client = await ensureClient();
    if (client) {
      const balance = await getUsdcBalance(client);
      console.log(`USDC Balance: $${balance.toFixed(2)}`);
      // Need 2x size for both legs, so cap at half the balance
      const maxPerLeg = Math.floor((balance / 2) * 100) / 100;
      if (maxPerLeg < maxSizeUsdc) {
        console.log(`Capping max size from $${maxSizeUsdc} to $${maxPerLeg} (half of balance)`);
        maxSizeUsdc = maxPerLeg;
      }
      if (maxSizeUsdc < minSizeUsdc) {
        console.log(`ERROR: Balance too low. Need at least $${minSizeUsdc * 2} for min trade.`);
        process.exit(1);
      }
    }
  }

  console.log(`Size: $${minSizeUsdc}-${maxSizeUsdc} per leg (uses min available liquidity)`);
  console.log(`Trigger: combined < ${triggerCombined}`);
  console.log(`Max with slippage: ${maxCombined} (buffer: +${slippageBuffer.toFixed(4)} per leg)`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Initial market selection
  const success = await switchToNextMarket();
  if (!success) {
    console.log("Failed to find initial market");
    process.exit(1);
  }

  // Check for market expiry and switch
  const expiryCheck = setInterval(async () => {
    if (executed) return;

    const now = Date.now();
    const timeLeft = marketExpiry - now;

    // Switch 1 minute before expiry
    if (timeLeft < 60 * 1000) {
      console.log("\n\n⏰ Market expiring soon, switching...");
      const switched = await switchToNextMarket();
      if (!switched) {
        console.log("No more markets available, waiting 30s...");
        await new Promise((r) => setTimeout(r, 30000));
        await switchToNextMarket();
      }
    }
  }, 10000);

  process.on("SIGINT", () => {
    clearInterval(expiryCheck);
    if (rtClient) rtClient.disconnect();
    console.log("\n\nShutting down...");
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
