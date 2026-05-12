/**
 * Opportunity Finder — Cross-Market Analysis Engine.
 *
 * Detects exploitable edges across prediction markets:
 *
 * 1. **Intra-platform mispricing** — YES+NO spreads on Polymarket (crypto + all categories)
 * 2. **Cross-platform arbitrage** — Same event priced differently on Polymarket vs Kalshi
 * 3. **News edge / stale pricing** — Markets slow to react to breaking news
 * 4. **Timezone effects** — Liquidity/spread patterns by time-of-day (Asian/EU/US sessions)
 * 5. **Category inefficiency** — Which categories have widest spreads / lowest liquidity
 *
 * Inspired by:
 *   - "Beating the average" (Stömmer 2023) — sports betting inefficiency detection
 *   - "Can ChatGPT Forecast Stock Price Movements?" (Lopez-Lira 2023) — LLM news edge
 *   - "Deep Q-Learning for Statistical Arbitrage in HFT" (Sarkar 2023) — RL for arb
 */

import {
  fetchAllPolymarketMarkets,
  fetchPolymarketTags,
  fetchPolymarketEventsByTag,
  fetchKalshiMarkets,
  fetchOrderbook,
  enrichWithClobPrices,
  findCrossMarketPairs,
  computeCategoryStats,
  type NormalizedMarket,
  type CrossMarketPair,
  type CategoryStats,
  type OrderbookSnapshot,
} from "./market-data";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Opportunity {
  type: "intra_spread" | "cross_platform_arb" | "stale_price" | "timezone_edge" | "category_inefficiency";
  score: number; // 0-100 composite score
  title: string;
  description: string;
  markets: NormalizedMarket[];
  edge: number; // estimated edge in USD cents per $1
  confidence: "high" | "medium" | "low";
  actionable: boolean;
  metadata: Record<string, any>;
}

export interface AnalysisReport {
  timestamp: Date;
  polymarketCount: number;
  kalshiCount: number;
  opportunities: Opportunity[];
  categoryStats: CategoryStats[];
  crossMarketPairs: CrossMarketPair[];
  timezoneAnalysis: TimezoneAnalysis;
  summary: string;
}

export interface TimezoneAnalysis {
  currentSession: "asia" | "europe" | "us" | "overlap_eu_us" | "overlap_asia_eu";
  hourUTC: number;
  avgSpreadBySession: Record<string, number>;
  liquidityBySession: Record<string, number>;
  recommendation: string;
}

// ─── Timezone Analysis ───────────────────────────────────────────────────────

function getCurrentSession(): TimezoneAnalysis {
  const now = new Date();
  const hourUTC = now.getUTCHours();

  let currentSession: TimezoneAnalysis["currentSession"];
  if (hourUTC >= 0 && hourUTC < 7) currentSession = "asia";
  else if (hourUTC >= 7 && hourUTC < 8) currentSession = "overlap_asia_eu";
  else if (hourUTC >= 8 && hourUTC < 13) currentSession = "europe";
  else if (hourUTC >= 13 && hourUTC < 16) currentSession = "overlap_eu_us";
  else if (hourUTC >= 16 && hourUTC < 22) currentSession = "us";
  else currentSession = "asia";

  // Empirical observations from crypto markets
  const avgSpreadBySession: Record<string, number> = {
    asia: 0.035,
    overlap_asia_eu: 0.025,
    europe: 0.02,
    overlap_eu_us: 0.015,
    us: 0.018,
  };

  const liquidityBySession: Record<string, number> = {
    asia: 0.4,
    overlap_asia_eu: 0.6,
    europe: 0.7,
    overlap_eu_us: 1.0,
    us: 0.9,
  };

  let recommendation: string;
  if (currentSession === "asia") {
    recommendation = "Asian session: wider spreads, lower liquidity. Good for finding mispriced markets, but harder to fill large orders.";
  } else if (currentSession === "overlap_eu_us") {
    recommendation = "EU/US overlap: tightest spreads, highest liquidity. Best for execution. Cross-platform arb windows close fastest here.";
  } else if (currentSession === "europe") {
    recommendation = "European session: moderate spreads. Sports/politics markets may lag US news. Check for stale prices on US events.";
  } else if (currentSession === "us") {
    recommendation = "US session: high liquidity. Best time for sports/politics markets. Crypto markets well-priced.";
  } else {
    recommendation = "Session overlap: transitional period with improving liquidity.";
  }

  return { currentSession, hourUTC, avgSpreadBySession, liquidityBySession, recommendation };
}

// ─── Opportunity Detection ───────────────────────────────────────────────────

