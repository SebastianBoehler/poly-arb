import { describe, test, expect } from "bun:test";
import {
  findCrossMarketPairs,
  computeCategoryStats,
  type NormalizedMarket,
} from "../../src/services/market-data";

function makeMarket(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    platform: "polymarket",
    id: "test-id",
    title: "Test Market",
    category: "crypto",
    tags: ["crypto"],
    slug: "test-market",
    yesPrice: 0.5,
    noPrice: 0.5,
    spread: 0,
    volume: 1000,
    liquidity: 500,
    endDate: null,
    active: true,
    url: "https://example.com",
    ...overrides,
  };
}

describe("findCrossMarketPairs", () => {
  test("should find matching markets by title similarity", () => {
    const pm = [makeMarket({ platform: "polymarket", title: "Will Bitcoin reach 100k by end of 2025", yesPrice: 0.6 })];
    const kalshi = [makeMarket({ platform: "kalshi", title: "Bitcoin reach 100k end 2025", yesPrice: 0.55 })];

    const pairs = findCrossMarketPairs(pm, kalshi, 0.3);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].similarity).toBeGreaterThan(0.3);
  });

  test("should not match unrelated markets", () => {
    const pm = [makeMarket({ platform: "polymarket", title: "Will Bitcoin reach 100k" })];
    const kalshi = [makeMarket({ platform: "kalshi", title: "NFL Super Bowl winner 2025" })];

    const pairs = findCrossMarketPairs(pm, kalshi, 0.4);
    expect(pairs.length).toBe(0);
  });

  test("should detect arb opportunity when cross-combined < 1", () => {
    const pm = [makeMarket({ platform: "polymarket", title: "Bitcoin 100k 2025", yesPrice: 0.55, noPrice: 0.42 })];
    const kalshi = [makeMarket({ platform: "kalshi", title: "Bitcoin 100k 2025", yesPrice: 0.50, noPrice: 0.45 })];

    const pairs = findCrossMarketPairs(pm, kalshi, 0.3);
    expect(pairs.length).toBeGreaterThan(0);

    // Cross combined: min(0.55 + 0.45, 0.42 + 0.50) = min(1.00, 0.92) = 0.92
    // arbEdge = 1 - 0.92 = 0.08
    const pair = pairs[0];
    expect(pair.arbEdge).toBeGreaterThan(0.02);
    expect(pair.arbOpportunity).toBe(true);
  });

  test("should not flag arb when prices are aligned", () => {
    const pm = [makeMarket({ platform: "polymarket", title: "Bitcoin 100k 2025", yesPrice: 0.60, noPrice: 0.40 })];
    const kalshi = [makeMarket({ platform: "kalshi", title: "Bitcoin 100k 2025", yesPrice: 0.60, noPrice: 0.40 })];

    const pairs = findCrossMarketPairs(pm, kalshi, 0.3);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].arbOpportunity).toBe(false);
  });

  test("should sort by arbEdge descending", () => {
    const pm = [
      makeMarket({ platform: "polymarket", id: "a", title: "Event A 2025", yesPrice: 0.55, noPrice: 0.42 }),
      makeMarket({ platform: "polymarket", id: "b", title: "Event B 2025", yesPrice: 0.50, noPrice: 0.40 }),
    ];
    const kalshi = [
      makeMarket({ platform: "kalshi", id: "a", title: "Event A 2025", yesPrice: 0.50, noPrice: 0.45 }),
      makeMarket({ platform: "kalshi", id: "b", title: "Event B 2025", yesPrice: 0.48, noPrice: 0.42 }),
    ];

    const pairs = findCrossMarketPairs(pm, kalshi, 0.3);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].arbEdge).toBeGreaterThanOrEqual(pairs[i].arbEdge);
    }
  });
});

describe("computeCategoryStats", () => {
  test("should group markets by platform and category", () => {
    const markets = [
      makeMarket({ platform: "polymarket", category: "crypto", volume: 1000, spread: 0.02 }),
      makeMarket({ platform: "polymarket", category: "crypto", volume: 2000, spread: 0.03 }),
      makeMarket({ platform: "polymarket", category: "politics", volume: 500, spread: 0.05 }),
      makeMarket({ platform: "kalshi", category: "politics", volume: 800, spread: 0.04 }),
    ];

    const stats = computeCategoryStats(markets);
    expect(stats.length).toBe(3); // pm:crypto, pm:politics, kalshi:politics

    const pmCrypto = stats.find((s) => s.platform === "polymarket" && s.category === "crypto");
    expect(pmCrypto).toBeDefined();
    expect(pmCrypto!.count).toBe(2);
    expect(pmCrypto!.totalVolume).toBe(3000);
    expect(pmCrypto!.avgSpread).toBeCloseTo(0.025, 3);
  });

  test("should sort by total volume descending", () => {
    const markets = [
      makeMarket({ category: "low-vol", volume: 100, spread: 0.01 }),
      makeMarket({ category: "high-vol", volume: 10000, spread: 0.01 }),
    ];

    const stats = computeCategoryStats(markets);
    expect(stats[0].category).toBe("high-vol");
  });

  test("should handle empty input", () => {
    const stats = computeCategoryStats([]);
    expect(stats.length).toBe(0);
  });
});
