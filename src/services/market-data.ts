/**
 * Cross-Market Data Service.
 *
 * Fetches market data from multiple prediction market platforms:
 * - Polymarket (all categories: crypto, sports, politics, etc.)
 * - Kalshi (politics, economics, weather, sports, etc.)
 *
 * Normalizes data into a common format for cross-platform analysis.
 */

const GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const CLOB_API = "https://clob.polymarket.com";

// ─── Common Types ────────────────────────────────────────────────────────────

export interface NormalizedMarket {
  platform: "polymarket" | "kalshi";
  id: string;
  title: string;
  category: string;
  tags: string[];
  slug: string;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume: number;
  liquidity: number;
  endDate: string | null;
  active: boolean;
  url: string;
  // Polymarket-specific
  conditionId?: string;
  tokenYes?: string;
  tokenNo?: string;
  negRisk?: boolean;
  // Kalshi-specific
  seriesTicker?: string;
  eventTicker?: string;
}

export interface CrossMarketPair {
  polymarket: NormalizedMarket;
  kalshi: NormalizedMarket;
  similarity: number;
  priceDiff: number;
  arbOpportunity: boolean;
  arbEdge: number;
}

export interface MarketSnapshot {
  timestamp: Date;
  polymarketMarkets: NormalizedMarket[];
  kalshiMarkets: NormalizedMarket[];
  crossMarketPairs: CrossMarketPair[];
  categories: CategoryStats[];
}

export interface CategoryStats {
  category: string;
  platform: string;
  count: number;
  avgSpread: number;
  avgVolume: number;
  totalVolume: number;
}

// ─── Polymarket Fetcher ──────────────────────────────────────────────────────

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  markets: GammaMarket[];
  tags?: { id: number; slug: string; label: string }[];
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  volume?: number;
  liquidity?: number;
}

interface GammaMarket {
  conditionId: string;
  clobTokenIds: string;
  question: string;
  slug: string;
  outcomePrices?: string;
  volume?: number;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
}

