import { describe, expect, it } from "bun:test";
import { avgFillPriceFromAsks, OrderLevel } from "./orderbook";

const sampleAsks: OrderLevel[] = [
  { price: 0.4, size: 100 },
  { price: 0.5, size: 50 },
];

describe("avgFillPriceFromAsks", () => {
  it("computes average price when depth is sufficient with partial last level", () => {
    const res = avgFillPriceFromAsks(sampleAsks, 30);
    expect(res).not.toBeNull();
    expect(res?.avgPrice).toBeCloseTo(0.4, 6);
    expect(res?.shares).toBeCloseTo(75, 6); // 30 / 0.4
  });

  it("returns null when depth is insufficient", () => {
    const res = avgFillPriceFromAsks(sampleAsks, 80); // total book cost is 65
    expect(res).toBeNull();
  });

  it("handles exact full level consumption", () => {
    const res = avgFillPriceFromAsks(sampleAsks, 65);
    expect(res).not.toBeNull();
    expect(res?.avgPrice).toBeCloseTo(65 / (100 + 50), 6);
    expect(res?.shares).toBeCloseTo(150, 6);
  });
});
