/**
 * Order placement smoke test.
 *
 * Fetches the nearest active crypto 15m market (default BTC), grabs best ask,
 * and optionally posts a tiny BUY order to exercise wallet + API key plumbing.
 *
 * Run: bun run src/scripts/order-smoke.ts
 *
 * Env:
 *   PRIVATE_KEY      (required) wallet private key
 *   FUNDER_ADDRESS   (required) Polymarket profile address
 *   SIGNATURE_TYPE   optional, default 1 (Magic/Email)
 *   SYMBOL           optional, default "btc"
 *   MAX_USDC         optional, default 5 (budget in USDC for the order)
 *   SIDE             optional, "yes" | "no" (default "yes")
 *   DRY_RUN          optional, default "true" (set to "false" to place order)
 */
import dns from "node:dns";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ConnectionStatus, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { fetchCrypto15mMarkets } from "../core/gamma";
import { getMarketExpiry, formatExpiry } from "../core/utils";
import type { MarketState } from "../core/types";

// Prefer IPv4 to avoid Cloudflare/WAF blocks some users see on IPv6
dns.setDefaultResultOrder("ipv4first");

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "1");
const SYMBOL = (process.env.SYMBOL ?? "btc").toLowerCase();
// Minimal spend per leg (USDC). Platform minimum is typically $1.
const MIN_USD_PER_LEG = Number(process.env.MIN_USD_PER_LEG ?? "1");
const MAX_USDC = Number(process.env.MAX_USDC ?? "5"); // overall cap if you want larger tests
const SIDE_CHOICE = (process.env.SIDE ?? "yes").toLowerCase() as "yes" | "no";
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";
type AggOrderBook = {
  asset_id: string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
};

if (!privateKey) {
  console.error("PRIVATE_KEY env var required");
  process.exit(1);
}
if (!funderAddress) {
  console.error("FUNDER_ADDRESS env var required");
  process.exit(1);
}

type OrderBookLevel = { price: string; size: string };
type OrderBook = {
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tick_size: string;
  neg_risk: boolean;
};

function pickNearestActiveMarket(markets: MarketState[]): MarketState {
  const now = Date.now();
  const filtered = markets
    .filter((m) => m.slug.startsWith(`${SYMBOL}-`))
    .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug, "15m") }))
    .filter((m) => m.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);

  if (!filtered.length) {
    throw new Error(`No active ${SYMBOL.toUpperCase()} 15m market found`);
  }
  return filtered[0].market;
}

async function initClient(): Promise<ClobClient> {
  const signer = new Wallet(privateKey!);
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let creds;
  try {
    // Attempt to derive/reuse API key; some setups (proxy/Safe) may return 400 but still work for order posting.
    creds = await tempClient.createOrDeriveApiKey();
  } catch (err) {
    // Ignore; type 2 flows can still place orders without deriving a new key.
  }
  return new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);
}

function getBestAsk(book: OrderBook): { price: number; size: number } | null {
  if (!book.asks || book.asks.length === 0) return null;
  const sorted = [...book.asks].sort((a, b) => Number(a.price) - Number(b.price));
  const best = sorted[0];
  return { price: Number(best.price), size: Number(best.size) };
}

function getBestBid(book: OrderBook): { price: number; size: number } | null {
  if (!book.bids || book.bids.length === 0) return null;
  const sorted = [...book.bids].sort((a, b) => Number(b.price) - Number(a.price));
  const best = sorted[0];
  return { price: Number(best.price), size: Number(best.size) };
}

async function main(): Promise<void> {
  console.log("=== ORDER SMOKE TEST ===");
  console.log(`Symbol: ${SYMBOL.toUpperCase()}`);
  console.log(`Side: ${SIDE_CHOICE.toUpperCase()}, Budget: $${MAX_USDC}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const markets = await fetchCrypto15mMarkets();
  const market = pickNearestActiveMarket(markets);
  const tokenYes = market.tokenYes;
  const tokenNo = market.tokenNo;

  console.log(`Market: ${market.slug}`);
  console.log(`Expires: ${formatExpiry(getMarketExpiry(market.slug, "15m"))} UTC`);
  console.log(`YES token: ${tokenYes}`);
  console.log(`NO  token: ${tokenNo}\n`);

  const clobClient = await initClient();

  const latestBook = new Map<string, AggOrderBook>();
  let placed = false;
  let lastAttemptMs = 0;

  const ws = new RealTimeDataClient({
    autoReconnect: true,
    onConnect: (c) => {
      c.subscribe({
        subscriptions: [{ topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify([tokenYes, tokenNo]) }],
      });
    },
    onStatusChange: (s) => {
      // keep alive; rely on autoReconnect
    },
    onMessage: async (_c, message) => {
      if (placed) return;
      const { topic, type, payload } = message as { topic: string; type: string; payload: AggOrderBook };
      if (topic !== "clob_market" || type !== "agg_orderbook") return;
      latestBook.set(payload.asset_id, payload);
      const yes = latestBook.get(tokenYes);
      const no = latestBook.get(tokenNo);
      if (!yes || !no) return;
      const bestAskYes = getBestAsk(yes as any);
      const bestAskNo = getBestAsk(no as any);
      if (!bestAskYes || !bestAskNo) return;
      const combinedAsk = bestAskYes.price + bestAskNo.price;
      console.log(
        `Best asks YES ${bestAskYes.price} size ${bestAskYes.size} | NO ${bestAskNo.price} size ${bestAskNo.size} | combined ${combinedAsk.toFixed(4)}`
      );

      // Aim for the minimum per-leg spend (default $1) while respecting MAX_USDC cap.
      const sharesForMin = MIN_USD_PER_LEG / Math.max(bestAskYes.price, bestAskNo.price);
      const sharesForCap = MAX_USDC / combinedAsk;
      const shares = Math.min(sharesForMin, sharesForCap);
      const now = Date.now();
      if (now - lastAttemptMs < 4000) return; // throttle attempts
      lastAttemptMs = now;

      // For smoke test: place $1 on whichever side we can
      const targetUsd = Math.max(MIN_USD_PER_LEG, 1);
      const targetToken = SIDE_CHOICE === "yes" ? tokenYes : tokenNo;
      const targetPrice = SIDE_CHOICE === "yes" ? bestAskYes.price : bestAskNo.price;

      console.log(`Placing $${targetUsd} FAK order on ${SIDE_CHOICE.toUpperCase()} @ ${targetPrice}`);

      if (DRY_RUN) {
        console.log("\nDRY_RUN=true -> not placing order.");
        process.exit(0);
      }

      try {
        const order = await clobClient.createAndPostMarketOrder(
          {
            tokenID: targetToken,
            price: targetPrice,
            amount: targetUsd,
            side: Side.BUY,
          },
          undefined,
          OrderType.FAK
        );

        placed = true;
        console.log("Order response:", order);
        console.log("Done.");
        process.exit(0);
      } catch (e) {
        console.error("Order placement failed:", e);
        process.exit(1);
      }
    },
  });

  console.log("Streaming orderbooks for YES/NO until combined < 1...");
  ws.connect();
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
