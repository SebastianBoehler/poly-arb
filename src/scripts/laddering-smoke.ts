/**
 * Laddering smoke runner.
 *
 * Runs the laddering strategy with current env defaults.
 * Use env vars in strategies/laddering.ts (BASE_SIZE_USDC, SIZE_MULTIPLIER, LADDER_STEP, etc).
 *
 * Run: bun run src/scripts/laddering-smoke.ts
 */
import { main as runLaddering } from "../strategies/laddering";

runLaddering().catch((err) => {
  console.error(err);
  process.exit(1);
});
