import type { MarketState } from "./types";

const CRYPTO_TICKERS = ["btc", "eth", "xrp", "sol", "doge", "bnb", "ada", "avax", "matic", "link", "dot", "ltc"];

interface GammaEvent {
  slug: string;
  title: string;
  markets: { conditionId: string; clobTokenIds: string; question: string; slug: string }[];
}

function get15mTimestamps(count: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const interval = 15 * 60;
  const currentWindow = Math.floor(now / interval) * interval;
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(currentWindow + interval * i);
  }
  return timestamps;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const CRYPTO_1H_NAMES: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  xrp: "xrp",
  sol: "solana",
};

function formatHourET(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

function generate1hSlugs(count: number): string[] {
  const slugs: string[] = [];
  const now = new Date();
  // Convert to ET (UTC-5)
  const etOffset = -5 * 60;
  const etNow = new Date(now.getTime() + (etOffset - now.getTimezoneOffset()) * 60000);

  for (const [ticker, name] of Object.entries(CRYPTO_1H_NAMES)) {
    for (let i = -1; i < count; i++) {
      const d = new Date(etNow);
      d.setHours(d.getHours() + i, 0, 0, 0);
      const month = MONTHS[d.getMonth()];
      const day = d.getDate();
      const hourStr = formatHourET(d.getHours());
      slugs.push(`${name}-up-or-down-${month}-${day}-${hourStr}-et`);
    }
  }
  return slugs;
}

function get4hTimestamps(count: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const interval = 4 * 60 * 60;
  // 4h markets are offset by 1h from standard UTC windows
  // They start at 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 UTC
  const offset = 1 * 60 * 60;
  const adjusted = now - offset;
  const currentWindow = Math.floor(adjusted / interval) * interval + offset;
  const timestamps: number[] = [];
  for (let i = -1; i < count; i++) {
    timestamps.push(currentWindow + interval * i);
  }
  return timestamps;
}

export async function fetchCrypto15mMarkets(): Promise<MarketState[]> {
  const markets: MarketState[] = [];
  const timestamps = get15mTimestamps(3);

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

export async function fetchCrypto4hMarkets(): Promise<MarketState[]> {
  const markets: MarketState[] = [];
  const timestamps = get4hTimestamps(3);

  console.log("Fetching crypto up/down 4h markets from Gamma API...\n");

  for (const ticker of CRYPTO_TICKERS) {
    for (const ts of timestamps) {
      const slug = `${ticker}-updown-4h-${ts}`;
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
              title: m.question || `${ticker.toUpperCase()} 4h`,
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

  console.log(`\nFound ${markets.length} crypto 4h markets\n`);
  return markets;
}

export async function fetchCrypto1hMarkets(): Promise<MarketState[]> {
  const markets: MarketState[] = [];
  const slugs = generate1hSlugs(3);

  console.log("Fetching crypto up/down 1h markets from Gamma API...\n");

  for (const slug of slugs) {
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
            title: m.question || slug,
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
          console.log(`  Found: ${slug}`);
        }
      }
    } catch {
      // Ignore fetch errors
    }
  }

  console.log(`\nFound ${markets.length} crypto 1h markets\n`);
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
