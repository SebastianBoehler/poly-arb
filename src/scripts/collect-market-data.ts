/**
 * Long-running market data collector.
 *
 * Periodically snapshots ALL Polymarket markets (all categories) with real
 * CLOB orderbook prices, plus Kalshi markets, and appends rows to CSV files
 * for offline analysis.
 *
 * Outputs:
 *   market-snapshots.csv   — per-market row every scan (id, title, category, prices, spread, volume, ...)
 *   category-snapshots.csv — per-category aggregate every scan
 *   spread-timeseries.csv  — lightweight per-market spread+combined over time (for time-pattern analysis)
 *
 * Usage:
 *   bun run collect                                    # default 5min interval
 *   INTERVAL_MS=120000 MAX_PAGES=15 bun run collect    # 2min, more markets
 *
 * Env:
 *   INTERVAL_MS=300000       Scan interval (default 5 min)
 *   MAX_PAGES=10             Polymarket pages to fetch
 *   INCLUDE_KALSHI=true      Include Kalshi data
 *   OUT_DIR=./data            Output directory for CSVs
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import {
  fetchAllPolymarketMarkets,
  fetchKalshiMarkets,
  enrichWithClobPrices,
  computeCategoryStats,
  type NormalizedMarket,
  type CategoryStats,
} from "../services/market-data";

const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? "300000"); // 5 min
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "10");
const INCLUDE_KALSHI = process.env.INCLUDE_KALSHI !== "false";
const OUT_DIR = process.env.OUT_DIR ?? "./data";

// ─── CSV Helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

const MARKET_HEADER =
  [
    "timestamp",
    "scan_id",
    "platform",
    "id",
    "title",
    "category",
    "tags",
    "slug",
    "yes_price",
    "no_price",
    "combined",
    "spread",
    "spread_pct",
    "volume",
    "liquidity",
    "end_date",
    "hour_utc",
    "session",
    "day_of_week",
  ].join(",") + "\n";

const CATEGORY_HEADER =
  ["timestamp", "scan_id", "platform", "category", "count", "avg_spread", "avg_spread_pct", "avg_volume", "total_volume", "hour_utc", "session"].join(",") +
  "\n";

const SPREAD_HEADER =
  ["timestamp", "scan_id", "platform", "id", "title", "category", "yes_price", "no_price", "combined", "spread_pct", "hour_utc", "session"].join(",") + "\n";

function getSession(hourUTC: number): string {
  if (hourUTC >= 0 && hourUTC < 7) return "asia";
  if (hourUTC >= 7 && hourUTC < 8) return "overlap_asia_eu";
  if (hourUTC >= 8 && hourUTC < 13) return "europe";
  if (hourUTC >= 13 && hourUTC < 16) return "overlap_eu_us";
  if (hourUTC >= 16 && hourUTC < 22) return "us";
  return "asia";
}

function initCsv(path: string, header: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, header);
  }
}

// ─── Snapshot Writer ─────────────────────────────────────────────────────────

function writeMarketRows(markets: NormalizedMarket[], scanId: number, ts: Date, marketFile: string, spreadFile: string): void {
  const hourUTC = ts.getUTCHours();
  const session = getSession(hourUTC);
  const dayOfWeek = ts.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const isoTs = ts.toISOString();

  let marketBuf = "";
  let spreadBuf = "";

  for (const m of markets) {
    const combined = m.yesPrice + m.noPrice;
    const spreadPct = combined > 0 ? (m.spread / combined) * 100 : 0;

    marketBuf +=
      [
        isoTs,
        scanId,
        m.platform,
        csvEscape(m.id),
        csvEscape(m.title),
        csvEscape(m.category),
        csvEscape(m.tags.join(";")),
        csvEscape(m.slug),
        m.yesPrice.toFixed(4),
        m.noPrice.toFixed(4),
        combined.toFixed(4),
        m.spread.toFixed(4),
        spreadPct.toFixed(2),
        m.volume.toFixed(0),
        m.liquidity.toFixed(0),
        m.endDate ?? "",
        hourUTC,
        session,
        dayOfWeek,
      ].join(",") + "\n";

    // Only write spread timeseries for markets with real prices
    if (m.yesPrice > 0 && m.noPrice > 0 && m.yesPrice < 1 && m.noPrice < 1) {
      spreadBuf +=
        [
          isoTs,
          scanId,
          m.platform,
          csvEscape(m.id),
          csvEscape(m.title),
          csvEscape(m.category),
          m.yesPrice.toFixed(4),
          m.noPrice.toFixed(4),
          combined.toFixed(4),
          spreadPct.toFixed(2),
          hourUTC,
          session,
        ].join(",") + "\n";
    }
  }

  appendFileSync(marketFile, marketBuf);
  appendFileSync(spreadFile, spreadBuf);
}

function writeCategoryRows(stats: CategoryStats[], scanId: number, ts: Date, catFile: string): void {
  const hourUTC = ts.getUTCHours();
  const session = getSession(hourUTC);
  const isoTs = ts.toISOString();

  let buf = "";
  for (const cat of stats) {
    const spreadPct = cat.avgSpread * 100;
    buf +=
      [
        isoTs,
        scanId,
        cat.platform,
        csvEscape(cat.category),
        cat.count,
        cat.avgSpread.toFixed(4),
        spreadPct.toFixed(2),
        cat.avgVolume.toFixed(0),
        cat.totalVolume.toFixed(0),
        hourUTC,
        session,
      ].join(",") + "\n";
  }
  appendFileSync(catFile, buf);
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function scan(scanId: number, marketFile: string, catFile: string, spreadFile: string): Promise<{ marketCount: number; catCount: number }> {
  const ts = new Date();

  // Fetch Polymarket
  let pmMarkets = await fetchAllPolymarketMarkets(MAX_PAGES);
  if (pmMarkets.length > 0) {
    pmMarkets = await enrichWithClobPrices(pmMarkets, 15, 150);
  }

  // Fetch Kalshi
  let kalshiMarkets: NormalizedMarket[] = [];
  if (INCLUDE_KALSHI) {
    kalshiMarkets = await fetchKalshiMarkets(200);
  }

  const allMarkets = [...pmMarkets, ...kalshiMarkets];
  const stats = computeCategoryStats(allMarkets);

  writeMarketRows(allMarkets, scanId, ts, marketFile, spreadFile);
  writeCategoryRows(stats, scanId, ts, catFile);

  return { marketCount: allMarkets.length, catCount: stats.length };
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);

  const marketFile = `${OUT_DIR}/market-snapshots.csv`;
  const catFile = `${OUT_DIR}/category-snapshots.csv`;
  const spreadFile = `${OUT_DIR}/spread-timeseries.csv`;

  initCsv(marketFile, MARKET_HEADER);
  initCsv(catFile, CATEGORY_HEADER);
  initCsv(spreadFile, SPREAD_HEADER);

  console.log("=== MARKET DATA COLLECTOR ===\n");
  console.log(`Interval: ${INTERVAL_MS / 1000}s`);
  console.log(`Pages: ${MAX_PAGES} (≈${MAX_PAGES * 50} markets)`);
  console.log(`Kalshi: ${INCLUDE_KALSHI ? "✅" : "❌"}`);
  console.log(`Output: ${OUT_DIR}/`);
  console.log(`  → ${marketFile}`);
  console.log(`  → ${catFile}`);
  console.log(`  → ${spreadFile}`);
  console.log(`\nCollecting... Press Ctrl+C to stop.\n`);

  let scanId = 0;

  const doScan = async () => {
    scanId++;
    const start = Date.now();
    try {
      const { marketCount, catCount } = await scan(scanId, marketFile, catFile, spreadFile);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] Scan #${scanId}: ${marketCount} markets, ${catCount} categories (${elapsed}s)`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Scan #${scanId} FAILED:`, err);
    }
  };

  // Initial scan
  await doScan();

  // Recurring scans
  const interval = setInterval(doScan, INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log(`\n\nStopped after ${scanId} scans. Data saved to ${OUT_DIR}/`);
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
