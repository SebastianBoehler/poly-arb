/**
 * Copy Trading Strategy for Polymarket.
 *
 * Monitors target wallets for new trades and mirrors them using the CLOB client.
 * Supports size scaling, slippage limits, and market filtering.
 *
 * Usage: bun run src/strategies/copy-trade.ts
 *
 * Env:
 *   COPY_WALLETS=0xabc,0xdef     Comma-separated wallet addresses to copy
 *   COPY_SCALE=1.0               Size multiplier (0.5 = half size, 2.0 = double)
 *   COPY_MAX_SLIPPAGE=0.03       Max price slippage allowed (3 cents)
 *   COPY_MAX_USDC=50             Max USDC per single copy trade
 *   COPY_MIN_USDC=1              Min USDC to bother copying
 *   COPY_POLL_MS=5000            Poll interval in ms
 *   DRY_RUN=true                 Simulate trades without executing
 *   PRIVATE_KEY=0x...            Wallet private key (required for live)
 *   FUNDER_ADDRESS=0x...         Gnosis Safe address (optional)
 */

import { WalletMonitor, type WalletTrade } from "../services/wallet-monitor";
import { formatUSD } from "../core/utils";

// Config
const COPY_WALLETS = (process.env.COPY_WALLETS ?? "").split(",").filter(Boolean);
const COPY_SCALE = Number(process.env.COPY_SCALE ?? "1.0");
const COPY_MAX_SLIPPAGE = Number(process.env.COPY_MAX_SLIPPAGE ?? "0.03");
const COPY_MAX_USDC = Number(process.env.COPY_MAX_USDC ?? "50");
const COPY_MIN_USDC = Number(process.env.COPY_MIN_USDC ?? "1");
const COPY_POLL_MS = Number(process.env.COPY_POLL_MS ?? "5000");
const DRY_RUN = process.env.DRY_RUN !== "false";

interface CopyTradeLog {
  timestamp: Date;
  sourceWallet: string;
  trade: WalletTrade;
  action: "COPIED" | "SKIPPED" | "FAILED";
  reason?: string;
  scaledSize?: number;
  executionPrice?: number;
  orderId?: string;
}

const tradeLog: CopyTradeLog[] = [];
let totalCopiedUsdc = 0;
let totalSkipped = 0;
let totalFailed = 0;

