import type { ScriptArgs, CategoryBuckets, CounterMap, MarketEval } from "./types";

function safePct(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderCategoryTable(categoryBuckets: CategoryBuckets): string[] {
  const lines = [
    "## Performance by category",
    "",
    "| Category | Markets | Win Rate | Total PnL | Avg PnL | Avg Return | Avg Entry |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  const entries = Object.entries(categoryBuckets);
  if (entries.length === 0) {
    lines.push("No category data for this filtered set.");
    lines.push("");
    return lines;
  }

  const ordered = entries.sort((a, b) => b[1].length - a[1].length);
  for (const [category, rows] of ordered) {
    if (rows.length === 0) continue;
    const total = rows.length;
    const wins = rows.filter((item) => item.won).length;
    const avgEntry = mean(rows.map((item) => item.entryPrice));
    const avgReturn = mean(rows.map((item) => item.ret));
    const totalPnl = rows.reduce((sum, item) => sum + item.pnl, 0);
    const avgPnl = totalPnl / total;
    const winRate = safePct(wins, total);

    lines.push(
      `| \`${category}\` | ${total} | ${winRate.toFixed(1)}% | ${totalPnl.toFixed(2)} | ${avgPnl.toFixed(2)} | ${avgReturn.toFixed(2)}% | ${avgEntry.toFixed(4)} |`
    );
  }

  lines.push("");
  return lines;
}

export function renderMarkdown(
  results: MarketEval[],
  args: ScriptArgs,
  counters: CounterMap,
  categoryBuckets: CategoryBuckets,
): string {
  if (results.length === 0) {
    return "# Nothing-ever-happens strategy check\n\nNo resolved markets met filters.\n";
  }

  const wins = results.filter((item) => item.won).length;
  const winRate = safePct(wins, results.length);
  const avgRet = mean(results.map((item) => item.ret));
  const totalPnl = results.reduce((sum, item) => sum + item.pnl, 0);
  const avgPnl = results.length > 0 ? totalPnl / results.length : 0;
  const avgEntry = mean(results.map((item) => item.entryPrice));

  const lines = [
    "# Nothing-ever-happens strategy check",
    "",
    `- Side tested: \`${args.side.toUpperCase()}\``,
    `- Category filter: \`${args.category || "all"}\``,
    `- Evaluated markets: \`${results.length}\``,
    `- Win rate: \`${winRate.toFixed(2)}%\` (${wins}/${results.length})`,
    `- Total PnL (fixed ${args.stake.toFixed(2)} USDC each): \`${totalPnl.toFixed(2)}\``,
    `- Avg PnL per trade: \`${avgPnl.toFixed(2)}\``,
    `- Avg return: \`${avgRet.toFixed(2)}%\``,
    `- Avg entry price: \`${avgEntry.toFixed(4)}\``,
    "",
    `- Skipped (filter): \`${counters.filtered}\``,
    `- Skipped (category filter): \`${counters.category_filtered}\``,
    `- Skipped (invalid entry): \`${counters.invalid_entry}\``,
    `- Skipped (unresolved/not available): \`${counters.unresolved}\``,
    "",
    ...renderCategoryTable(categoryBuckets),
    "## Top and bottom outcomes",
  ];

  const sorted = [...results].sort((a, b) => b.ret - a.ret);
  for (const item of sorted.slice(0, 10)) {
    const status = item.won ? "✅" : "❌";
    lines.push(
      `${status} ${item.side.toUpperCase()} on ${item.slug || item.marketId} | entry ${item.entryPrice.toFixed(4)} | category ${item.category} | outcome ${item.outcome} | pnl ${item.pnl.toFixed(2)} (${item.ret.toFixed(2)}%)`
    );
  }

  lines.push("\n## Worst outcomes");
  for (const item of sorted.slice(-10).reverse()) {
    const status = item.won ? "✅" : "❌";
    lines.push(
      `${status} ${item.side.toUpperCase()} on ${item.slug || item.marketId} | entry ${item.entryPrice.toFixed(4)} | category ${item.category} | outcome ${item.outcome} | pnl ${item.pnl.toFixed(2)} (${item.ret.toFixed(2)}%)`
    );
  }

  return `${lines.join("\n")}\n`;
}
