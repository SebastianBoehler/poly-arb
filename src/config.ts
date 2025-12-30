import { Config } from "./types";

const numFromEnv = (name: string): number | undefined => {
  const val = process.env[name];
  if (!val) return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
};

const withDefault = (envName: string, fallback: number) =>
  numFromEnv(envName) ?? fallback;

export const config: Config = {
  apiBase: process.env.API_BASE || "https://clob.polymarket.com",
  chainId: withDefault("CHAIN_ID", 137),
  maxPages: withDefault("MAX_PAGES", 1000),
  binaryPerPageCap: withDefault("BINARY_PER_PAGE_CAP", 500),
  shortlistPerPage: withDefault("SHORTLIST_PER_PAGE", 120),
  topPrint: withDefault("TOP_PRINT", 3),
  sizeUsdcPerSide: withDefault("SIZE_USDC_PER_SIDE", 100),
  discoveryThreshold: withDefault("DISCOVERY_THRESHOLD", 0.995),
  bookThreshold: withDefault("BOOK_THRESHOLD", 0.9999),
  requestTimeoutMs: withDefault("REQUEST_TIMEOUT_MS", 10_000),
  retries: withDefault("RETRIES", 2),
  backoffBaseMs: withDefault("BACKOFF_BASE_MS", 250),
  priceWorkers: withDefault("PRICE_WORKERS", 40),
  bookWorkers: withDefault("BOOK_WORKERS", 8),
  sleepBetweenPagesMs: withDefault("SLEEP_BETWEEN_PAGES_MS", 50),
  priceBatchSize: withDefault("PRICE_BATCH_SIZE", 50),
};
