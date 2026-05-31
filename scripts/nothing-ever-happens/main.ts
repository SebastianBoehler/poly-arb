import { mkdirSync, writeFileSync } from "fs";
import { parseArgs, printHelp } from "./config";
import { renderMarkdown } from "./report";
import { saveCache } from "./storage";
import { runVerification } from "./verifier";

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid CLI arguments";
    if (message.includes("Usage:") || message.includes("--help")) {
      printHelp();
      process.exit(0);
    }
    console.error(message);
    printHelp();
    process.exit(1);
  }

  const start = Date.now();
  const { rows, counters, categoryBuckets, cache, evaluated } = await runVerification(args);
  const report = renderMarkdown(rows, args, counters, categoryBuckets);

  mkdirSync(args.out.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(args.out, report, "utf8");
  console.log(report);

  if (args.maxMarkets > 0 && evaluated >= args.maxMarkets) {
    console.log(`[info] Market cap reached (--max-markets=${args.maxMarkets})`);
  }

  saveCache(args.cache, cache);
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[done] Report saved to ${args.out} (${duration}s)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
