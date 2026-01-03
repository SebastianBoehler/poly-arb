/**
 * Order Placement Benchmark - TypeScript
 *
 * Benchmarks raw order placement latency (sign + post) for $1 orders.
 * Uses pre-cached neg_risk and tickSize to match C++ optimized path.
 *
 * Run: bun run src/scripts/order-benchmark.ts
 *
 * Env:
 *   PRIVATE_KEY - Wallet private key
 *   FUNDER_ADDRESS - Funder address for type-2 signatures
 *   SIGNATURE_TYPE - 1 or 2 (default 2)
 *   NUM_ORDERS - Number of orders to benchmark (default 5)
 */
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const privateKey = process.env.PRIVATE_KEY;
const funderAddress = process.env.FUNDER_ADDRESS;
const signatureType = Number(process.env.SIGNATURE_TYPE ?? "2");
const numOrders = Number(process.env.NUM_ORDERS ?? "5");
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

interface BenchmarkResult {
  iteration: number;
  signMs: number;
  postMs: number;
  totalMs: number;
  success: boolean;
  errorMsg?: string;
}

async function main() {
  console.log("=== TypeScript Order Placement Benchmark ===\n");

  if (!privateKey || !funderAddress) {
    console.error("PRIVATE_KEY and FUNDER_ADDRESS required");
    process.exit(1);
  }

  // Initialize client
  const signer = new Wallet(privateKey);
  const temp = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  let creds;
  try {
    creds = await temp.createOrDeriveApiKey();
  } catch {
    // type-2 may still work
  }
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funderAddress);

  console.log(`Signer: ${signer.address}`);
  console.log(`Funder: ${funderAddress}`);
  console.log(`Orders to benchmark: ${numOrders}\n`);

  // Find active BTC 15m market
  console.log("Finding active BTC 15m market...");
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / 900) * 900;

  let tokenId = "";
  let bestAsk = 0;
  let tickSize = "0.01";
  let negRisk = true;

  for (let i = 0; i <= 3; i++) {
    const startTs = currentWindow + i * 900;
    const expTs = startTs + 900;
    if (expTs <= now + 120) continue;

    const slug = `btc-updown-15m-${startTs}`;

    try {
      const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const events = (await response.json()) as any[];

      if (!Array.isArray(events) || events.length === 0) continue;

      const event = events[0];
      if (!event.markets || event.markets.length === 0) continue;

      const market = event.markets[0];
      const tokenIds = JSON.parse(market.clobTokenIds);
      tokenId = tokenIds[0]; // YES token

      // Get orderbook for best ask and tick size
      const book = await client.getOrderBook(tokenId);
      if (!book || !(book as any).asks || (book as any).asks.length === 0) continue;

      bestAsk = parseFloat((book as any).asks[0].price);
      tickSize = (book as any).tick_size || "0.01";

      // Get neg_risk (cache it)
      try {
        const negRiskResp = await fetch(`${CLOB_HOST}/neg-risk?token_id=${tokenId}`);
        const negRiskData = (await negRiskResp.json()) as any;
        negRisk = negRiskData.neg_risk ?? true;
      } catch {
        negRisk = true; // Default for crypto markets
      }

      const timeLeft = Math.round((expTs - now) / 60);
      console.log(`Found: ${slug} (expires in ${timeLeft}min)`);
      console.log(`Token: ${tokenId.substring(0, 30)}...`);
      console.log(`Best ask: ${bestAsk}`);
      console.log(`Tick size: ${tickSize}`);
      console.log(`Neg risk: ${negRisk}\n`);
      break;
    } catch {
      continue;
    }
  }

  if (!tokenId) {
    console.error("Could not find active market");
    process.exit(1);
  }

  // Pre-cache order options (this is what TS arb-smoke does)
  const orderOptions = { tickSize: tickSize as any, negRisk };

  // Benchmark loop
  console.log("Starting benchmark...\n");
  console.log("| Iter | Sign (ms) | Post (ms) | Total (ms) | Success |");
  console.log("|------|-----------|-----------|------------|---------|");

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < numOrders; i++) {
    const price = 0.5; // Fixed price for benchmark
    const sizeUsdc = 5.0; // $5 minimum for market orders
    const shares = 10.0; // $5 at 0.50 = 10 shares

    // Time the sign phase
    const signStart = performance.now();
    const order = await client.createOrder(
      {
        tokenID: tokenId,
        price,
        size: shares,
        side: Side.BUY,
      },
      orderOptions
    );
    const signEnd = performance.now();
    const signMs = signEnd - signStart;

    // Time the post phase
    const postStart = performance.now();
    const result = await client.postOrder(order, OrderType.GTC);
    const postEnd = performance.now();
    const postMs = postEnd - postStart;

    const totalMs = signMs + postMs;
    const success = (result as any)?.success === true && !(result as any)?.errorMsg;

    results.push({
      iteration: i + 1,
      signMs,
      postMs,
      totalMs,
      success,
      errorMsg: (result as any)?.errorMsg,
    });

    console.log(
      `| ${(i + 1).toString().padStart(4)} | ${signMs.toFixed(1).padStart(9)} | ${postMs.toFixed(1).padStart(9)} | ${totalMs.toFixed(1).padStart(10)} | ${success ? "  ✓  " : "  ✗  "} |`
    );

    // Small delay between orders
    await new Promise((r) => setTimeout(r, 100));
  }

  // Summary
  console.log("\n=== Summary ===");
  const avgSign = results.reduce((a, b) => a + b.signMs, 0) / results.length;
  const avgPost = results.reduce((a, b) => a + b.postMs, 0) / results.length;
  const avgTotal = results.reduce((a, b) => a + b.totalMs, 0) / results.length;
  const minTotal = Math.min(...results.map((r) => r.totalMs));
  const maxTotal = Math.max(...results.map((r) => r.totalMs));
  const successRate = (results.filter((r) => r.success).length / results.length) * 100;

  console.log(`Average sign time:  ${avgSign.toFixed(1)} ms`);
  console.log(`Average post time:  ${avgPost.toFixed(1)} ms`);
  console.log(`Average total time: ${avgTotal.toFixed(1)} ms`);
  console.log(`Min total time:     ${minTotal.toFixed(1)} ms`);
  console.log(`Max total time:     ${maxTotal.toFixed(1)} ms`);
  console.log(`Success rate:       ${successRate.toFixed(0)}%`);

  // Output JSON for comparison
  console.log("\n=== JSON Output ===");
  console.log(
    JSON.stringify(
      {
        implementation: "typescript",
        numOrders,
        avgSignMs: avgSign,
        avgPostMs: avgPost,
        avgTotalMs: avgTotal,
        minTotalMs: minTotal,
        maxTotalMs: maxTotal,
        successRate,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
