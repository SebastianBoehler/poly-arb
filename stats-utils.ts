export function bumpThresholdHits(value: number, thresholds: number[], hits: Record<number, number>): Record<number, number> {
  for (const t of thresholds) {
    hits[t] = hits[t] ?? 0;
    if (value <= t) {
      hits[t] += 1;
    }
  }
  return hits;
}
