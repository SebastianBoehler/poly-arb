/**
 * Latency test script for Polymarket CLOB API.
 *
 * Measures:
 * 1. Round-trip time (RTT) - time to get server response
 * 2. Clock offset - difference between local time and server time
 * 3. Estimated one-way latency - how fast our requests reach their servers
 *
 * NOTE: Polymarket's getServerTime() returns seconds precision only (no ms).
 * This limits clock offset accuracy to ±500ms. RTT measurement is still accurate.
 *
 * Run: bun run src/scripts/latency-test.ts
 */
import { ClobClient } from "@polymarket/clob-client";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const ITERATIONS = 20;

interface LatencyResult {
  rtt: number; // Round-trip time in ms
  serverTimeSec: number; // Server timestamp (seconds)
  serverTimeMs: number; // Server timestamp converted to ms
  localTimeBefore: number; // Local time before request
  localTimeAfter: number; // Local time after request
  clockOffsetRaw: number; // Raw offset (affected by second-precision)
  estimatedOneWay: number; // RTT / 2
}

async function measureLatency(client: ClobClient): Promise<LatencyResult> {
  const localTimeBefore = Date.now();
  const serverTimeSec = await client.getServerTime();
  const localTimeAfter = Date.now();

  // Server returns Unix timestamp in SECONDS, convert to ms
  const serverTimeMs = serverTimeSec * 1000;

  const rtt = localTimeAfter - localTimeBefore;
  const localMidpoint = (localTimeBefore + localTimeAfter) / 2;

  // Raw clock offset - note: server only has second precision
  // so this will vary by up to ±500ms even with perfect sync
  const clockOffsetRaw = serverTimeMs - localMidpoint;

  const estimatedOneWay = rtt / 2;

  return {
    rtt,
    serverTimeSec,
    serverTimeMs,
    localTimeBefore,
    localTimeAfter,
    clockOffsetRaw,
    estimatedOneWay,
  };
}

function stats(values: number[]): { min: number; max: number; avg: number; median: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.floor(sorted.length * 0.95);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[p95Index],
  };
}

async function main() {
  console.log("=== POLYMARKET LATENCY TEST ===\n");
  console.log(`Host: ${CLOB_HOST}`);
  console.log(`Iterations: ${ITERATIONS}\n`);

  const client = new ClobClient(CLOB_HOST, CHAIN_ID);

  // Warmup request
  console.log("Warming up...");
  await client.getServerTime();

  console.log("\nRunning latency tests...\n");

  const results: LatencyResult[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const result = await measureLatency(client);
    results.push(result);

    console.log(
      `[${(i + 1).toString().padStart(2)}] RTT: ${result.rtt.toString().padStart(4)}ms | ` +
        `Clock offset: ${result.clockOffsetRaw >= 0 ? "+" : ""}${result.clockOffsetRaw.toFixed(0).padStart(5)}ms | ` +
        `Server: ${new Date(result.serverTimeMs).toISOString()}`
    );

    // Small delay between requests to avoid rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\n=== RESULTS ===\n");

  const rttStats = stats(results.map((r) => r.rtt));
  const offsetStats = stats(results.map((r) => r.clockOffsetRaw));

  console.log("Round-Trip Time (RTT):");
  console.log(`  Min:    ${rttStats.min.toFixed(0)}ms`);
  console.log(`  Max:    ${rttStats.max.toFixed(0)}ms`);
  console.log(`  Avg:    ${rttStats.avg.toFixed(1)}ms`);
  console.log(`  Median: ${rttStats.median.toFixed(0)}ms`);
  console.log(`  P95:    ${rttStats.p95.toFixed(0)}ms`);

  console.log("\nClock Offset (server - local, ±500ms precision):");
  console.log(`  Min:    ${offsetStats.min >= 0 ? "+" : ""}${offsetStats.min.toFixed(0)}ms`);
  console.log(`  Max:    ${offsetStats.max >= 0 ? "+" : ""}${offsetStats.max.toFixed(0)}ms`);
  console.log(`  Avg:    ${offsetStats.avg >= 0 ? "+" : ""}${offsetStats.avg.toFixed(1)}ms`);
  console.log(`  Median: ${offsetStats.median >= 0 ? "+" : ""}${offsetStats.median.toFixed(0)}ms`);

  // Estimate true clock offset by adjusting for second-precision truncation
  // Server truncates to seconds, so on average we're off by ~500ms
  const adjustedOffset = offsetStats.avg + 500;
  console.log(`  Adjusted (compensating for truncation): ${adjustedOffset >= 0 ? "+" : ""}${adjustedOffset.toFixed(0)}ms`);

  console.log("\nEstimated One-Way Latency (RTT/2):");
  console.log(`  Avg:    ${(rttStats.avg / 2).toFixed(1)}ms`);
  console.log(`  Median: ${(rttStats.median / 2).toFixed(0)}ms`);

  // Interpretation
  console.log("\n=== INTERPRETATION ===\n");

  console.log("⚠️  Note: Server time has SECOND precision only (no milliseconds).");
  console.log("   Clock offset measurements have ±500ms uncertainty.\n");

  if (Math.abs(adjustedOffset) < 100) {
    console.log("✅ Clock sync: Your local clock appears well-synced with Polymarket servers.");
  } else if (adjustedOffset > 0) {
    console.log(`📊 Clock sync: Server is ~${adjustedOffset.toFixed(0)}ms ahead of your local clock.`);
  } else {
    console.log(`📊 Clock sync: Your local clock is ~${Math.abs(adjustedOffset).toFixed(0)}ms ahead of server.`);
  }

  if (rttStats.avg < 100) {
    console.log("✅ Latency: Excellent (<100ms RTT)");
  } else if (rttStats.avg < 200) {
    console.log("⚡ Latency: Good (100-200ms RTT)");
  } else if (rttStats.avg < 500) {
    console.log("⚠️  Latency: Moderate (200-500ms RTT)");
  } else {
    console.log("❌ Latency: High (>500ms RTT) - consider a closer server location");
  }

  // Jitter
  const jitter = rttStats.max - rttStats.min;
  if (jitter < 50) {
    console.log("✅ Jitter: Low (<50ms variance)");
  } else if (jitter < 100) {
    console.log("⚡ Jitter: Moderate (50-100ms variance)");
  } else {
    console.log(`⚠️  Jitter: High (${jitter.toFixed(0)}ms variance)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
