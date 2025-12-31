import { describe, expect, test } from "bun:test";
import { get15mTimestamps, get4hTimestamps, formatHourET, generate1hSlugs } from "../../src/core/gamma";

describe("get15mTimestamps", () => {
  test("should return correct number of timestamps", () => {
    const timestamps = get15mTimestamps(3);
    expect(timestamps.length).toBe(3);
  });

  test("should return timestamps 15 minutes apart", () => {
    const timestamps = get15mTimestamps(3);
    const interval = 15 * 60; // 15 minutes in seconds

    expect(timestamps[1] - timestamps[0]).toBe(interval);
    expect(timestamps[2] - timestamps[1]).toBe(interval);
  });

  test("should return timestamps aligned to 15-minute windows", () => {
    const timestamps = get15mTimestamps(1);
    const interval = 15 * 60;

    // First timestamp should be divisible by 15 minutes
    expect(timestamps[0] % interval).toBe(0);
  });

  test("should return current or future timestamps", () => {
    const now = Math.floor(Date.now() / 1000);
    const timestamps = get15mTimestamps(3);

    // First timestamp should be within the current 15-min window
    expect(timestamps[0]).toBeLessThanOrEqual(now);
    expect(timestamps[0]).toBeGreaterThan(now - 15 * 60);
  });
});

describe("get4hTimestamps", () => {
  test("should return correct number of timestamps", () => {
    const timestamps = get4hTimestamps(3);
    // Returns count + 1 because it starts from i = -1
    expect(timestamps.length).toBe(4);
  });

  test("should return timestamps 4 hours apart", () => {
    const timestamps = get4hTimestamps(3);
    const interval = 4 * 60 * 60; // 4 hours in seconds

    expect(timestamps[1] - timestamps[0]).toBe(interval);
    expect(timestamps[2] - timestamps[1]).toBe(interval);
  });

  test("should return timestamps with 1-hour offset (01:00, 05:00, etc)", () => {
    const timestamps = get4hTimestamps(1);
    const offset = 1 * 60 * 60; // 1 hour offset
    const interval = 4 * 60 * 60;

    // Timestamp minus offset should be divisible by 4 hours
    expect((timestamps[0] - offset) % interval).toBe(0);
  });
});

describe("formatHourET", () => {
  test("should format midnight as 12am", () => {
    expect(formatHourET(0)).toBe("12am");
  });

  test("should format noon as 12pm", () => {
    expect(formatHourET(12)).toBe("12pm");
  });

  test("should format morning hours correctly", () => {
    expect(formatHourET(1)).toBe("1am");
    expect(formatHourET(9)).toBe("9am");
    expect(formatHourET(11)).toBe("11am");
  });

  test("should format afternoon/evening hours correctly", () => {
    expect(formatHourET(13)).toBe("1pm");
    expect(formatHourET(18)).toBe("6pm");
    expect(formatHourET(23)).toBe("11pm");
  });
});

describe("generate1hSlugs", () => {
  test("should generate slugs for all 4 crypto tickers", () => {
    const slugs = generate1hSlugs(1);

    // 4 tickers * (count + 2) slugs each (i goes from -1 to count-1)
    // With count=1, i goes -1, 0 = 2 iterations per ticker = 8 slugs
    expect(slugs.length).toBe(8);
  });

  test("should generate slugs with correct format", () => {
    const slugs = generate1hSlugs(1);

    // All slugs should match the pattern: name-up-or-down-month-day-hourXm-et
    for (const slug of slugs) {
      expect(slug).toMatch(/^(bitcoin|ethereum|xrp|solana)-up-or-down-[a-z]+-\d{1,2}-\d{1,2}(am|pm)-et$/);
    }
  });

  test("should include all expected crypto names", () => {
    const slugs = generate1hSlugs(1);
    const slugString = slugs.join(" ");

    expect(slugString).toContain("bitcoin");
    expect(slugString).toContain("ethereum");
    expect(slugString).toContain("xrp");
    expect(slugString).toContain("solana");
  });
});
