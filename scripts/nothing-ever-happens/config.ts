type ParsedArgs = {
  [key: string]: string | boolean;
};

const HELP = `
Usage:
  bun run scripts/nothing-ever-happens/main.ts --csv <market-snapshots.csv> [options]

Options:
  --out <path>               Output report path (default: data/nothing-ever-happens-report.md)
  --cache <path>             Outcome cache path (default: data/market-outcome-cache.json)
  --side <yes|no>            Side to always bet (default: no)
  --stake <value>            Stake per trade in USDC (default: 10)
  --market-filter <regex>     Filter on title or slug (default: updown)
  --category <name>           Optional exact category filter (case-insensitive)
  --max-markets <n>          Max markets to evaluate after grouping
  --pause-ms <ms>            Pause between outcome lookups (default: 60)
  --dry-run                  Populate cache only, skip pnl calculation
  --help                     Show this help text
`.trim();

export function parseArgs(argv: string[]): {
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
} {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "dry-run" || key === "help") {
      args[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }

  if (args.help) {
    throw new Error(HELP);
  }

  const csv = String(args.csv || "");
  if (!csv) {
    throw new Error(`--csv is required\n\n${HELP}`);
  }

  const side = String(args.side ?? "no").toLowerCase();
  if (side !== "yes" && side !== "no") {
    throw new Error(`--side must be either yes or no, got ${String(side)}`);
  }

  const stake = Number(args.stake ?? 10);
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error(`--stake must be a positive number, got ${String(args.stake)}`);
  }

  const maxMarkets = Number(args.maxMarkets ?? args["max-markets"] ?? 0);
  if (!Number.isInteger(maxMarkets) || maxMarkets < 0) {
    throw new Error(`--max-markets must be a non-negative integer, got ${String(args["max-markets"] ?? args.maxMarkets)}`);
  }

  const pauseMs = Number(args.pauseMs ?? args["pause-ms"] ?? 60);
  if (!Number.isInteger(pauseMs) || pauseMs < 0) {
    throw new Error(`--pause-ms must be a non-negative integer, got ${String(args["pause-ms"] ?? args.pauseMs)}`);
  }

  const marketFilter = String(args.marketFilter ?? args["market-filter"] ?? "updown");
  const category = String(args.category ?? "");
  const out = String(args.out ?? "data/nothing-ever-happens-report.md");
  const cache = String(args.cache ?? "data/market-outcome-cache.json");
  const dryRun = Boolean(args.dryRun);

  return {
    csv,
    out,
    cache,
    side: side as "yes" | "no",
    stake,
    marketFilter,
    category,
    maxMarkets,
    pauseMs,
    dryRun,
  };
}

export function printHelp(): void {
  console.log(HELP);
}
