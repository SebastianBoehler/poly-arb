import type { MarketState } from "./types";

const CRYPTO_TICKERS = ["btc", "eth", "xrp", "sol", "doge", "bnb", "ada", "avax", "matic", "link", "dot", "ltc"];

interface GammaEvent {
  slug: string;
  title: string;
  markets: { conditionId: string; clobTokenIds: string; question: string; slug: string }[];
}

function getRecentTimestamps(count: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const interval = 15 * 60;
  const currentWindow = Math.floor(now / interval) * interval;
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(currentWindow + interval * i);
  }
  return timestamps;
}

export async function fetchCrypto15mMarkets(): Promise<MarketState[]> {
  const markets: MarketState[] = [];
  const timestamps = getRecentTimestamps(3);

  console.log("Fetching crypto up/down 15m markets from Gamma API...\n");

  for (const ticker of CRYPTO_TICKERS) {
    for (const ts of timestamps) {
      const slug = `${ticker}-updown-15m-${ts}`;
      try {
        const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data: GammaEvent[] = await res.json();
        if (data.length > 0 && data[0].markets?.length > 0) {
          const m = data[0].markets[0];
          const tokenIds = JSON.parse(m.clobTokenIds || "[]");
          if (tokenIds.length >= 2) {
            markets.push({
              slug: m.slug || data[0].slug,
              title: m.question || `${ticker.toUpperCase()} 15m`,
              conditionId: m.conditionId,
              tokenYes: tokenIds[0],
              tokenNo: tokenIds[1],
              bestAskYes: 0,
              bestAskNo: 0,
              totalCostYes: 0,
              totalSharesYes: 0,
              totalCostNo: 0,
              totalSharesNo: 0,
              ladderLevel: 0,
              lastEntryCombined: 0,
              entryCount: 0,
              lowestCombined: Infinity,
              highestCombined: -Infinity,
              priceUpdates: 0,
            });
            console.log(`  Found: ${ticker.toUpperCase()} - ${m.slug}`);
          }
        }
      } catch {
        // Ignore fetch errors
      }
    }
  }

  console.log(`\nFound ${markets.length} crypto 15m markets\n`);
  return markets;
}

interface ClobMarket {
  condition_id: string;
  tokens: { token_id: string; outcome: string }[];
  neg_risk: boolean;
  active: boolean;
  closed: boolean;
  question?: string;
  market_slug?: string;
}

export async function fetchNegRiskMarkets(maxMarkets: number = 50): Promise<MarketState[]> {
  const markets: MarketState[] = [];
  console.log("Fetching neg_risk (binary) markets from CLOB API...\n");

  try {
    let nextCursor: string | undefined = undefined;

    while (markets.length < maxMarkets) {
      const url: string = nextCursor ? `https://clob.polymarket.com/markets?next_cursor=${nextCursor}` : `https://clob.polymarket.com/markets`;

      const res: Response = await fetch(url);
      if (!res.ok) {
        console.error(`CLOB API error: ${res.status}`);
        break;
      }

      const data = (await res.json()) as { data?: ClobMarket[]; next_cursor?: string };
      const marketList: ClobMarket[] = data.data || [];

      if (marketList.length === 0) break;

      for (const m of marketList) {
        if (!m.neg_risk || !m.active || m.closed) continue;
        if (!m.tokens || m.tokens.length !== 2) continue;

        const tokenYes = m.tokens.find((t) => t.outcome === "Yes")?.token_id;
        const tokenNo = m.tokens.find((t) => t.outcome === "No")?.token_id;
        if (!tokenYes || !tokenNo) continue;

        markets.push({
          slug: m.market_slug || m.condition_id,
          title: m.question || m.market_slug || "Unknown",
          conditionId: m.condition_id,
          tokenYes,
          tokenNo,
          bestAskYes: 0,
          bestAskNo: 0,
          totalCostYes: 0,
          totalSharesYes: 0,
          totalCostNo: 0,
          totalSharesNo: 0,
          ladderLevel: 0,
          lastEntryCombined: 0,
          entryCount: 0,
          lowestCombined: Infinity,
          highestCombined: -Infinity,
          priceUpdates: 0,
        });

        if (markets.length >= maxMarkets) break;
      }

      nextCursor = data.next_cursor;
      if (!nextCursor) break;
      console.log(`  Fetched ${markets.length} neg_risk markets so far...`);
    }
  } catch (e) {
    console.error("Error fetching markets:", e);
  }

  console.log(`\nFound ${markets.length} active neg_risk (binary) markets\n`);
  return markets;
}
