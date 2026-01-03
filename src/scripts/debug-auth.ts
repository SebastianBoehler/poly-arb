/**
 * Debug script to log L1 auth headers and order signing details.
 * Compares with C++ implementation.
 */
import dns from "node:dns";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, Side } from "@polymarket/clob-client";

dns.setDefaultResultOrder("ipv4first");

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "2");

if (!privateKey) {
  console.error("PRIVATE_KEY required");
  process.exit(1);
}

async function main() {
  console.log("=== DEBUG AUTH COMPARISON ===\n");

  const signer = new Wallet(privateKey!);
  console.log("Private Key:", privateKey);
  console.log("Derived Address:", signer.address);
  console.log("Funder Address:", funderAddress);
  console.log("Signature Type:", signatureType);
  console.log("");

  // Create client without creds first to see L1 auth
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);

  console.log("=== L1 AUTH (createOrDeriveApiKey) ===");
  let creds: any;
  try {
    creds = await tempClient.createOrDeriveApiKey();
    console.log("API Credentials derived:");
    console.log("  apiKey:", creds.apiKey);
    console.log("  secret:", creds.secret?.substring(0, 20) + "...");
    console.log("  passphrase:", creds.passphrase);
  } catch (err: any) {
    console.log("createOrDeriveApiKey error:", err?.response?.data || err?.message);
    // Try deriveApiKey separately
    try {
      creds = await tempClient.deriveApiKey();
      console.log("deriveApiKey succeeded:");
      console.log("  apiKey:", creds.apiKey);
    } catch (err2: any) {
      console.log("deriveApiKey also failed:", err2?.response?.data || err2?.message);
    }
  }
  console.log("");

  // Create full client
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);

  console.log("=== ORDER SIGNING TEST ===");
  // Use a fixed token ID for comparison
  const testTokenId = "1234567890";
  const testPrice = 0.5;
  const testSize = 10;

  try {
    // Create order to see the signed output
    const order = await client.createOrder({
      tokenID: testTokenId,
      price: testPrice,
      size: testSize,
      side: Side.BUY,
    });

    console.log("Signed Order:");
    console.log(JSON.stringify(order, null, 2));
  } catch (err: any) {
    console.log("Order creation error:", err?.message);
  }

  console.log("\n=== REAL ORDER TEST ===");
  // Fetch a real market (use same logic as arb-smoke.ts)
  const { fetchCrypto15mMarkets } = await import("../core/gamma");
  const { getMarketExpiry } = await import("../core/utils");
  const markets = await fetchCrypto15mMarkets();
  const btcMarkets = markets.filter((m) => m.slug.startsWith("btc-"));
  if (btcMarkets.length === 0) {
    console.log("No BTC markets found");
    return;
  }

  // Find market with at least 2 min left, pick soonest expiring
  const now = Date.now();
  const minTimeLeft = 2 * 60 * 1000;
  const validMarkets = btcMarkets
    .map((m) => ({ market: m, expiry: getMarketExpiry(m.slug) }))
    .filter((x) => x.expiry > now + minTimeLeft)
    .sort((a, b) => a.expiry - b.expiry);

  if (validMarkets.length === 0) {
    console.log("No BTC markets with sufficient time remaining");
    return;
  }

  const market = validMarkets[0].market;
  const timeLeft = Math.round((validMarkets[0].expiry - now) / 60000);
  console.log("Market:", market.slug);
  console.log("YES token:", market.tokenYes);

  // Get orderbook
  const book = await client.getOrderBook(market.tokenYes);
  const bestAsk = book.asks?.[0];
  console.log("Best ask:", bestAsk);

  if (bestAsk) {
    const price = Number(bestAsk.price);
    const amount = 1; // $1

    console.log("\nCreating $1 market order...");
    console.log("Token ID:", market.tokenYes);
    console.log("Price:", price);
    console.log("Amount:", amount);

    try {
      const marketOrder = await client.createMarketOrder({
        tokenID: market.tokenYes,
        price: price,
        amount: amount,
        side: Side.BUY,
      });
      console.log("\n=== MARKET ORDER DETAILS (for C++ comparison) ===");
      console.log("salt:", marketOrder.salt);
      console.log("maker:", marketOrder.maker);
      console.log("signer:", marketOrder.signer);
      console.log("taker:", marketOrder.taker);
      console.log("tokenId:", marketOrder.tokenId);
      console.log("makerAmount:", marketOrder.makerAmount);
      console.log("takerAmount:", marketOrder.takerAmount);
      console.log("expiration:", marketOrder.expiration);
      console.log("nonce:", marketOrder.nonce);
      console.log("feeRateBps:", marketOrder.feeRateBps);
      console.log("side:", marketOrder.side);
      console.log("signatureType:", marketOrder.signatureType);
      console.log("signature:", marketOrder.signature);
      console.log("=== END ORDER DETAILS ===\n");

      // Print the exact JSON being sent
      const orderPayload = {
        deferExec: false,
        order: {
          salt: parseInt(marketOrder.salt, 10),
          maker: marketOrder.maker,
          signer: marketOrder.signer,
          taker: marketOrder.taker,
          tokenId: marketOrder.tokenId,
          makerAmount: marketOrder.makerAmount,
          takerAmount: marketOrder.takerAmount,
          side: "BUY",
          expiration: marketOrder.expiration,
          nonce: marketOrder.nonce,
          feeRateBps: marketOrder.feeRateBps,
          signatureType: marketOrder.signatureType,
          signature: marketOrder.signature,
        },
        owner: "9b1bbd10-037e-681d-aab4-1c422c39ec05",
        orderType: "FAK",
      };
      console.log("=== EXACT JSON PAYLOAD ===");
      console.log(JSON.stringify(orderPayload, null, 2));
      console.log("=== END JSON PAYLOAD ===\n");

      // Post it
      console.log("\nPosting order...");
      const result = await client.postOrder(marketOrder, "FAK" as any);
      console.log("Post Result:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.log("Order error:", err?.response?.data || err?.message);
    }
  }
}

main().catch(console.error);
