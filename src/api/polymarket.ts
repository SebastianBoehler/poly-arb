import { config } from "../config";
import { BookResponse, Market, PriceResponse } from "../types";
import { ClobClient, Side } from "@polymarket/clob-client";

const clob = new ClobClient(config.apiBase, config.chainId);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getMarketsPage(
  nextCursor = "",
): Promise<{ data: Market[]; next_cursor?: string } | null> {
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const res: any = await clob.getMarkets(nextCursor || undefined);
      const data: Market[] =
        res?.data ?? res?.markets ?? res?.simplifiedMarkets ?? [];
      const next_cursor = res?.next_cursor ?? res?.nextCursor;
      return { data, next_cursor };
    } catch (err) {
      if (attempt < config.retries) {
        await sleep(config.backoffBaseMs * Math.pow(2, attempt));
      } else {
        return null;
      }
    }
  }
  return null;
}

export async function getBestBuyPrice(tokenId: string): Promise<number | null> {
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const res: any = await clob.getPrice(tokenId, "buy");
      if (!res || res.price == null) return null;
      const num = Number(res.price);
      return Number.isFinite(num) ? num : null;
    } catch (err) {
      if (attempt < config.retries) {
        await sleep(config.backoffBaseMs * Math.pow(2, attempt));
      } else {
        return null;
      }
    }
  }
  return null;
}

export async function getBestBuyPricesBatch(
  tokenIds: string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  if (!tokenIds.length) return out;
  // Split into batches to respect rate limits
  for (let i = 0; i < tokenIds.length; i += config.priceBatchSize) {
    const batch = tokenIds.slice(i, i + config.priceBatchSize);
    try {
      const res: any = await clob.getPrices(
        batch.map((tid) => ({ token_id: tid, side: Side.BUY })),
      );
      if (Array.isArray(res)) {
        res.forEach((r: any, idx: number) => {
          const tid = batch[idx];
          const num = Number(r?.price);
          out[tid] = Number.isFinite(num) ? num : null;
        });
      }
    } catch (err) {
      // Fallback: best effort per token for this batch
      for (const tid of batch) {
        out[tid] = await getBestBuyPrice(tid);
      }
    }
  }
  return out;
}

export async function getBook(tokenId: string): Promise<BookResponse | null> {
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const res: any = await clob.getOrderBook(tokenId);
      const asks = res?.asks?.map((a: any) => ({
        price: a.price ?? a.p ?? a[0],
        size: a.size ?? a.s ?? a[1],
      }));
      return { asks };
    } catch (err) {
      if (attempt < config.retries) {
        await sleep(config.backoffBaseMs * Math.pow(2, attempt));
      } else {
        return null;
      }
    }
  }
  return null;
}