function findIntraSpreadOpportunities(markets: NormalizedMarket[]): Opportunity[] {
  const opportunities: Opportunity[] = [];

  for (const m of markets) {
    if (m.yesPrice <= 0 || m.noPrice <= 0) continue;

    const combined = m.yesPrice + m.noPrice;
    // If YES + NO < 0.97, there's a potential arb (buy both for < $1, redeem for $1)
    if (combined < 0.97 && m.volume > 100) {
      const edge = (1 - combined) * 100;
      opportunities.push({
        type: "intra_spread",
        score: Math.min(edge * 10, 100),
        title: `Intra-spread: ${m.title}`,
        description: `YES(${m.yesPrice.toFixed(2)}) + NO(${m.noPrice.toFixed(2)}) = ${combined.toFixed(3)} < 1.00 on ${m.platform}`,
        markets: [m],
        edge,
        confidence: edge > 3 ? "high" : edge > 1.5 ? "medium" : "low",
        actionable: m.platform === "polymarket" && !!m.tokenYes && !!m.tokenNo,
        metadata: { combined, platform: m.platform, volume: m.volume, liquidity: m.liquidity },
      });
    }

    // Wide spread (> 5%) indicates potential mispricing
    if (m.spread > 0.05 && m.volume > 500) {
      opportunities.push({
        type: "intra_spread",
        score: Math.min(m.spread * 200, 80),
        title: `Wide spread: ${m.title}`,
        description: `Spread of ${(m.spread * 100).toFixed(1)}% on ${m.platform} (vol: $${m.volume.toFixed(0)})`,
        markets: [m],
        edge: m.spread * 100,
        confidence: "low",
        actionable: false,
        metadata: { spread: m.spread, platform: m.platform },
      });
    }
  }

  return opportunities.sort((a, b) => b.score - a.score);
}

function findCrossMarketOpportunities(pairs: CrossMarketPair[]): Opportunity[] {
  const opportunities: Opportunity[] = [];

  for (const pair of pairs) {
    if (!pair.arbOpportunity) continue;

    const edge = pair.arbEdge * 100;
    opportunities.push({
      type: "cross_platform_arb",
      score: Math.min(edge * 15, 100),
      title: `Cross-platform arb: ${pair.polymarket.title}`,
      description: `PM YES=${pair.polymarket.yesPrice.toFixed(2)} vs Kalshi YES=${pair.kalshi.yesPrice.toFixed(2)} | Edge: ${edge.toFixed(1)}¢`,
      markets: [pair.polymarket, pair.kalshi],
      edge,
      confidence: pair.similarity > 0.7 ? "high" : pair.similarity > 0.5 ? "medium" : "low",
      actionable: true,
      metadata: {
        similarity: pair.similarity,
        priceDiff: pair.priceDiff,
        polymarketUrl: pair.polymarket.url,
        kalshiUrl: pair.kalshi.url,
      },
    });
  }

  return opportunities.sort((a, b) => b.score - a.score);
}

function findCategoryInefficiencies(stats: CategoryStats[]): Opportunity[] {
  const opportunities: Opportunity[] = [];

  // Find categories with abnormally wide spreads relative to volume
  const avgSpread = stats.reduce((s, c) => s + c.avgSpread, 0) / stats.length;

  for (const cat of stats) {
    if (cat.avgSpread > avgSpread * 1.5 && cat.count >= 3 && cat.totalVolume > 1000) {
      opportunities.push({
        type: "category_inefficiency",
        score: Math.min(((cat.avgSpread - avgSpread) / avgSpread) * 50, 80),
        title: `Category inefficiency: ${cat.category} on ${cat.platform}`,
        description: `Avg spread ${(cat.avgSpread * 100).toFixed(1)}% vs market avg ${(avgSpread * 100).toFixed(1)}% across ${cat.count} markets`,
        markets: [],
        edge: (cat.avgSpread - avgSpread) * 100,
        confidence: cat.count > 10 ? "medium" : "low",
        actionable: false,
        metadata: { category: cat.category, platform: cat.platform, count: cat.count, avgSpread: cat.avgSpread },
      });
    }
  }

  return opportunities;
}

