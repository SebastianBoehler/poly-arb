export interface ClobMarket {
  condition_id: string;
  tokens: { token_id: string; outcome: string }[];
  neg_risk: boolean;
  active: boolean;
  closed: boolean;
  question?: string;
  market_slug?: string;
}

export interface MarketState {
  slug: string;
  title: string;
  symbol: string;
  conditionId: string;
  tokenYes: string;
  tokenNo: string;
  bestAskYes: number;
  bestAskNo: number;
  totalCostYes: number;
  totalSharesYes: number;
  totalCostNo: number;
  totalSharesNo: number;
  ladderLevel: number;
  lastEntryCombined: number;
  entryCount: number;
  lowestCombined: number;
  highestCombined: number;
  priceUpdates: number;
}

export interface MarketMetrics {
  avgYes: number;
  avgNo: number;
  combined: number;
  payout: number;
  edge: number;
  edgePct: string;
  profitable: boolean;
}

export interface MarketTracker {
  market: MarketState;
  expiresAt: number;
}

export interface ClosedPosition {
  slug: string;
  title: string;
  symbol: string;
  closedAt: Date;
  entryCount: number;
  ladderLevel: number;
  avgYes: number;
  avgNo: number;
  combined: number;
  edge: number;
  edgePct: string;
  profitable: boolean;
  shares: number;
  totalCost: number;
  profit: number;
  profitPct: number;
}

export type ThresholdHits = Record<number, number>;

// Tracks sum of prices when threshold is hit, for computing averages
export type ThresholdPriceSums = Record<number, { sumYes: number; sumNo: number; count: number }>;

export interface StatsMarketTracker {
  market: MarketState;
  timeframe: string;
  expiresAt: number;
  updates: number;
  hits: ThresholdHits;
  priceSums: ThresholdPriceSums; // Track YES/NO prices when thresholds hit
  lastCombined: number;
}
