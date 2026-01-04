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

// Tracks hits by time-to-expiration bucket (in minutes)
// Buckets: 0-5, 5-10, 10-15, 15-30, 30-60, 60+
export type TimeToExpiryHits = Record<number, Record<string, number>>; // threshold -> bucket -> count

// Tracks liquidity (USD available) at each threshold
export type ThresholdLiquidity = Record<number, { sumUsd: number; count: number; maxUsd: number }>;

// Tracks how often a single-leg ask breaches high price near expiry, bucketed by time-to-expiry
export type HighPriceExpiryHits = Record<number, Record<string, number>>; // threshold -> bucket -> count

// Momentum tracking: detect rapid price moves (spot-lag exploitation)
export interface MomentumEvent {
  side: "yes" | "no";
  startPrice: number;
  endPrice: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  priceChange: number;
  secondsToExpiry: number;
}

// Tracks momentum moves by price change bucket
export type MomentumStats = {
  // How often price moves from <threshold to >target within window
  moves: MomentumEvent[];
  // Aggregates
  count: number;
  avgDurationMs: number;
  avgPriceChange: number;
  maxPriceChange: number;
};

// Spot-lag correlation: tracks when external spot price moves before Polymarket adjusts
export interface SpotLagEvent {
  symbol: string; // e.g., "BTC", "ETH"
  spotDirection: "up" | "down";
  spotPctChange: number; // % change in spot price
  spotMoveStartTs: number;
  polymarketAdjustTs: number; // when Polymarket odds caught up
  lagMs: number; // delay between spot move and Polymarket adjustment
  polymarketStartPrice: number; // YES leg price before adjustment
  polymarketEndPrice: number; // YES leg price after adjustment
  polymarketPriceChange: number; // change in Polymarket odds
  profitable: boolean; // would entering on spot signal have been profitable?
}

// Tracks opportunity duration (how long combined price stays below threshold)
export type ThresholdDuration = Record<
  number,
  {
    sumMs: number;
    count: number;
    maxMs: number;
    minMs: number;
    samples: number[]; // capped rolling buffer of durations for p90/rolling metrics
  }
>;

// Active opportunity state for a market at a specific threshold
export interface ActiveOpportunity {
  startedAt: number; // timestamp when opportunity started
  threshold: number;
}

// Orderbook level
export interface OrderbookLevel {
  price: number;
  size: number; // shares
}

export interface StatsMarketTracker {
  market: MarketState;
  timeframe: string;
  expiresAt: number;
  updates: number;
  hits: ThresholdHits;
  priceSums: ThresholdPriceSums; // Track YES/NO prices when thresholds hit
  lastCombined: number;
  lastBookTs?: number;
  // Store full orderbook for liquidity analysis
  asksYes: OrderbookLevel[];
  asksNo: OrderbookLevel[];
  // Track active opportunities per threshold (for duration measurement)
  activeOpportunities: Map<number, number>; // threshold -> startedAt timestamp
  durations: ThresholdDuration; // per-market duration stats
  // Momentum tracking per leg
  momentumYes?: { startPrice: number; startTs: number } | null;
  momentumNo?: { startPrice: number; startTs: number } | null;
  priceHistoryYes: { price: number; ts: number }[];
  priceHistoryNo: { price: number; ts: number }[];
}
