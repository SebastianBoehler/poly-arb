/**
 * Trading script: streams orderbook for crypto 15m markets and places/cancels
 * limit orders at the best ask when combined < 1 (edge exists).
 *
 * Run: bun run trading.ts
 *
 * Env:
 *  - PRIVATE_KEY: Wallet private key (required)
 *  - FUNDER_ADDRESS: Polymarket profile address (required)
 *  - SIGNATURE_TYPE: 0 = EOA (Metamask etc), 1 = Magic/Email, 2 = Gnosis Safe (default: 1)
 *  - MAX_ORDER_USDC: Max USDC per order (default: 10)
 *  - DRY_RUN: Set to "false" to actually place orders (default: true)
 *  - POLL_INTERVAL_MS: How often to check orderbook (default: 2000)
 */
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { fetchCrypto15mMarkets } from "./gamma";
import type { MarketState } from "./types";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "1");
const maxOrderUsdc = Number(process.env.MAX_ORDER_USDC ?? "10");
const dryRun = (process.env.DRY_RUN ?? "true") !== "false";
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "2000");

interface ActiveOrder {
  orderId: string;
  tokenId: string;
  price: number;
  size: number;
  side: "yes" | "no";
}

const activeOrders = new Map<string, ActiveOrder>(); // tokenId -> order

if (!privateKey) {
  console.error("PRIVATE_KEY env var required");
  process.exit(1);
}
if (!funderAddress) {
  console.error("FUNDER_ADDRESS env var required");
  process.exit(1);
}

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBook {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tick_size: string;
  neg_risk: boolean;
}

async function initClient(): Promise<ClobClient> {
  const signer = new Wallet(privateKey!);
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();
  return new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);
}

function getBestAsk(book: OrderBook): { price: number; size: number } | null {
  if (!book.asks || book.asks.length === 0) return null;
  // asks sorted ascending by price; best ask = lowest price
  const sorted = [...book.asks].sort((a, b) => Number(a.price) - Number(b.price));
  const best = sorted[0];
  return { price: Number(best.price), size: Number(best.size) };
}

function getBestBid(book: OrderBook): { price: number; size: number } | null {
  if (!book.bids || book.bids.length === 0) return null;
  // bids sorted descending by price; best bid = highest price
  const sorted = [...book.bids].sort((a, b) => Number(b.price) - Number(a.price));
  const best = sorted[0];
  return { price: Number(best.price), size: Number(best.size) };
}

async function cancelOrder(client: ClobClient, orderId: string): Promise<boolean> {
  try {
    await client.cancelOrder({ orderID: orderId });
    return true;
  } catch (err) {
    console.log(`  Failed to cancel order ${orderId}: ${err}`);
    return false;
  }
}

