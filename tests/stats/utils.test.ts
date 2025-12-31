import { describe, expect, test } from "bun:test";
import { bumpThresholdHits, bumpThresholdPriceSums } from "../../src/stats/utils";
import type { ThresholdPriceSums } from "../../src/core/types";

describe("bumpThresholdHits", () => {
  test("should only increment thresholds where value <= threshold", () => {
    const hits: Record<number, number> = {};
    const thresholds = [0.9, 0.95, 1.0];

    bumpThresholdHits(0.92, thresholds, hits);

    // 0.92 > 0.9, so no increment (but initialized to 0)
    expect(hits[0.9]).toBe(0);
    // 0.92 <= 0.95, so increment
    expect(hits[0.95]).toBe(1);
    // 0.92 <= 1.0, so increment
    expect(hits[1.0]).toBe(1);
  });

  test("should accumulate hits correctly over multiple price samples", () => {
    const hits: Record<number, number> = {};
    const thresholds = [0.98, 0.99, 1.0];

    // Simulate streaming price data
    const priceSamples = [0.97, 0.985, 0.995, 1.01, 0.975];
    for (const price of priceSamples) {
      bumpThresholdHits(price, thresholds, hits);
    }

    // Count how many samples hit each threshold
    // <= 0.98: 0.97, 0.975 = 2
    expect(hits[0.98]).toBe(2);
    // <= 0.99: 0.97, 0.985, 0.975 = 3
    expect(hits[0.99]).toBe(3);
    // <= 1.0: 0.97, 0.985, 0.995, 0.975 = 4 (1.01 exceeds)
    expect(hits[1.0]).toBe(4);
  });

  test("should handle boundary case where value equals threshold exactly", () => {
    const hits: Record<number, number> = {};
    const thresholds = [0.99, 1.0];

    bumpThresholdHits(0.99, thresholds, hits);

    expect(hits[0.99]).toBe(1); // Exact match should count
    expect(hits[1.0]).toBe(1);
  });

  test("should handle value exceeding all thresholds", () => {
    const hits: Record<number, number> = {};
    const thresholds = [0.95, 0.98, 1.0];

    bumpThresholdHits(1.05, thresholds, hits);

    // All thresholds initialized but none incremented
    expect(hits[0.95]).toBe(0);
    expect(hits[0.98]).toBe(0);
    expect(hits[1.0]).toBe(0);
  });

  test("should handle value below all thresholds", () => {
    const hits: Record<number, number> = {};
    const thresholds = [0.95, 0.98, 1.0];

    bumpThresholdHits(0.9, thresholds, hits);

    // All thresholds should be hit
    expect(hits[0.95]).toBe(1);
    expect(hits[0.98]).toBe(1);
    expect(hits[1.0]).toBe(1);
  });

  test("should preserve existing hits when called with pre-populated object", () => {
    const hits: Record<number, number> = { 0.98: 5, 0.99: 10, 1.0: 15 };
    const thresholds = [0.98, 0.99, 1.0];

    bumpThresholdHits(0.97, thresholds, hits);

    expect(hits[0.98]).toBe(6);
    expect(hits[0.99]).toBe(11);
    expect(hits[1.0]).toBe(16);
  });

  test("should return the same hits object for chaining", () => {
    const hits: Record<number, number> = {};
    const thresholds = [1.0];

    const result = bumpThresholdHits(0.95, thresholds, hits);

    expect(result).toBe(hits);
    expect(result[1.0]).toBe(1);
  });

  test("should handle empty thresholds array gracefully", () => {
    const hits: Record<number, number> = {};
    const thresholds: number[] = [];

    const result = bumpThresholdHits(0.95, thresholds, hits);

    expect(Object.keys(result).length).toBe(0);
  });

  test("should work with realistic arbitrage threshold values", () => {
    const hits: Record<number, number> = {};
    // Real thresholds used in the stats module
    const thresholds = [0.9, 0.95, 0.98, 0.985, 0.99, 0.995, 1.0];

    // Simulate a market with combined price of 0.987 (profitable after fees)
    bumpThresholdHits(0.987, thresholds, hits);

    expect(hits[0.9]).toBe(0); // 0.987 > 0.9
    expect(hits[0.95]).toBe(0); // 0.987 > 0.95
    expect(hits[0.98]).toBe(0); // 0.987 > 0.98
    expect(hits[0.985]).toBe(0); // 0.987 > 0.985
    expect(hits[0.99]).toBe(1); // 0.987 <= 0.99
    expect(hits[0.995]).toBe(1); // 0.987 <= 0.995
    expect(hits[1.0]).toBe(1); // 0.987 <= 1.0
  });
});

