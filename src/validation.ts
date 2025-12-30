import { config } from "./config";
import { getBook } from "./api/polymarket";
import { Candidate, Validated } from "./types";
import { avgFillPriceFromAsks } from "./utils/orderbook";
import { mapWithConcurrency } from "./utils/concurrency";

type BookCache = Record<string, Awaited<ReturnType<typeof getBook>>>;

export async function validateCandidates(
  cands: Candidate[],
  override = config,
): Promise<Validated[]> {
  if (!cands.length) return [];

  const tokenIds = Array.from(
    new Set<string>(cands.flatMap((c) => [c.tokenA, c.tokenB])),
  );

  const books: BookCache = {};
  const fetched = await mapWithConcurrency(
    tokenIds,
    override.bookWorkers,
    async (tid) => ({ tid, book: await getBook(tid) }),
  );
  for (const { tid, book } of fetched) books[tid] = book;

  const validated: Validated[] = [];
  for (const c of cands) {
    const b0 = books[c.tokenA];
    const b1 = books[c.tokenB];

    // If we cannot fetch both books, skip to avoid stale/no-book markets.
    if (!b0 || !b1) {
      continue;
    }

    let bookOk = false;
    let avgA: number | null = null;
    let avgB: number | null = null;
    let sizeCost: number | null = null;
    let sizeProfit: number | null = null;
    let sizeRoi: number | null = null;

    const fillA = avgFillPriceFromAsks(b0.asks ?? [], override.sizeUsdcPerSide);
    const fillB = avgFillPriceFromAsks(b1.asks ?? [], override.sizeUsdcPerSide);
    if (fillA && fillB) {
      avgA = fillA.avgPrice;
      avgB = fillB.avgPrice;
      sizeCost = avgA + avgB;
      sizeProfit = 1 - sizeCost;
      sizeRoi = sizeCost > 0 ? sizeProfit / sizeCost : 0;
      bookOk = sizeCost <= override.bookThreshold;
    } else {
      // If insufficient depth or missing book data, skip.
      continue;
    }

    validated.push({
      question: c.question,
      slug: c.slug,
      conditionId: c.conditionId,
      tokenA: c.tokenA,
      tokenB: c.tokenB,
      expiry: c.expiry,
      expiryTs: c.expiryTs,
      pA: c.pA,
      pB: c.pB,
      quickCost: c.totalCost,
      quickProfit: c.profit,
      quickRoi: c.roi,
      bookOk,
      avgA,
      avgB,
      sizeCost,
      sizeProfit,
      sizeRoi,
    });
  }

  return validated;
}
