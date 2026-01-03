/**
 * Order history and PnL calculator.
 *
 * Fetches all trades for your account and calculates PnL.
 *
 * Run: bun run src/scripts/history-smoke.ts
 *
 * Env:
 *   PRIVATE_KEY      (required) wallet private key
 *   FUNDER_ADDRESS   (required) Polymarket profile address
 *   SIGNATURE_TYPE   optional, default 1 (Magic/Email)
 */
import dns from "node:dns";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";

// Prefer IPv4 to avoid Cloudflare/WAF blocks some users see on IPv6
dns.setDefaultResultOrder("ipv4first");

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "1");

if (!privateKey) {
  console.error("PRIVATE_KEY env var required");
  process.exit(1);
}
if (!funderAddress) {
  console.error("FUNDER_ADDRESS env var required");
  process.exit(1);
}

interface Trade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side: "TAKER" | "MAKER";
  type: string;
}

async function main() {
  console.log("Initializing CLOB client...");
  const wallet = new Wallet(privateKey!);

  // First create client without API key to derive it
  let clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, undefined, signatureType, funderAddress);

  // Derive API creds
  let apiCreds: any;
  try {
    apiCreds = await clobClient.createOrDeriveApiKey();
  } catch (e: any) {
    // Ignore "Could not create api key" - try to derive instead
    try {
      apiCreds = await clobClient.deriveApiKey();
    } catch (e2: any) {
      console.error("Could not get API credentials:", e2?.response?.data || e2?.message);
    }
  }

  // Recreate client with API creds if we got them
  if (apiCreds) {
    clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, apiCreds, signatureType, funderAddress);
  }

  console.log("\nFetching trades for address:", funderAddress);
  console.log("Wallet address:", wallet.address);

  // Fetch trades where we are the maker
  let allTrades: Trade[] = [];
  let nextCursor: string | undefined;

  do {
    const params: any = {
      maker_address: funderAddress,
    };
    if (nextCursor) {
      params.cursor = nextCursor;
    }

    const response = await clobClient.getTrades(params);
    const trades = (response as any)?.data || response || [];
    if (Array.isArray(trades)) {
      allTrades = allTrades.concat(trades);
    }
    nextCursor = (response as any)?.next_cursor;
  } while (nextCursor);

  console.log(`\nFound ${allTrades.length} trades\n`);

  if (allTrades.length === 0) {
    console.log("No trades found. Try checking with taker_address instead.");
    return;
  }

  // Group trades by market
  const byMarket = new Map<string, Trade[]>();
  for (const trade of allTrades) {
    const key = trade.market || trade.asset_id;
    if (!byMarket.has(key)) {
      byMarket.set(key, []);
    }
    byMarket.get(key)!.push(trade);
  }

  // Calculate PnL per market
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  console.log("=".repeat(80));
  console.log("TRADE HISTORY (sorted by time)");
  console.log("=".repeat(80));

  // Sort all trades by time
  allTrades.sort((a, b) => {
    const timeA = parseInt(a.match_time) || 0;
    const timeB = parseInt(b.match_time) || 0;
    return timeB - timeA; // newest first
  });

  // Show recent trades with status
  console.log("\nRecent trades (newest first):");
  console.log("-".repeat(80));
  for (const trade of allTrades.slice(0, 20)) {
    const size = parseFloat(trade.size);
    const price = parseFloat(trade.price);
    const cost = size * price;
    const side = trade.side;
    const time = new Date(parseInt(trade.match_time) * 1000).toLocaleString();
    const outcome = trade.outcome || "?";
    const status = (trade as any).status || "?";

    console.log(`${time} | ${side.padEnd(4)} | ${size.toFixed(2)} @ $${price.toFixed(2)} = $${cost.toFixed(2)} | ${outcome} | ${status}`);
  }

  // Show the $150 trade raw data
  console.log("\nLooking for $150 trade details...");
  for (const trade of allTrades) {
    const size = parseFloat(trade.size);
    const price = parseFloat(trade.price);
    const cost = size * price;
    if (cost > 100) {
      console.log("RAW $150 trade:", JSON.stringify(trade, null, 2));
    }
  }

  // Calculate totals - only count trades where WE are the taker (our actual orders)
  const largeTrades: { cost: number; size: number; price: number; side: string; outcome: string }[] = [];
  for (const trade of allTrades) {
    // Skip trades where we were the maker (counterparty) - we only want our actual orders
    if ((trade as any).trader_side === "MAKER") {
      // For maker trades, find our matched amount in maker_orders
      const makerOrders = (trade as any).maker_orders || [];
      for (const mo of makerOrders) {
        if (mo.maker_address === funderAddress) {
          const size = parseFloat(mo.matched_amount);
          const price = parseFloat(mo.price);
          const cost = size * price;
          if (mo.side === "BUY") {
            totalBuyCost += cost;
          } else {
            totalSellProceeds += cost;
          }
          if (cost > 5) {
            largeTrades.push({ cost, size, price, side: mo.side, outcome: mo.outcome || "?" });
          }
        }
      }
      continue;
    }

    // For taker trades, use the full trade amount
    const size = parseFloat(trade.size);
    const price = parseFloat(trade.price);
    const cost = size * price;

    if (trade.side === "BUY") {
      totalBuyCost += cost;
    } else {
      totalSellProceeds += cost;
    }

    if (cost > 5) {
      largeTrades.push({ cost, size, price, side: trade.side, outcome: trade.outcome || "?" });
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("LARGE TRADES (>$5)");
  console.log("=".repeat(80));
  for (const t of largeTrades) {
    console.log(`${t.side.padEnd(4)} | ${t.size.toFixed(2)} shares @ $${t.price.toFixed(2)} = $${t.cost.toFixed(2)} | ${t.outcome}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total trades: ${allTrades.length}`);
  console.log(`Total bought: $${totalBuyCost.toFixed(2)}`);
  console.log(`Total sold: $${totalSellProceeds.toFixed(2)}`);
  console.log(`Net position cost: $${(totalBuyCost - totalSellProceeds).toFixed(2)}`);
  console.log("\nNote: This doesn't include redemptions from resolved markets.");
  console.log("Check Polymarket UI for actual PnL including payouts.");

  // Also try to get open orders
  console.log("\n" + "=".repeat(80));
  console.log("OPEN ORDERS");
  console.log("=".repeat(80));

  try {
    const openOrders = await clobClient.getOpenOrders();
    if (Array.isArray(openOrders) && openOrders.length > 0) {
      for (const order of openOrders) {
        console.log(`  ${(order as any).asset_id} | ${(order as any).side} | ${(order as any).size} @ ${(order as any).price}`);
      }
    } else {
      console.log("  No open orders");
    }
  } catch (e: any) {
    console.log("  Could not fetch open orders:", e?.message);
  }
}

main().catch(console.error);
