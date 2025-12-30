import { config } from "./config";
import { getBestBuyPrice, getBestBuyPricesBatch } from "./api/polymarket";
import { Candidate, Market } from "./types";
import { pickExpiryField, pickExpiryTs } from "./utils/expiry";
import { mapWithConcurrency } from "./utils/concurrency";

type BinaryMarket = {
  market: Market;
  tokenA: string;
  tokenB: string;
};

function isEligible(m: Market) {
  // Skip inactive/closed or order-book-disabled markets
  if (m.enable_order_book === false) return false;
  if (m.active === false) return false;
  if (m.closed === true) return false;
  // Skip markets with known past expiry
  const expiryTs = pickExpiryTs(m);
  if (expiryTs !== null && expiryTs < Date.now()) return false;
  return true;
}

function extractBinaryMarkets(markets: Market[], cap: number): BinaryMarket[] {
  const binaries: BinaryMarket[] = [];
  for (const m of markets) {
    if (!isEligible(m)) continue;
    const tokens = m.tokens || [];
    if (tokens.length !== 2) continue;
    const t0 = tokens[0]?.token_id ?? tokens[0]?.asset_id;
    const t1 = tokens[1]?.token_id ?? tokens[1]?.asset_id;
    if (!t0 || !t1) continue;
    binaries.push({ market: m, tokenA: String(t0), tokenB: String(t1) });
    if (binaries.length >= cap) break;
  }
  return binaries;
}

const priceCache = new Map<string, number | null>();

async function getPriceCached(tokenId: string): Promise<number | null> {
  if (priceCache.has(tokenId)) return priceCache.get(tokenId) ?? null;
  const p = await getBestBuyPrice(tokenId);
  priceCache.set(tokenId, p);
  return p;
}

export async function discoverCandidates(
  markets: Market[],
  override = config,
): Promise<Candidate[]> {
  const binaries = extractBinaryMarkets(markets, override.binaryPerPageCap);
  if (!binaries.length) return [];

  // Fetch prices once per unique token to reduce request volume.
  const uniqueTokens = Array.from(
    new Set<string>(binaries.flatMap((b) => [b.tokenA, b.tokenB])),
  );
  console.log(
    `    discovery: eligible_binaries=${binaries.length} unique_tokens=${uniqueTokens.length}`,
  );
  const priceMap: Record<string, number | null> = {};
  // Batch first to avoid rate limits
  const batched = await getBestBuyPricesBatch(uniqueTokens);
  Object.assign(priceMap, batched);
  // Fill any missing via cached single fetch
  const missing = uniqueTokens.filter((t) => !(t in priceMap));
  await mapWithConcurrency(missing, override.priceWorkers, async (tid) => {
    priceMap[tid] = await getPriceCached(tid);
  });
  const resolvedPrices = uniqueTokens.filter((t) => priceMap[t] != null).length;
  console.log(
    `    discovery: price_hits=${resolvedPrices}/${uniqueTokens.length}`,
  );

  const candidates: Candidate[] = [];
  binaries.forEach(({ market, tokenA, tokenB }) => {
    const pA = priceMap[tokenA];
    const pB = priceMap[tokenB];
    if (pA == null || pB == null) return;
    const total = pA + pB;
    if (total > override.discoveryThreshold) return;

    const profit = 1 - total;
    const roi = total > 0 ? profit / total : 0;
    candidates.push({
      question: market.question ?? "",
      slug: market.market_slug ?? "",
      conditionId: market.condition_id ?? "",
      tokenA,
      tokenB,
      expiry: pickExpiryField(market),
      expiryTs: pickExpiryTs(market),
      pA,
      pB,
      totalCost: total,
      profit,
      roi,
    });
  });

  candidates.sort((a, b) => b.roi - a.roi || b.profit - a.profit);
  return candidates;
}
