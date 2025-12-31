/**
 * Test script for Gamma 15m crypto markets only.
 * Verifies WebSocket streaming is working correctly.
 */

import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import { fetchCrypto15mMarkets } from "./gamma";
import type { MarketState } from "./types";

async function main() {
  const markets = await fetchCrypto15mMarkets();

  if (markets.length === 0) {
    console.log("No crypto 15m markets found.");
    return;
  }

  const tokenToMarket = new Map<string, { market: MarketState; side: "yes" | "no" }>();
  const allTokenIds: string[] = [];

  for (const m of markets) {
    tokenToMarket.set(m.tokenYes, { market: m, side: "yes" });
    tokenToMarket.set(m.tokenNo, { market: m, side: "no" });
    allTokenIds.push(m.tokenYes, m.tokenNo);
  }

  console.log(`\n=== TEST: GAMMA 15M MARKETS STREAMING ===`);
  console.log(`Markets: ${markets.length}, Token IDs: ${allTokenIds.length}`);
  console.log(`\nConnecting to WebSocket...\n`);

  let updateCount = 0;

  const client = new RealTimeDataClient({
    onMessage: (_client, message) => {
      const { topic, type, payload } = message as { topic: string; type: string; payload: any };

      if (topic === "clob_market" && type === "price_change") {
        const priceChanges = (payload?.pc || payload?.price_changes) as any[] | undefined;
        if (priceChanges) {
          for (const pc of priceChanges) {
            const assetId = pc.a || pc.asset_id;
            const entry = tokenToMarket.get(assetId);
            if (entry) {
              const bestAsk = Number(pc.ba || pc.best_ask);
              const bestBid = Number(pc.bb || pc.best_bid);
              updateCount++;
              console.log(
                `[${updateCount}] ${entry.market.slug.substring(0, 25).padEnd(25)} ` +
                  `${entry.side.toUpperCase().padEnd(3)} ask=${bestAsk.toFixed(4)} bid=${bestBid.toFixed(4)}`
              );

              if (entry.side === "yes") entry.market.bestAskYes = bestAsk;
              else entry.market.bestAskNo = bestAsk;
              entry.market.priceUpdates++;
            }
          }
        }
      }
    },
    onConnect: (connectedClient: RealTimeDataClient) => {
      console.log("WebSocket connected!\n");

      // Subscribe to all tokens
      connectedClient.subscribe({
        subscriptions: [{ topic: "clob_market", type: "price_change", filters: JSON.stringify(allTokenIds) }],
      });

      console.log(`Subscribed to ${allTokenIds.length} token IDs\n`);
      console.log("Waiting for price updates...\n");
    },
  });

  client.connect();

  // Print stats every 10 seconds
  setInterval(() => {
    const withUpdates = markets.filter((m) => m.priceUpdates > 0).length;
    console.log(`\n--- Stats: ${updateCount} updates received, ${withUpdates}/${markets.length} markets with updates ---\n`);
  }, 10000);

  // Run indefinitely
  process.on("SIGINT", () => {
    console.log("\n\nStopping...");
    client.disconnect();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
