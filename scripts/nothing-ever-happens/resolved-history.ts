type Args = {
  lookbackHours: number;
  limit: number;
  pageSize: number;
  minClosedTime: Date;
  category: string;
};

type GammaMarket = {
  question?: string;
  conditionId?: string;
  closed?: boolean;
  closedTime?: string;
  outcomes?: string;
  outcomePrices?: string;
  events?: Array<{
    title?: string;
    slug?: string;
    seriesSlug?: string;
    series?: Array<{ slug?: string; title?: string; ticker?: string }>;
  }>;
};

type Row = {
  question: string;
  conditionId: string;
  closedTime: Date;
  category: string;
  winner: "yes" | "no";
};

const GAMMA_MARKETS = "https://gamma-api.polymarket.com/markets";

function parseArgs(argv: string[]): Args {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    opts.set(key.slice(2), value);
    i += 1;
  }

  const lookbackHours = Number(opts.get("lookback-hours") ?? "336");
  const limit = Number(opts.get("limit") ?? "2500");
  const pageSize = Number(opts.get("page-size") ?? "100");
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) throw new Error("--lookback-hours must be positive");
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("--page-size must be a positive integer");

  return {
    lookbackHours,
    limit,
    pageSize,
    minClosedTime: new Date(Date.now() - lookbackHours * 60 * 60 * 1000),
    category: (opts.get("category") ?? "").toLowerCase(),
  };
}

async function fetchClosedMarkets(args: Args): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; rows.length < args.limit; offset += args.pageSize) {
    const url = new URL(GAMMA_MARKETS);
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", String(args.pageSize));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order", "closedTime");
    url.searchParams.set("ascending", "false");

    const batch = await fetchJson<GammaMarket[]>(url.toString());
    if (!batch.length) break;

    let sawOlder = false;
    for (const market of batch) {
      const row = normalizeMarket(market);
      if (!row) continue;
      if (row.closedTime < args.minClosedTime) {
        sawOlder = true;
        continue;
      }
      if (args.category && row.category !== args.category) continue;
      rows.push(row);
      if (rows.length >= args.limit) break;
    }
    if (sawOlder) break;
  }
  return rows;
}

function normalizeMarket(market: GammaMarket): Row | null {
  if (!market.closed || !market.closedTime) return null;
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  if (outcomes.length !== 2 || prices.length !== 2) return null;

  const normalizedOutcomes = outcomes.map((item) => String(item).trim().toLowerCase());
  if (normalizedOutcomes[0] !== "yes" || normalizedOutcomes[1] !== "no") return null;

  const yesPrice = prices[0];
  const noPrice = prices[1];
  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) return null;
  if (yesPrice !== 1 && noPrice !== 1) return null;

  const closedTime = parseClosedTime(market.closedTime);
  if (!closedTime) return null;

  return {
    question: market.question ?? "",
    conditionId: market.conditionId ?? "",
    closedTime,
    category: classifyMarket(market),
    winner: noPrice === 1 ? "no" : "yes",
  };
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseClosedTime(raw: string): Date | null {
  const withDateTime = raw.includes("T") ? raw : raw.replace(" ", "T");
  const normalized = withDateTime.replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function classifyMarket(market: GammaMarket): string {
  const event = market.events?.[0];
  const series = event?.series?.[0];
  const text = [
    market.question,
    event?.title,
    event?.slug,
    event?.seriesSlug,
    series?.slug,
    series?.title,
    series?.ticker,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (match(text, ["election", "trump", "biden", "congress", "senate", "president", "politic", "mayor", "governor"])) return "politics";
  if (match(text, ["btc", "bitcoin", "ethereum", "solana", "xrp", "dogecoin", "crypto", "token", "airdrop"])) return "crypto";
  if (match(text, ["nba", "nfl", "mlb", "nhl", "atp", "wta", "ufc", "soccer", "cricket", "tennis", "golf", "f1", "formula", "champions league"])) return "sports";
  if (match(text, ["lol:", "league of legends", "valorant", "counter-strike", "dota", "esports"])) return "esports";
  if (match(text, ["fed", "inflation", "cpi", "rate cut", "stock", "nasdaq", "s&p", "dow", "earnings", "ipo", "fdv"])) return "finance";
  if (match(text, ["temperature", "weather", "hurricane", "snow", "rain", "wildfire"])) return "weather";
  if (match(text, ["movie", "album", "music", "box office", "oscars", "grammy", "celebrity", "taylor swift"])) return "culture";
  return "other";
}

function match(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { "User-Agent": "polymarket-research-lab/1.0" } });
    if (response.status === 422) return [] as T;
    if (response.status === 429) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`Gamma request failed ${response.status}: ${url}`);
    return (await response.json()) as T;
  }
  throw new Error(`Gamma request was rate limited: ${url}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function render(rows: Row[], args: Args): string {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    if (!buckets.has(row.category)) buckets.set(row.category, []);
    buckets.get(row.category)?.push(row);
  }

  const noWins = rows.filter((row) => row.winner === "no").length;
  const lines = [
    "# Nothing-ever-happens resolved-history check",
    "",
    `- Window: last ${args.lookbackHours} hours since ${args.minClosedTime.toISOString()}`,
    `- Markets: ${rows.length} resolved binary Yes/No markets`,
    `- NO resolved rate: ${pct(noWins, rows.length)} (${noWins}/${rows.length})`,
    "",
    "| Category | Markets | NO Rate | YES | NO |",
    "|---|---:|---:|---:|---:|",
  ];

  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [category, bucket] of sorted) {
    const bucketNo = bucket.filter((row) => row.winner === "no").length;
    lines.push(`| ${category} | ${bucket.length} | ${pct(bucketNo, bucket.length)} | ${bucket.length - bucketNo} | ${bucketNo} |`);
  }

  lines.push("", "## Recent examples");
  for (const row of rows.slice(0, 12)) {
    lines.push(`- ${row.closedTime.toISOString()} | ${row.category} | ${row.winner.toUpperCase()} | ${row.question}`);
  }

  return `${lines.join("\n")}\n`;
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "0.0%" : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await fetchClosedMarkets(args);
  console.log(render(rows, args));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
