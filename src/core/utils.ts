/**
 * Shared utility functions for the poly-arb trading bot.
 */

/**
 * Extract market expiry timestamp from a slug.
 * @param slug - Market slug like "btc-updown-15m-1767170700"
 * @param timeframe - Market timeframe ("15m", "1h", "4h")
 * @returns Unix timestamp in milliseconds when market expires
 */
export function getMarketExpiry(slug: string, timeframe: string = "15m"): number {
  const match = slug.match(/-(\d{10})$/);
  if (match) {
    const startTs = parseInt(match[1], 10) * 1000;
    if (timeframe === "15m") return startTs + 15 * 60 * 1000;
    if (timeframe === "1h") return startTs + 60 * 60 * 1000;
    if (timeframe === "4h") return startTs + 4 * 60 * 60 * 1000;
    return startTs + 15 * 60 * 1000; // default 15m
  }
  // For 1h markets with human-readable slugs, estimate from current time
  if (timeframe === "1h") return Date.now() + 60 * 60 * 1000;
  if (timeframe === "4h") return Date.now() + 4 * 60 * 60 * 1000;
  return Date.now() + 15 * 60 * 1000; // fallback
}

/**
 * Format a timestamp as HH:MM:SS UTC string.
 * @param ts - Unix timestamp in milliseconds
 * @returns Formatted time string
 */
export function formatExpiry(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/**
 * Format a duration in milliseconds as human-readable string.
 * @param ms - Duration in milliseconds
 * @returns Formatted duration like "2h 15m 30s"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Clear the terminal screen.
 */
export function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[0f");
}

/**
 * Extract the crypto symbol from a market slug.
 * @param slug - Market slug like "btc-updown-15m-1767170700"
 * @returns Normalized symbol like "btc"
 */
export function extractSymbol(slug: string): string {
  const SYMBOL_NORMALIZE: Record<string, string> = {
    bitcoin: "btc",
    ethereum: "eth",
    solana: "sol",
  };
  const first = slug.split("-")[0] || "unknown";
  return SYMBOL_NORMALIZE[first] || first;
}

/**
 * Format a number as USD currency string.
 * @param value - Numeric value
 * @param showSign - Whether to show +/- sign
 * @returns Formatted string like "$+16.01" or "$-2.50"
 */
export function formatUSD(value: number, showSign: boolean = false): string {
  const sign = showSign && value >= 0 ? "+" : "";
  return `$${sign}${value.toFixed(2)}`;
}

/**
 * Format a percentage value.
 * @param value - Percentage value (e.g., 5.25 for 5.25%)
 * @param showSign - Whether to show +/- sign
 * @returns Formatted string like "+5.25%" or "-2.50%"
 */
export function formatPercent(value: number, showSign: boolean = false): string {
  const sign = showSign && value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
