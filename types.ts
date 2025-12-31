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