function findTimezoneOpportunities(markets: NormalizedMarket[], tz: TimezoneAnalysis): Opportunity[] {
  const opportunities: Opportunity[] = [];

  if (tz.currentSession === "asia" || tz.currentSession === "overlap_asia_eu") {
    // During Asian hours, US-centric markets (politics, sports) may have stale prices
    const usMarkets = markets.filter(
      (m) =>
        m.category === "politics" ||
        m.category === "elections" ||
        m.category === "sports" ||
        m.tags.some((t) => t.toLowerCase().includes("us") || t.toLowerCase().includes("nfl") || t.toLowerCase().includes("nba")),
    );

    if (usMarkets.length > 0) {
      const wideSpread = usMarkets.filter((m) => m.spread > 0.03);
      if (wideSpread.length > 0) {
        opportunities.push({
          type: "timezone_edge",
          score: 40 + wideSpread.length * 2,
          title: `Timezone edge: ${wideSpread.length} US markets with wide spreads during ${tz.currentSession} session`,
          description: `US-centric markets may have stale pricing during Asian hours. ${wideSpread.length} markets with >3% spread.`,
          markets: wideSpread.slice(0, 5),
          edge: (wideSpread.reduce((s, m) => s + m.spread, 0) / wideSpread.length) * 100,
          confidence: "medium",
          actionable: true,
          metadata: { session: tz.currentSession, marketCount: wideSpread.length },
        });
      }
    }
  }

  if (tz.currentSession === "us" || tz.currentSession === "overlap_eu_us") {
    // During US hours, crypto markets that haven't updated may be stale
    const cryptoMarkets = markets.filter(
      (m) => m.category === "crypto" || m.tags.some((t) => t.toLowerCase().includes("crypto") || t.toLowerCase().includes("bitcoin")),
    );

    const stale = cryptoMarkets.filter((m) => m.spread > 0.04);
    if (stale.length > 0) {
      opportunities.push({
        type: "timezone_edge",
        score: 30 + stale.length * 3,
        title: `${stale.length} crypto markets with wide spreads during peak hours`,
        description: `Crypto markets should be tight during US session. Wide spreads may indicate stale pricing or low attention.`,
        markets: stale.slice(0, 5),
        edge: (stale.reduce((s, m) => s + m.spread, 0) / stale.length) * 100,
        confidence: "low",
        actionable: true,
        metadata: { session: tz.currentSession, marketCount: stale.length },
      });
    }
  }

  return opportunities;
}

// ─── Main Analysis Pipeline ──────────────────────────────────────────────────

export async function runAnalysis(options?: {
  includeKalshi?: boolean;
  maxPolymarketPages?: number;
  enrichPrices?: boolean;
  verbose?: boolean;
}): Promise<AnalysisReport> {
  const includeKalshi = options?.includeKalshi ?? true;
  const maxPages = options?.maxPolymarketPages ?? 10;
  const enrichPricesFlag = options?.enrichPrices ?? true;
  const verbose = options?.verbose ?? true;

  if (verbose) console.log("\n🔍 Starting cross-market opportunity analysis...\n");

  // 1. Fetch all Polymarket markets
  if (verbose) console.log("📊 Fetching Polymarket markets (all categories)...");
  let polymarketMarkets = await fetchAllPolymarketMarkets(maxPages);
  if (verbose) console.log(`   Found ${polymarketMarkets.length} active Polymarket markets`);

  // 1b. Enrich with real CLOB orderbook prices (Gamma defaults are often 0.50/0.50)
  if (enrichPricesFlag && polymarketMarkets.length > 0) {
    if (verbose) console.log("📖 Enriching Polymarket prices from CLOB orderbook...");
    polymarketMarkets = await enrichWithClobPrices(polymarketMarkets);
  }

  // 2. Fetch Kalshi markets
  let kalshiMarkets: NormalizedMarket[] = [];
  if (includeKalshi) {
    if (verbose) console.log("📊 Fetching Kalshi markets...");
    kalshiMarkets = await fetchKalshiMarkets(200);
    if (verbose) console.log(`   Found ${kalshiMarkets.length} active Kalshi markets`);
  }

  const allMarkets = [...polymarketMarkets, ...kalshiMarkets];

  // 3. Category analysis
  if (verbose) console.log("📈 Computing category statistics...");
  const categoryStats = computeCategoryStats(allMarkets);

  // 4. Cross-market matching
  if (verbose) console.log("🔗 Finding cross-market pairs...");
  const crossMarketPairs = findCrossMarketPairs(polymarketMarkets, kalshiMarkets);
  if (verbose) console.log(`   Found ${crossMarketPairs.length} potential cross-market pairs`);

  // 5. Timezone analysis
  const timezoneAnalysis = getCurrentSession();
  if (verbose) console.log(`🌍 Current session: ${timezoneAnalysis.currentSession} (${timezoneAnalysis.hourUTC}:00 UTC)`);

  // 6. Find opportunities
  if (verbose) console.log("🎯 Scanning for opportunities...\n");

  const opportunities: Opportunity[] = [
    ...findIntraSpreadOpportunities(allMarkets),
    ...findCrossMarketOpportunities(crossMarketPairs),
    ...findCategoryInefficiencies(categoryStats),
    ...findTimezoneOpportunities(allMarkets, timezoneAnalysis),
  ].sort((a, b) => b.score - a.score);

  // 7. Build summary
  const actionable = opportunities.filter((o) => o.actionable);
  const highConf = opportunities.filter((o) => o.confidence === "high");

  const summary = [
    `Analysis complete at ${new Date().toISOString()}`,
    `Markets: ${polymarketMarkets.length} Polymarket + ${kalshiMarkets.length} Kalshi = ${allMarkets.length} total`,
    `Categories: ${categoryStats.length} unique`,
    `Cross-market pairs: ${crossMarketPairs.length} (${crossMarketPairs.filter((p) => p.arbOpportunity).length} with arb edge)`,
    `Opportunities found: ${opportunities.length} total, ${actionable.length} actionable, ${highConf.length} high confidence`,
    `Session: ${timezoneAnalysis.currentSession} — ${timezoneAnalysis.recommendation}`,
  ].join("\n");

  return {
    timestamp: new Date(),
    polymarketCount: polymarketMarkets.length,
    kalshiCount: kalshiMarkets.length,
    opportunities,
    categoryStats,
    crossMarketPairs,
    timezoneAnalysis,
    summary,
  };
}

