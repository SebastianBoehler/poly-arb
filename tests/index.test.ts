import { test, expect } from "bun:test";
import { tryEntry } from "../src/index";
import type { MarketState } from "../src/core/types";

function makeMarketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    slug: "test",
    title: "test",
    symbol: "test",
    conditionId: "cond",
    tokenYes: "yes",
    tokenNo: "no",
    bestAskYes: 0,
    bestAskNo: 0,
    totalCostYes: 0,
    totalSharesYes: 0,
    totalCostNo: 0,
    totalSharesNo: 0,
    ladderLevel: 0,
    lastEntryCombined: 0,
    entryCount: 0,
    lowestCombined: Infinity,
    highestCombined: -Infinity,
    priceUpdates: 0,
    ...overrides,
  };
}

test("first entry triggers when combined <= maxInitialCombined", () => {
  const m = makeMarketState({ bestAskYes: 0.48, bestAskNo: 0.5 });
  tryEntry(m);
  expect(m.entryCount).toBe(1);
  expect(m.ladderLevel).toBe(1);
  expect(m.lastEntryCombined).toBeCloseTo(0.98, 5);
  expect(m.totalSharesYes).toBeGreaterThan(0);
  expect(m.totalSharesNo).toBeGreaterThan(0);
});

test("first entry blocked when combined above maxInitialCombined", () => {
  const m = makeMarketState({ bestAskYes: 0.52, bestAskNo: 0.5 });
  tryEntry(m);
  expect(m.entryCount).toBe(0);
  expect(m.ladderLevel).toBe(0);
});

test("reload triggers when combined improves and under reload threshold", () => {
  const m = makeMarketState({
    entryCount: 1,
    ladderLevel: 1,
    lastEntryCombined: 0.99,
    bestAskYes: 0.49,
    bestAskNo: 0.49, // combined 0.98: improvement 0.01, below reloadThreshold 0.995
  });
  tryEntry(m);
  expect(m.entryCount).toBe(2);
  expect(m.ladderLevel).toBe(2);
  expect(m.lastEntryCombined).toBeCloseTo(0.98, 5);
});

test("reload blocked if improvement is too small", () => {
  const m = makeMarketState({
    entryCount: 1,
    ladderLevel: 1,
    lastEntryCombined: 0.99,
    bestAskYes: 0.495,
    bestAskNo: 0.494, // combined 0.989: improvement 0.001 (< minImprovement 0.002)
  });
  tryEntry(m);
  expect(m.entryCount).toBe(1);
  expect(m.ladderLevel).toBe(1);
});

test("reload blocked if combined is worse than last fill or above reload threshold", () => {
  const m = makeMarketState({
    entryCount: 1,
    ladderLevel: 1,
    lastEntryCombined: 0.99,
    bestAskYes: 0.52,
    bestAskNo: 0.5, // combined 1.02: above reloadThreshold
  });
  tryEntry(m);
  expect(m.entryCount).toBe(1);
  expect(m.ladderLevel).toBe(1);
});