async function executeCopyTrade(trade: WalletTrade, scaledUsdcSize: number): Promise<{ success: boolean; orderId?: string; error?: string }> {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would ${trade.side} ${scaledUsdcSize.toFixed(2)} USDC of ${trade.outcome} @ ${trade.price}`);
    return { success: true, orderId: "dry-run-" + Date.now() };
  }

  // Live execution using CLOB client
  try {
    const { ClobClient } = await import("@polymarket/clob-client");
    const { Wallet } = await import("@ethersproject/wallet");

    const privateKey = process.env.PRIVATE_KEY;
    const funderAddress = process.env.FUNDER_ADDRESS;
    if (!privateKey) {
      return { success: false, error: "PRIVATE_KEY not set" };
    }

    const signer = new Wallet(privateKey);
    const sigType = Number(process.env.SIGNATURE_TYPE ?? "2");

    // Derive API creds
    const tempClient = new ClobClient("https://clob.polymarket.com", 137, signer);
    const creds = await tempClient.createOrDeriveApiKey();

    const client = new ClobClient("https://clob.polymarket.com", 137, signer, creds, sigType, funderAddress);

    const limitPrice = trade.side === "BUY" ? Math.min(trade.price + COPY_MAX_SLIPPAGE, 0.99) : Math.max(trade.price - COPY_MAX_SLIPPAGE, 0.01);

    const shares = scaledUsdcSize / limitPrice;

    const { Side } = await import("@polymarket/clob-client");

    const order = await client.createOrder({
      tokenID: trade.asset,
      price: limitPrice,
      size: shares,
      side: trade.side === "BUY" ? Side.BUY : Side.SELL,
    });

    // Use FOK to ensure immediate fill or nothing
    const result = await client.postOrder(order, "FOK" as any);

    if (result.success) {
      return { success: true, orderId: result.orderID };
    } else {
      return { success: false, error: result.errorMsg || "Order rejected" };
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

function handleNewTrade(trade: WalletTrade, walletAddress: string): void {
  const scaledUsdc = trade.usdcSize * COPY_SCALE;

  console.log(`\n[CopyTrade] New trade detected from ${walletAddress.slice(0, 10)}...`);
  console.log(`  Market: ${trade.title}`);
  console.log(`  Action: ${trade.side} ${trade.outcome} @ ${trade.price}`);
  console.log(`  Size: ${formatUSD(trade.usdcSize)} → Scaled: ${formatUSD(scaledUsdc)}`);

  // Filters
  if (scaledUsdc < COPY_MIN_USDC) {
    console.log(`  ⏭️  SKIPPED: Below min size (${formatUSD(COPY_MIN_USDC)})`);
    tradeLog.push({ timestamp: new Date(), sourceWallet: walletAddress, trade, action: "SKIPPED", reason: "below_min_size" });
    totalSkipped++;
    return;
  }

  if (scaledUsdc > COPY_MAX_USDC) {
    console.log(`  ⚠️  Capping at max ${formatUSD(COPY_MAX_USDC)}`);
  }

  const finalUsdc = Math.min(scaledUsdc, COPY_MAX_USDC);

  // Execute
  executeCopyTrade(trade, finalUsdc).then((result) => {
    if (result.success) {
      console.log(`  ✅ COPIED: ${formatUSD(finalUsdc)} | Order: ${result.orderId}`);
      tradeLog.push({
        timestamp: new Date(),
        sourceWallet: walletAddress,
        trade,
        action: "COPIED",
        scaledSize: finalUsdc,
        executionPrice: trade.price,
        orderId: result.orderId,
      });
      totalCopiedUsdc += finalUsdc;
    } else {
      console.log(`  ❌ FAILED: ${result.error}`);
      tradeLog.push({
        timestamp: new Date(),
        sourceWallet: walletAddress,
        trade,
        action: "FAILED",
        reason: result.error,
      });
      totalFailed++;
    }
  });
}

function printSummary(): void {
  console.log("\n\n========== COPY TRADE SUMMARY ==========\n");
  console.log(`Total Copied: ${formatUSD(totalCopiedUsdc)} across ${tradeLog.filter((l) => l.action === "COPIED").length} trades`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Failed: ${totalFailed}`);

  if (tradeLog.length > 0) {
    console.log("\nRecent trades:");
    for (const log of tradeLog.slice(-10)) {
      const icon = log.action === "COPIED" ? "✅" : log.action === "SKIPPED" ? "⏭️" : "❌";
      console.log(`  ${icon} ${log.timestamp.toISOString()} ${log.trade.side} ${log.trade.outcome} ${formatUSD(log.trade.usdcSize)} → ${log.action}`);
    }
  }
}

async function main(): Promise<void> {
  if (COPY_WALLETS.length === 0) {
    console.error("Error: Set COPY_WALLETS env var (comma-separated addresses)");
    process.exit(1);
  }

  console.log("=== POLYMARKET COPY TRADING ===\n");
  console.log(`Mode: ${DRY_RUN ? "🔒 DRY RUN" : "🔴 LIVE"}`);
  console.log(`Scale: ${COPY_SCALE}x`);
  console.log(`Max slippage: ${COPY_MAX_SLIPPAGE}`);
  console.log(`Size range: ${formatUSD(COPY_MIN_USDC)} - ${formatUSD(COPY_MAX_USDC)}`);
  console.log(`Poll interval: ${COPY_POLL_MS}ms`);
  console.log(`Wallets: ${COPY_WALLETS.length}\n`);

  const monitor = new WalletMonitor({
    wallets: COPY_WALLETS,
    onTrade: handleNewTrade,
    pollIntervalMs: COPY_POLL_MS,
  });

  await monitor.start();

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    monitor.stop();
    printSummary();
    process.exit(0);
  });

  console.log("\nListening for trades... Press Ctrl+C to stop.\n");
  await new Promise(() => {});
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
