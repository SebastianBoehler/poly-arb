export type MarketToken = {
  token_id?: string;
  asset_id?: string;
};

export type Market = {
  question?: string;
  market_slug?: string;
  condition_id?: string;
  tokens?: MarketToken[];
  [key: string]: unknown;
};

export type PriceResponse = {
  price?: number | string;
};

export type OrderLevel = {
  price: number | string;
  size: number | string;
};

export type BookResponse = {
  asks?: OrderLevel[];
};

export type Candidate = {
  question: string;
  slug: string;
  conditionId: string;
  tokenA: string;
  tokenB: string;
  expiry: string;
  expiryTs: number | null;
  pA: number;
  pB: number;
  totalCost: number;
  profit: number;
  roi: number;
};

export type Validated = {
  question: string;
  slug: string;
  conditionId: string;
  tokenA: string;
  tokenB: string;
  expiry: string;
  expiryTs: number | null;
  pA: number;
  pB: number;
  quickCost: number;
  quickProfit: number;
  quickRoi: number;
  bookOk: boolean;
  avgA: number | null;
  avgB: number | null;
  sizeCost: number | null;
  sizeProfit: number | null;
  sizeRoi: number | null;
};

export type Config = {
  apiBase: string;
  chainId: number;
  maxPages: number;
  binaryPerPageCap: number;
  shortlistPerPage: number;
  topPrint: number;
  sizeUsdcPerSide: number;
  discoveryThreshold: number;
  bookThreshold: number;
  requestTimeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  priceWorkers: number;
  bookWorkers: number;
  sleepBetweenPagesMs: number;
  priceBatchSize: number;
};
