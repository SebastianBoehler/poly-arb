/**
 * Cross-Market Analysis Script.
 *
 * Fetches data from Polymarket (all categories) and Kalshi,
 * runs opportunity detection, and outputs a comprehensive report.
 *
 * Can run as one-shot or continuous monitoring mode.
 *
 * Usage:
 *   bun run src/scripts/analyze-markets.ts                  # one-shot
 *   DAEMON=true bun run src/scripts/analyze-markets.ts      # continuous
 *   CSV=true bun run src/scripts/analyze-markets.ts         # export CSV
 *
 * Env:
 *   DAEMON=true/false          Continuous mode (default: false)
 *   ANALYSIS_INTERVAL_MS=60000 Interval between scans in daemon mode
 *   INCLUDE_KALSHI=true        Include Kalshi data (default: true)
 *   MAX_PAGES=10               Max Polymarket pages to fetch
 *   CSV=true                   Export opportunities to CSV
 *   MIN_SCORE=20               Minimum opportunity score to display
 */

import { runAnalysis, printReport, type AnalysisReport, type Opportunity } from "../services/opportunity-finder";
import { writeFileSync, appendFileSync, existsSync } from "fs";

const DAEMON = process.env.DAEMON === "true";
const INTERVAL_MS = Number(process.env.ANALYSIS_INTERVAL_MS ?? "60000");
const INCLUDE_KALSHI = process.env.INCLUDE_KALSHI !== "false";
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "10");
const EXPORT_CSV = process.env.CSV === "true";
const MIN_SCORE = Number(process.env.MIN_SCORE ?? "0");

function exportToCsv(report: AnalysisReport, filename: string): void {
  const header = "timestamp,type,score,confidence,actionable,edge_cents,title,platform,category,volume,description\n";
  const needsHeader = !existsSync(filename);

  if (needsHeader) {
    writeFileSync(filename, header);
  }

  for (const opp of report.opportunities) {
    if (opp.score < MIN_SCORE) continue;
    const platform = opp.markets[0]?.platform ?? "unknown";
    const category = opp.markets[0]?.category ?? "unknown";
    const volume = opp.markets[0]?.volume ?? 0;
    const row = [
      report.timestamp.toISOString(),
      opp.type,
      opp.score.toFixed(1),
      opp.confidence,
      opp.actionable,
      opp.edge.toFixed(2),
      `"${opp.title.replace(/"/g, '""')}"`,
      platform,
      category,
      volume.toFixed(0),
      `"${opp.description.replace(/"/g, '""').substring(0, 200)}"`,
    ].join(",");
    appendFileSync(filename, row + "\n");
  }
}

function exportCategoryStatsCsv(report: AnalysisReport, filename: string): void {
  const header = "timestamp,platform,category,count,avg_spread_pct,avg_volume,total_volume\n";
  const needsHeader = !existsSync(filename);

  if (needsHeader) {
    writeFileSync(filename, header);
  }

  for (const cat of report.categoryStats) {
    const row = [
      report.timestamp.toISOString(),
      cat.platform,
      cat.category,
      cat.count,
      (cat.avgSpread * 100).toFixed(2),
      cat.avgVolume.toFixed(0),
      cat.totalVolume.toFixed(0),
    ].join(",");
    appendFileSync(filename, row + "\n");
  }
}

function printCompactSummary(report: AnalysisReport): void {
  const actionable = report.opportunities.filter((o) => o.actionable && o.score >= MIN_SCORE);
  const byType = new Map<string, Opportunity[]>();
  for (const o of report.opportunities) {
    const arr = byType.get(o.type) || [];
    arr.push(o);
    byType.set(o.type, arr);
  }

  console.log(`\n[${report.timestamp.toISOString()}] Scan complete:`);
  console.log(`  Markets: ${report.polymarketCount} PM + ${report.kalshiCount} Kalshi`);
  console.log(`  Opportunities: ${report.opportunities.length} total, ${actionable.length} actionable`);

  for (const [type, opps] of byType) {
    const best = opps[0];
    console.log(`  ${type}: ${opps.length} (best: ${best.edge.toFixed(1)}¢ edge, score ${best.score.toFixed(0)})`);
  }

  if (actionable.length > 0) {
    console.log("\n  Top 3 actionable:");
    for (const opp of actionable.slice(0, 3)) {
      console.log(`    [${opp.score.toFixed(0)}] ${opp.title.substring(0, 60)} | ${opp.edge.toFixed(1)}¢`);
    }
  }
}

async function runOnce(): Promise<AnalysisReport> {
  const report = await runAnalysis({
    includeKalshi: INCLUDE_KALSHI,
    maxPolymarketPages: MAX_PAGES,
    verbose: !DAEMON,
  });

  if (DAEMON) {
    printCompactSummary(report);
  } else {
    printReport(report);
    console.log("\n" + report.summary);
  }

  if (EXPORT_CSV) {
    const oppFile = "opportunities.csv";
    const catFile = "category-stats.csv";
    exportToCsv(report, oppFile);
    exportCategoryStatsCsv(report, catFile);
    console.log(`\n📁 Exported to ${oppFile} and ${catFile}`);
  }

  return report;
}

async function main(): Promise<void> {
  console.log("=== CROSS-MARKET OPPORTUNITY ANALYZER ===\n");
  console.log(`Mode: ${DAEMON ? "🔄 Continuous" : "📸 One-shot"}`);
  console.log(`Kalshi: ${INCLUDE_KALSHI ? "✅" : "❌"}`);
  console.log(`Pages: ${MAX_PAGES}`);
  if (EXPORT_CSV) console.log(`CSV export: ✅`);
  console.log("");

  if (!DAEMON) {
    await runOnce();
    return;
  }

  // Daemon mode
  console.log(`Scanning every ${INTERVAL_MS / 1000}s. Press Ctrl+C to stop.\n`);

  const run = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("[Analyzer] Error:", err);
    }
  };

  await run();
  const interval = setInterval(run, INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\nShutting down analyzer...");
    clearInterval(interval);
    process.exit(0);
  });

  await new Promise(() => {});
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
