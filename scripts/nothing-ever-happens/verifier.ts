import { loadRows, groupRowsByMarket, numberAt, readCache } from "./storage";
import { fetchOutcome } from "./outcome-api";
import type {
  ScriptArgs,
  CategoryBuckets,
  CounterMap,
  MarketEval,
  MarketRow,
} from "./types";

export async function runVerification(
  args: ScriptArgs,
): Promise<{
  rows: MarketEval[];
  counters: CounterMap;
  evaluated: number;
  categoryBuckets: CategoryBuckets;
  cache: ReturnType<typeof readCache>;
}> {
  const rows = loadRows(args.csv);
  const grouped = groupRowsByMarket(rows);
  const cache = readCache(args.cache);

  const regex = args.marketFilter ? new RegExp(args.marketFilter, "i") : null;
  const categoryFilter = args.category.trim().toLowerCase();

  const buckets: CategoryBuckets = {};
  const counters: CounterMap = {
    filtered: 0,
    category_filtered: 0,
    invalid_entry: 0,
    unresolved: 0,
    resolved: 0,
  };

  const evaluations: MarketEval[] = [];
  let evaluated = 0;

  for (const [marketId, marketRows] of grouped.entries()) {
    const first = marketRows[0];
    if (!first) continue;
    if (!passesFilters(first, regex, categoryFilter)) {
      if (categoryFilter && first.category?.trim().toLowerCase() !== categoryFilter) {
        counters.category_filtered += 1;
      } else {
        counters.filtered += 1;
      }
      continue;
    }

    const entry = numberAt(first, `${args.side}_price`);
    if (entry <= 0 || entry >= 1) {
      counters.invalid_entry += 1;
      continue;
    }

    const { outcome } = await fetchOutcome(first, cache, args.pauseMs);
    if (!outcome) {
      counters.unresolved += 1;
      continue;
    }

    const won = outcome === args.side;
    const pnl = args.dryRun ? 0 : won ? args.stake / entry - args.stake : -args.stake;
    const ret = args.dryRun ? 0 : (pnl / args.stake) * 100;

    const evalRow: MarketEval = {
      marketId,
      title: first.title,
      slug: first.slug,
      category: (first.category || "uncategorized").trim(),
      side: args.side,
      entryPrice: entry,
      outcome,
      won,
      pnl,
      ret,
    };

    evaluations.push(evalRow);
    const category = evalRow.category || "uncategorized";
    if (!buckets[category]) buckets[category] = [];
    buckets[category].push(evalRow);
    evaluated += 1;
    counters.resolved += 1;

    if (args.maxMarkets > 0 && evaluated >= args.maxMarkets) break;
  }

  return { rows: evaluations, counters, evaluated, categoryBuckets: buckets, cache };
}

function passesFilters(
  row: MarketRow,
  regex: RegExp | null,
  categoryFilter: string,
): boolean {
  if (regex) {
    const matched = regex.test(row.title) || regex.test(row.slug);
    if (!matched) return false;
  }

  if (categoryFilter && row.category?.trim().toLowerCase() !== categoryFilter) {
    return false;
  }

  return true;
}
