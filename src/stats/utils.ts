import type { HighPriceExpiryHits, LowPriceExpiryHits, ThresholdPriceSums, TimeToExpiryHits } from "../core/types";

// Time-to-expiry buckets in minutes
export const EXPIRY_BUCKETS = ["0-5", "5-10", "10-15", "15-30", "30-60", "60+"] as const;
// Finer buckets in seconds for near-expiry analysis
export const FINE_EXPIRY_BUCKETS = ["0-5s", "5-15s", "15-30s", "30-60s", "60-300s", "5-15m", "15-60m", "60+m"] as const;

export function getExpiryBucket(expiresAt: number): string {
  const now = Date.now();
  const minutesLeft = Math.max(0, (expiresAt - now) / 60000);

  if (minutesLeft <= 5) return "0-5";
  if (minutesLeft <= 10) return "5-10";
  if (minutesLeft <= 15) return "10-15";
  if (minutesLeft <= 30) return "15-30";
  if (minutesLeft <= 60) return "30-60";
  return "60+";
}

// Fine-grained bucket (seconds/minutes) for near-expiry single-leg pricing
export function getFineExpiryBucket(expiresAt: number): string {
  const now = Date.now();
  const secondsLeft = Math.max(0, (expiresAt - now) / 1000);

  if (secondsLeft <= 5) return "0-5s";
  if (secondsLeft <= 15) return "5-15s";
  if (secondsLeft <= 30) return "15-30s";
  if (secondsLeft <= 60) return "30-60s";
  if (secondsLeft <= 300) return "60-300s";
  if (secondsLeft <= 900) return "5-15m";
  if (secondsLeft <= 3600) return "15-60m";
  return "60+m";
}

export function bumpTimeToExpiryHits(combined: number, expiresAt: number, thresholds: number[], hits: TimeToExpiryHits): TimeToExpiryHits {
  const bucket = getExpiryBucket(expiresAt);
  for (const t of thresholds) {
    if (!hits[t]) hits[t] = {};
    if (!hits[t][bucket]) hits[t][bucket] = 0;
    if (combined <= t) {
      hits[t][bucket] += 1;
    }
  }
  return hits;
}

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

export function bumpHighPriceExpiryHits(bestAsk: number, expiresAt: number, thresholds: number[], hits: HighPriceExpiryHits): HighPriceExpiryHits {
  const bucket = getFineExpiryBucket(expiresAt);
  for (const t of thresholds) {
    if (!hits[t]) hits[t] = {};
    if (!hits[t][bucket]) hits[t][bucket] = 0;
    if (bestAsk >= t) {
      hits[t][bucket] += 1;
    }
  }
  return hits;
}

export function bumpLowPriceExpiryHits(bestAsk: number, expiresAt: number, thresholds: number[], hits: LowPriceExpiryHits): LowPriceExpiryHits {
  const bucket = getFineExpiryBucket(expiresAt);
  for (const t of thresholds) {
    if (!hits[t]) hits[t] = {};
    if (!hits[t][bucket]) hits[t][bucket] = 0;
    if (bestAsk <= t) {
      hits[t][bucket] += 1;
    }
  }
  return hits;
}
