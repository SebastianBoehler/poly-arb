import { config } from "./config";
import { getMarketsPage } from "./api/polymarket";
import { discoverCandidates } from "./discovery";
import { validateCandidates } from "./validation";
import { Validated } from "./types";
import fs from "fs";
import path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rankKey(v: Validated) {
  const roi = v.sizeRoi ?? v.quickRoi;
  const profit = v.sizeProfit ?? v.quickProfit;
  const cost = v.sizeCost ?? v.quickCost;
  const expiryTs = v.expiryTs ?? Infinity;
  // Sort by ROI desc, profit desc, sooner expiry, then cheapest cost
  return [roi, profit, -expiryTs, -cost] as const;
}

function isProfitable(v: Validated) {
  if (v.sizeCost != null) return v.sizeCost < 1;
  return v.quickCost < 1;
}

function printSummary(validated: Validated[]) {
  console.log(`\nDONE`);
  console.log(`total_validated_records=${validated.length}`);
  console.log(`Printing top ${config.topPrint}`);
  console.log("-".repeat(80));

  validated.slice(0, config.topPrint).forEach((v) => {
    const dispRoi = v.sizeRoi ?? v.quickRoi;
    const dispProfit = v.sizeProfit ?? v.quickProfit;
    const dispCost = v.sizeCost ?? v.quickCost;
    const legs =
      v.bookOk && v.avgA != null && v.avgB != null
        ? `legs(size_avg)=${v.avgA.toFixed(5)}+${v.avgB.toFixed(5)}`
        : `legs(quick)=${v.pA.toFixed(5)}+${v.pB.toFixed(5)}`;
    const bookTag = `book_ok=${v.bookOk}`;

    console.log(
      `ROI=${(dispRoi * 100).toFixed(2).padStart(6, " ")}% | profit=${
        dispProfit >= 0 ? "+" : ""
      }${dispProfit.toFixed(5)} | ` +
        `cost=${dispCost.toFixed(5)} | ${bookTag} | ${v.expiry}\n` +
        `  ${legs}\n` +
        `  ${v.question}\n` +
        `  slug=${v.slug} condition_id=${v.conditionId}\n`,
    );
  });
}

async function main() {
  console.log("Starting 2-stage scan…");
  let nextCursor = "";
  let totalScanned = 0;
  const validatedAll: Validated[] = [];

  for (let page = 1; page <= config.maxPages; page++) {
    const resp = await getMarketsPage(nextCursor);
    if (!resp) {
      console.error(`Page ${page}: failed to fetch markets`);
      break;
    }

    const markets = resp.data ?? [];
    nextCursor = resp.next_cursor ?? "";

    console.log(
      `Page ${page}: markets=${markets.length} next_cursor=${JSON.stringify(
        nextCursor,
      )}`,
    );
    if (!markets.length) break;

    totalScanned += markets.length;

    // Stage 1: discovery
    const cands = await discoverCandidates(markets, config);
    console.log(
      `  discovered_candidates=${cands.length} (threshold=${config.discoveryThreshold})`,
    );

    const shortlist = cands.slice(0, config.shortlistPerPage);
    console.log(
      `  validating_with_books=${shortlist.length} (size=${config.sizeUsdcPerSide} per side)`,
    );

    // Stage 2: validation
    const validated = await validateCandidates(shortlist, config);
    validatedAll.push(...validated);

    console.log(`  page_done. accumulated_validated=${validatedAll.length}`);

    if (!nextCursor || nextCursor === "LTE=") break;
    await sleep(config.sleepBetweenPagesMs);
  }

  const profitable = validatedAll.filter(isProfitable);
  console.log(
    `Profitable candidates (cost < 1): ${profitable.length}/${validatedAll.length}`,
  );

  profitable.sort((a, b) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    if (ka[0] !== kb[0]) return kb[0] - ka[0];
    if (ka[1] !== kb[1]) return kb[1] - ka[1];
    return kb[2] - ka[2];
  });

  printSummary(profitable);

  // Persist top results for inspection
  try {
    const outDir = path.join(process.cwd(), "output");
    fs.mkdirSync(outDir, { recursive: true });
    const top = profitable.slice(0, config.topPrint);
    const outPath = path.join(outDir, "top-results.json");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          top_count: top.length,
          total_validated: validatedAll.length,
          items: top,
        },
        null,
        2,
      ),
    );
    console.log(`Saved top ${top.length} to ${outPath}`);
  } catch (err) {
    console.error("Failed to write top-results.json", err);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