export async function fetchPolymarketTags(): Promise<{ id: number; slug: string; label: string }[]> {
  try {
    const res = await fetch(`${GAMMA_API}/tags?limit=200`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function fetchPolymarketEventsByTag(tagId: number, limit: number = 50): Promise<NormalizedMarket[]> {
  const markets: NormalizedMarket[] = [];

  try {
    const res = await fetch(`${GAMMA_API}/events?tag_id=${tagId}&closed=false&limit=${limit}&order=id&ascending=false`);
    if (!res.ok) return markets;
    const events: GammaEvent[] = await res.json();

    for (const event of events) {
      for (const m of event.markets || []) {
        if (m.closed || !m.active) continue;

        const tokenIds = JSON.parse(m.clobTokenIds || "[]");
        const prices = JSON.parse(m.outcomePrices || "[]");
        const yesPrice = prices[0] ? Number(prices[0]) : 0;
        const noPrice = prices[1] ? Number(prices[1]) : 0;
        const vol = Number(m.volume) || Number(event.volume) || 0;
        const liq = Number(m.liquidity) || Number(event.liquidity) || 0;

        markets.push({
          platform: "polymarket",
          id: m.conditionId,
          title: m.question || event.title,
          category: event.tags?.[0]?.label || "unknown",
          tags: (event.tags || []).map((t) => t.label),
          slug: m.slug || event.slug,
          yesPrice,
          noPrice,
          spread: Math.abs(1 - yesPrice - noPrice),
          volume: vol,
          liquidity: liq,
          endDate: event.endDate || null,
          active: true,
          url: `https://polymarket.com/event/${event.slug}`,
          conditionId: m.conditionId,
          tokenYes: tokenIds[0],
          tokenNo: tokenIds[1],
          negRisk: m.negRisk,
        });
      }
    }
  } catch (err) {
    console.error(`[MarketData] Error fetching Polymarket tag ${tagId}:`, err);
  }

  return markets;
}

export async function fetchAllPolymarketMarkets(maxPages: number = 10): Promise<NormalizedMarket[]> {
  const allMarkets: NormalizedMarket[] = [];
  const seenIds = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    try {
      const offset = page * 50;
      const res = await fetch(`${GAMMA_API}/events?order=id&ascending=false&closed=false&limit=50&offset=${offset}`);
      if (!res.ok) break;
      const events: GammaEvent[] = await res.json();
      if (events.length === 0) break;

      for (const event of events) {
        for (const m of event.markets || []) {
          if (m.closed || !m.active) continue;
          if (seenIds.has(m.conditionId)) continue;
          seenIds.add(m.conditionId);

          const tokenIds = JSON.parse(m.clobTokenIds || "[]");
          const prices = JSON.parse(m.outcomePrices || "[]");
          const yesPrice = prices[0] ? Number(prices[0]) : 0;
          const noPrice = prices[1] ? Number(prices[1]) : 0;
          const vol = Number(m.volume) || Number(event.volume) || 0;
          const liq = Number(m.liquidity) || Number(event.liquidity) || 0;

          allMarkets.push({
            platform: "polymarket",
            id: m.conditionId,
            title: m.question || event.title,
            category: event.tags?.[0]?.label || "unknown",
            tags: (event.tags || []).map((t) => t.label),
            slug: m.slug || event.slug,
            yesPrice,
            noPrice,
            spread: Math.abs(1 - yesPrice - noPrice),
            volume: vol,
            liquidity: liq,
            endDate: event.endDate || null,
            active: true,
            url: `https://polymarket.com/event/${event.slug}`,
            conditionId: m.conditionId,
            tokenYes: tokenIds[0],
            tokenNo: tokenIds[1],
            negRisk: m.negRisk,
          });
        }
      }
    } catch {
      break;
    }
  }

  return allMarkets;
}

// ─── Kalshi Fetcher ──────────────────────────────────────────────────────────

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle?: string;
  category?: string;
  status: string;
  // Prices in cents (integer)
  yes_price?: number;
  no_price?: number;
  yes_bid?: number;
  no_bid?: number;
  yes_ask?: number;
  no_ask?: number;
  last_price?: number;
  // Dollar string fields (newer API)
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  liquidity_dollars?: string;
  close_time?: string;
  expiration_time?: string;
  expected_expiration_time?: string;
  result?: string;
  market_type?: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export async function fetchKalshiMarkets(limit: number = 200, status: string = "open"): Promise<NormalizedMarket[]> {
  const markets: NormalizedMarket[] = [];
  let cursor: string | undefined;

  let totalRateLimits = 0;
  const MAX_RATE_LIMITS = 3;

  try {
    while (markets.length < limit) {
      if (totalRateLimits >= MAX_RATE_LIMITS) {
        console.warn(`[MarketData] Kalshi rate limited ${totalRateLimits}x total, giving up. Got ${markets.length} markets.`);
        break;
      }

      let url = `${KALSHI_API}/markets?status=${status}&limit=100`;
      if (cursor) url += `&cursor=${cursor}`;

      const res = await fetch(url);

      if (res.status === 429) {
        totalRateLimits++;
        const waitMs = 2000 * totalRateLimits;
        console.warn(`[MarketData] Kalshi rate limited (${totalRateLimits}/${MAX_RATE_LIMITS}), waiting ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue; // retry same page
      }

      if (!res.ok) {
        console.error(`[MarketData] Kalshi API error: ${res.status}`);
        break;
      }

      const data: KalshiMarketsResponse = await res.json();
      if (!data.markets || data.markets.length === 0) break;

      for (const m of data.markets) {
        // Skip multivariate/parlay markets (very noisy)
        if (m.market_type === "multivariate" || m.ticker.includes("KXMVE")) continue;

        // Parse prices: prefer dollar strings, fall back to cent integers
        let yesPrice = 0;
        let noPrice = 0;
        if (m.yes_bid_dollars) {
          yesPrice = Number(m.yes_bid_dollars);
        } else if (m.yes_bid != null) {
          yesPrice = m.yes_bid / 100;
        } else if (m.last_price_dollars) {
          yesPrice = Number(m.last_price_dollars);
        } else if (m.last_price != null) {
          yesPrice = m.last_price / 100;
        }

        if (m.no_bid_dollars) {
          noPrice = Number(m.no_bid_dollars);
        } else if (m.no_bid != null) {
          noPrice = m.no_bid / 100;
        } else {
          noPrice = 1 - yesPrice;
        }

        // Skip markets with no pricing data
        if (yesPrice === 0 && noPrice === 0) continue;

        const vol = m.volume || m.volume_24h || 0;
        const liq = Number(m.liquidity_dollars || "0") || (m.liquidity ?? m.open_interest ?? 0);

        markets.push({
          platform: "kalshi",
          id: m.ticker,
          title: m.title,
          category: m.category || extractKalshiCategory(m.series_ticker || ""),
          tags: [m.category || "unknown"],
          slug: m.ticker,
          yesPrice,
          noPrice,
          spread: Math.abs(1 - yesPrice - noPrice),
          volume: vol,
          liquidity: liq,
          endDate: m.close_time || m.expected_expiration_time || m.expiration_time || null,
          active: m.status === "open" || m.status === "active",
          url: `https://kalshi.com/markets/${(m.series_ticker || m.ticker).toLowerCase()}`,
          seriesTicker: m.series_ticker,
          eventTicker: m.event_ticker,
        });
      }

      cursor = data.cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.error("[MarketData] Error fetching Kalshi markets:", err);
  }

  return markets;
}

function extractKalshiCategory(seriesTicker: string): string {
  const prefix = seriesTicker.slice(0, 2).toUpperCase();
  const categoryMap: Record<string, string> = {
    KX: "economics",
    IN: "politics",
    FE: "fed",
    NF: "sports",
    SU: "sports",
    WE: "weather",
    CR: "crypto",
    AI: "tech",
    EL: "elections",
  };
  return categoryMap[prefix] || "other";
}

// ─── Orderbook Data (Polymarket) ─────────────────────────────────────────────

export interface OrderbookSnapshot {
  tokenId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  depth1Pct: number; // USD within 1% of mid
}

export async function fetchOrderbook(tokenId: string): Promise<OrderbookSnapshot | null> {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const data = await res.json();

    const bids = (data.bids || []).map((b: any) => ({ price: Number(b.price), size: Number(b.size) }));
    const asks = (data.asks || []).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }));

    const bestBid = bids.length > 0 ? Math.max(...bids.map((b: any) => b.price)) : 0;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map((a: any) => a.price)) : 1;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

    // Depth within 1% of mid
    const threshold = midPrice * 0.01;
    const depth1Pct =
      bids.filter((b: any) => midPrice - b.price <= threshold).reduce((sum: number, b: any) => sum + b.price * b.size, 0) +
      asks.filter((a: any) => a.price - midPrice <= threshold).reduce((sum: number, a: any) => sum + a.price * a.size, 0);

    return { tokenId, bids, asks, bestBid, bestAsk, midPrice, spreadBps, depth1Pct };
  } catch {
    return null;
  }
}

