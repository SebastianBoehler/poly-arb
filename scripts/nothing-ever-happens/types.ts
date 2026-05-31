export type ScriptArgs = {
  csv: string;
  out: string;
  cache: string;
  side: "yes" | "no";
  stake: number;
  marketFilter: string;
  category: string;
  maxMarkets: number;
  pauseMs: number;
  dryRun: boolean;
};

export type MarketRow = {
  id: string;
  title: string;
  slug: string;
  category: string;
  [key: string]: string;
};

export type MarketEval = {
  marketId: string;
  title: string;
  slug: string;
  category: string;
  side: string;
  entryPrice: number;
  outcome: string | null;
  won: boolean;
  pnl: number;
  ret: number;
};

export type CategoryBuckets = Record<string, MarketEval[]>;

export type CounterMap = Record<string, number>;
