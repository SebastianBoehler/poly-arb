import type { ThresholdPriceSums } from "../core/types";

export function bumpThresholdHits(value: number, thresholds: number[], hits: Record<number, number>): Record<number, number> {
  for (const t of thresholds) {
    hits[t] = hits[t] ?? 0;
    if (value <= t) {
      hits[t] += 1;
    }
  }
  return hits;
}

export function bumpThresholdPriceSums(
  combined: number,
  yesPrice: number,
  noPrice: number,
  thresholds: number[],
  priceSums: ThresholdPriceSums
): ThresholdPriceSums {
  for (const t of thresholds) {
    if (!priceSums[t]) {
      priceSums[t] = { sumYes: 0, sumNo: 0, count: 0 };
    }
    if (combined <= t) {
      priceSums[t].sumYes += yesPrice;
      priceSums[t].sumNo += noPrice;
      priceSums[t].count += 1;
    }
  }
  return priceSums;
}