// ─── CLOB Price Enrichment ────────────────────────────────────────────────────

/**
 * Enrich Polymarket markets with real orderbook prices from the CLOB API.
 * The Gamma API often returns default 0.50/0.50 prices; the CLOB has real book data.
 * Fetches in batches with rate limiting to avoid hammering the API.
 */
export async function enrichWithClobPrices(markets: NormalizedMarket[], batchSize: number = 10, delayMs: number = 200): Promise<NormalizedMarket[]> {
  const pmMarkets = markets.filter((m) => m.platform === "polymarket" && m.tokenYes);
  const otherMarkets = markets.filter((m) => m.platform !== "polymarket" || !m.tokenYes);
  let enriched = 0;

  for (let i = 0; i < pmMarkets.length; i += batchSize) {
    const batch = pmMarkets.slice(i, i + batchSize);
    const promises = batch.map(async (m) => {
      try {
        const [yesBook, noBook] = await Promise.all([fetchOrderbook(m.tokenYes!), m.tokenNo ? fetchOrderbook(m.tokenNo!) : null]);

        if (yesBook && yesBook.bestAsk > 0 && yesBook.bestAsk < 1) {
          m.yesPrice = yesBook.bestAsk;
        }
        if (noBook && noBook.bestAsk > 0 && noBook.bestAsk < 1) {
          m.noPrice = noBook.bestAsk;
        }

        if (m.yesPrice > 0 && m.noPrice > 0) {
          m.spread = Math.abs(1 - m.yesPrice - m.noPrice);
        }
        enriched++;
      } catch {
        // Keep original prices on error
      }
    });

    await Promise.all(promises);
    if (i + batchSize < pmMarkets.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`   Enriched ${enriched}/${pmMarkets.length} markets with CLOB orderbook prices`);
  return [...pmMarkets, ...otherMarkets];
}

// ─── Cross-Market Matching ───────────────────────────────────────────────────

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(" "));
  const wordsB = new Set(normalizeTitle(b).split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size; // Jaccard similarity
}

export function findCrossMarketPairs(polymarketMarkets: NormalizedMarket[], kalshiMarkets: NormalizedMarket[], minSimilarity: number = 0.4): CrossMarketPair[] {
  const pairs: CrossMarketPair[] = [];

  for (const pm of polymarketMarkets) {
    for (const km of kalshiMarkets) {
      const sim = titleSimilarity(pm.title, km.title);
      if (sim < minSimilarity) continue;

      const priceDiff = Math.abs(pm.yesPrice - km.yesPrice);
      // Arb exists if you can buy YES on one and NO on the other for < $1 total
      const crossCombined = Math.min(pm.yesPrice + km.noPrice, pm.noPrice + km.yesPrice);
      const arbEdge = 1 - crossCombined;
      const arbOpportunity = arbEdge > 0.02; // > 2 cents edge

      pairs.push({
        polymarket: pm,
        kalshi: km,
        similarity: sim,
        priceDiff,
        arbOpportunity,
        arbEdge,
      });
    }
  }

  return pairs.sort((a, b) => b.arbEdge - a.arbEdge);
}

// ─── Category Analysis ───────────────────────────────────────────────────────

export function computeCategoryStats(markets: NormalizedMarket[]): CategoryStats[] {
  const buckets = new Map<string, NormalizedMarket[]>();

  for (const m of markets) {
    const key = `${m.platform}:${m.category}`;
    const arr = buckets.get(key) || [];
    arr.push(m);
    buckets.set(key, arr);
  }

  const stats: CategoryStats[] = [];
  for (const [key, group] of buckets) {
    const [platform, category] = key.split(":");
    const spreads = group.map((m) => m.spread);
    const volumes = group.map((m) => m.volume);

    stats.push({
      category,
      platform,
      count: group.length,
      avgSpread: spreads.reduce((a, b) => a + b, 0) / spreads.length,
      avgVolume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
      totalVolume: volumes.reduce((a, b) => a + b, 0),
    });
  }

  return stats.sort((a, b) => b.totalVolume - a.totalVolume);
}