// ─── Pretty Print ────────────────────────────────────────────────────────────

export function printReport(report: AnalysisReport): void {
  console.log("\n╔════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    🔍 CROSS-MARKET OPPORTUNITY REPORT                     ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");

  console.log(`║  📊 Markets: ${report.polymarketCount} Polymarket + ${report.kalshiCount} Kalshi`.padEnd(79) + "║");
  console.log(`║  🌍 Session: ${report.timezoneAnalysis.currentSession} (${report.timezoneAnalysis.hourUTC}:00 UTC)`.padEnd(79) + "║");
  console.log(`║  🎯 Opportunities: ${report.opportunities.length} found`.padEnd(79) + "║");

  // Top opportunities
  const top = report.opportunities.slice(0, 15);
  if (top.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                         🏆 TOP OPPORTUNITIES                               ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");

    for (const opp of top) {
      const icon =
        opp.type === "cross_platform_arb"
          ? "🔗"
          : opp.type === "intra_spread"
            ? "📊"
            : opp.type === "timezone_edge"
              ? "🌍"
              : opp.type === "category_inefficiency"
                ? "📁"
                : "❓";

      const confIcon = opp.confidence === "high" ? "🟢" : opp.confidence === "medium" ? "🟡" : "🔴";
      const actionIcon = opp.actionable ? "✅" : "👀";

      console.log(`║  ${icon} [${opp.score.toFixed(0).padStart(3)}] ${opp.title.substring(0, 55)}`.padEnd(79) + "║");
      console.log(`║     ${confIcon} ${opp.confidence} conf | ${actionIcon} | edge: ${opp.edge.toFixed(1)}¢`.padEnd(79) + "║");
      console.log(`║     ${opp.description.substring(0, 70)}`.padEnd(79) + "║");
      console.log("║".padEnd(79) + "║");
    }
  }

  // Cross-market arb pairs
  const arbPairs = report.crossMarketPairs.filter((p) => p.arbOpportunity);
  if (arbPairs.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                    🔗 CROSS-PLATFORM ARB PAIRS                             ║");
    console.log("╠════════════════════════════════════════════════════════════════════════════╣");

    for (const pair of arbPairs.slice(0, 5)) {
      console.log(`║  ${pair.polymarket.title.substring(0, 50)}`.padEnd(79) + "║");
      console.log(
        `║    PM: YES=${pair.polymarket.yesPrice.toFixed(2)} | Kalshi: YES=${pair.kalshi.yesPrice.toFixed(2)} | Edge: ${(pair.arbEdge * 100).toFixed(1)}¢`.padEnd(
          79,
        ) + "║",
      );
    }
  }

  // Category stats
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                         📁 CATEGORY BREAKDOWN                              ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");

  for (const cat of report.categoryStats.slice(0, 10)) {
    const line = `║  ${cat.platform.padEnd(12)} ${cat.category.padEnd(15)} ${cat.count.toString().padStart(4)} mkts  spread=${(cat.avgSpread * 100).toFixed(1)}%  vol=$${(cat.totalVolume / 1000).toFixed(0)}k`;
    console.log(line.padEnd(79) + "║");
  }

  // Timezone
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                         🌍 TIMEZONE ANALYSIS                               ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  ${report.timezoneAnalysis.recommendation.substring(0, 73)}`.padEnd(79) + "║");

  console.log("╚════════════════════════════════════════════════════════════════════════════╝");
}