async function processMarket(client: ClobClient, market: MarketState, bookYes: OrderBook, bookNo: OrderBook): Promise<void> {
  const bestAskYes = getBestAsk(bookYes);
  const bestAskNo = getBestAsk(bookNo);

  const existingYes = activeOrders.get(market.tokenYes);
  const existingNo = activeOrders.get(market.tokenNo);

  // Check if we have edge
  if (!bestAskYes || !bestAskNo) {
    // No orderbook data - cancel any existing orders
    if (existingYes) {
      console.log(`  [${market.slug}] No YES asks, canceling order`);
      if (!dryRun) await cancelOrder(client, existingYes.orderId);
      activeOrders.delete(market.tokenYes);
    }
    if (existingNo) {
      console.log(`  [${market.slug}] No NO asks, canceling order`);
      if (!dryRun) await cancelOrder(client, existingNo.orderId);
      activeOrders.delete(market.tokenNo);
    }
    return;
  }

  const combined = bestAskYes.price + bestAskNo.price;

  // No edge - cancel existing orders
  if (combined >= 1) {
    if (existingYes) {
      console.log(`  [${market.slug}] Edge gone (combined=${combined.toFixed(4)}), canceling YES order`);
      if (!dryRun) await cancelOrder(client, existingYes.orderId);
      activeOrders.delete(market.tokenYes);
    }
    if (existingNo) {
      console.log(`  [${market.slug}] Edge gone (combined=${combined.toFixed(4)}), canceling NO order`);
      if (!dryRun) await cancelOrder(client, existingNo.orderId);
      activeOrders.delete(market.tokenNo);
    }
    return;
  }

  // We have edge - check if price moved
  const edge = 1 - combined;

  // Check if YES order needs update
  if (existingYes && existingYes.price !== bestAskYes.price) {
    console.log(`  [${market.slug}] YES price moved ${existingYes.price} -> ${bestAskYes.price}, canceling`);
    if (!dryRun) await cancelOrder(client, existingYes.orderId);
    activeOrders.delete(market.tokenYes);
  }

  // Check if NO order needs update
  if (existingNo && existingNo.price !== bestAskNo.price) {
    console.log(`  [${market.slug}] NO price moved ${existingNo.price} -> ${bestAskNo.price}, canceling`);
    if (!dryRun) await cancelOrder(client, existingNo.orderId);
    activeOrders.delete(market.tokenNo);
  }

  // Place new orders if needed
  const yesSize = Math.min(bestAskYes.size, maxOrderUsdc / bestAskYes.price);
  const noSize = Math.min(bestAskNo.size, maxOrderUsdc / bestAskNo.price);
  const orderSize = Math.floor(Math.min(yesSize, noSize));

  if (orderSize < 1) return;

  // Place YES order if not active
  if (!activeOrders.has(market.tokenYes)) {
    console.log(`  [${market.slug}] Edge ${(edge * 100).toFixed(2)}% - placing YES @ ${bestAskYes.price} x ${orderSize}`);
    if (dryRun) {
      console.log(`  [DRY RUN] Would place BUY YES @ ${bestAskYes.price} x ${orderSize}`);
    } else {
      try {
        const yesOrder = await client.createAndPostOrder(
          {
            tokenID: market.tokenYes,
            price: bestAskYes.price,
            size: orderSize,
            side: Side.BUY,
          },
          { tickSize: bookYes.tick_size as any, negRisk: bookYes.neg_risk },
          OrderType.GTC
        );
        if (yesOrder.orderID) {
          activeOrders.set(market.tokenYes, {
            orderId: yesOrder.orderID,
            tokenId: market.tokenYes,
            price: bestAskYes.price,
            size: orderSize,
            side: "yes",
          });
          console.log(`  YES order placed: ${yesOrder.orderID}`);
        }
      } catch (err) {
        console.log(`  YES order failed: ${err}`);
      }
    }
  }

  // Place NO order if not active
  if (!activeOrders.has(market.tokenNo)) {
    console.log(`  [${market.slug}] Edge ${(edge * 100).toFixed(2)}% - placing NO @ ${bestAskNo.price} x ${orderSize}`);
    if (dryRun) {
      console.log(`  [DRY RUN] Would place BUY NO @ ${bestAskNo.price} x ${orderSize}`);
    } else {
      try {
        const noOrder = await client.createAndPostOrder(
          {
            tokenID: market.tokenNo,
            price: bestAskNo.price,
            size: orderSize,
            side: Side.BUY,
          },
          { tickSize: bookNo.tick_size as any, negRisk: bookNo.neg_risk },
          OrderType.GTC
        );
        if (noOrder.orderID) {
          activeOrders.set(market.tokenNo, {
            orderId: noOrder.orderID,
            tokenId: market.tokenNo,
            price: bestAskNo.price,
            size: orderSize,
            side: "no",
          });
          console.log(`  NO order placed: ${noOrder.orderID}`);
        }
      } catch (err) {
        console.log(`  NO order failed: ${err}`);
      }
    }
  }
}

async function main() {
  console.log("=== TRADING SCRIPT ===");
  console.log(`Dry run: ${dryRun}`);
  console.log(`Max order USDC: $${maxOrderUsdc}`);
  console.log(`Poll interval: ${pollIntervalMs}ms`);
  console.log("");

  const markets = await fetchCrypto15mMarkets();
  if (markets.length === 0) {
    console.log("No markets found.");
    return;
  }

  console.log(`Found ${markets.length} markets. Initializing CLOB client...\n`);

  const client = await initClient();
  console.log("CLOB client initialized.\n");

  // Polling loop
  const poll = async () => {
    for (const market of markets) {
      try {
        const bookYes = (await client.getOrderBook(market.tokenYes)) as OrderBook;
        const bookNo = (await client.getOrderBook(market.tokenNo)) as OrderBook;
        await processMarket(client, market, bookYes, bookNo);
      } catch (err) {
        console.log(`  [${market.slug}] Failed to fetch orderbook: ${err}`);
      }
    }
  };

  // Initial poll
  await poll();

  // Set up interval
  const interval = setInterval(poll, pollIntervalMs);

  // Graceful shutdown - cancel all orders
  process.on("SIGINT", async () => {
    console.log("\nShutting down, canceling all active orders...");
    clearInterval(interval);
    for (const [tokenId, order] of activeOrders) {
      console.log(`  Canceling ${order.side} order ${order.orderId}`);
      if (!dryRun) await cancelOrder(client, order.orderId);
    }
    activeOrders.clear();
    console.log("Done.");
    process.exit(0);
  });

  console.log("Running... Press Ctrl+C to stop.\n");
  await new Promise(() => {}); // Keep alive
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