describe("bumpThresholdPriceSums", () => {
  test("should track YES/NO prices when combined <= threshold", () => {
    const priceSums: ThresholdPriceSums = {};
    const thresholds = [0.95, 1.0];

    // Combined = 0.45 + 0.48 = 0.93, which is <= both thresholds
    bumpThresholdPriceSums(0.93, 0.45, 0.48, thresholds, priceSums);

    expect(priceSums[0.95].sumYes).toBe(0.45);
    expect(priceSums[0.95].sumNo).toBe(0.48);
    expect(priceSums[0.95].count).toBe(1);
    expect(priceSums[1.0].sumYes).toBe(0.45);
    expect(priceSums[1.0].sumNo).toBe(0.48);
    expect(priceSums[1.0].count).toBe(1);
  });

  test("should accumulate prices correctly over multiple samples", () => {
    const priceSums: ThresholdPriceSums = {};
    const thresholds = [0.98, 1.0];

    // Sample 1: combined = 0.96
    bumpThresholdPriceSums(0.96, 0.4, 0.56, thresholds, priceSums);
    // Sample 2: combined = 0.97
    bumpThresholdPriceSums(0.97, 0.5, 0.47, thresholds, priceSums);
    // Sample 3: combined = 0.99 (only hits 1.0 threshold)
    bumpThresholdPriceSums(0.99, 0.55, 0.44, thresholds, priceSums);

    // For 0.98 threshold: 2 samples (0.96, 0.97)
    expect(priceSums[0.98].count).toBe(2);
    expect(priceSums[0.98].sumYes).toBeCloseTo(0.9, 4); // 0.40 + 0.50
    expect(priceSums[0.98].sumNo).toBeCloseTo(1.03, 4); // 0.56 + 0.47

    // For 1.0 threshold: 3 samples
    expect(priceSums[1.0].count).toBe(3);
    expect(priceSums[1.0].sumYes).toBeCloseTo(1.45, 4); // 0.40 + 0.50 + 0.55
    expect(priceSums[1.0].sumNo).toBeCloseTo(1.47, 4); // 0.56 + 0.47 + 0.44
  });

  test("should compute correct averages from accumulated sums", () => {
    const priceSums: ThresholdPriceSums = {};
    const thresholds = [1.0];

    // Simulate 3 samples with different YES/NO splits
    bumpThresholdPriceSums(0.95, 0.3, 0.65, thresholds, priceSums);
    bumpThresholdPriceSums(0.94, 0.45, 0.49, thresholds, priceSums);
    bumpThresholdPriceSums(0.96, 0.6, 0.36, thresholds, priceSums);

    const avgYes = priceSums[1.0].sumYes / priceSums[1.0].count;
    const avgNo = priceSums[1.0].sumNo / priceSums[1.0].count;

    expect(avgYes).toBeCloseTo(0.45, 4); // (0.30 + 0.45 + 0.60) / 3
    expect(avgNo).toBeCloseTo(0.5, 4); // (0.65 + 0.49 + 0.36) / 3
  });

  test("should not track prices when combined > threshold", () => {
    const priceSums: ThresholdPriceSums = {};
    const thresholds = [0.95];

    // Combined = 0.98 > 0.95
    bumpThresholdPriceSums(0.98, 0.5, 0.48, thresholds, priceSums);

    // Should initialize but not increment
    expect(priceSums[0.95].count).toBe(0);
    expect(priceSums[0.95].sumYes).toBe(0);
    expect(priceSums[0.95].sumNo).toBe(0);
  });

  test("should help analyze 'buy below 50cts' rule", () => {
    const priceSums: ThresholdPriceSums = {};
    const thresholds = [0.98, 1.0];

    // Simulate opportunities where YES is cheap (< 0.50)
    bumpThresholdPriceSums(0.97, 0.35, 0.62, thresholds, priceSums);
    bumpThresholdPriceSums(0.96, 0.42, 0.54, thresholds, priceSums);
    // Simulate opportunities where NO is cheap (< 0.50)
    bumpThresholdPriceSums(0.97, 0.58, 0.39, thresholds, priceSums);
    bumpThresholdPriceSums(0.95, 0.55, 0.4, thresholds, priceSums);

    const avgYes = priceSums[0.98].sumYes / priceSums[0.98].count;
    const avgNo = priceSums[0.98].sumNo / priceSums[0.98].count;

    // Average YES price across all opportunities
    expect(avgYes).toBeCloseTo(0.475, 3); // (0.35 + 0.42 + 0.58 + 0.55) / 4
    // Average NO price across all opportunities
    expect(avgNo).toBeCloseTo(0.4875, 3); // (0.62 + 0.54 + 0.39 + 0.40) / 4
  });
});
