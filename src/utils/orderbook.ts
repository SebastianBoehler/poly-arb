export type OrderLevel = {
  price: number | string;
  size: number | string;
};

export type AvgFill = {
  avgPrice: number;
  shares: number;
};

/**
 * Walk asks to spend `notionalUsdc`. Returns avg fill price and shares bought,
 * or null if insufficient depth.
 */
export function avgFillPriceFromAsks(
  asks: OrderLevel[],
  notionalUsdc: number,
): AvgFill | null {
  if (!asks.length || notionalUsdc <= 0) return null;

  let remaining = notionalUsdc;
  let cost = 0;
  let shares = 0;

  for (const lvl of asks) {
    const p = Number(lvl.price);
    const sz = Number(lvl.size);
    if (!Number.isFinite(p) || !Number.isFinite(sz) || p <= 0 || sz <= 0) {
      continue;
    }

    const lvlCost = p * sz;
    if (lvlCost <= remaining + 1e-12) {
      cost += lvlCost;
      shares += sz;
      remaining -= lvlCost;
      if (remaining <= 1e-9) break;
    } else {
      const takeShares = remaining / p;
      cost += remaining;
      shares += takeShares;
      remaining = 0;
      break;
    }
  }

  if (remaining > 1e-6 || shares <= 0) return null;
  return { avgPrice: cost / shares, shares };
}
