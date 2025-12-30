# Poly Arb Scanner

Fast two-stage Polymarket binary scanner (Bun + TypeScript) that surfaces mispriced binary markets and validates size-aware fills.

## Architecture

- **API client**: `@polymarket/clob-client` for markets/books/prices (with batched prices). Fallback HTTP removed; pure client usage.
- **Discovery** (`src/discovery.ts`):
  - Filters to active/open, order-book enabled, non-expired markets with exactly 2 tokens.
  - Fetches best buy prices (batched) per token; computes quick cost/profit/ROI.
  - Shortlists by `discoveryThreshold` and `shortlistPerPage`.
- **Validation** (`src/validation.ts`):
  - Fetches both order books; skips if missing/empty.
  - Walks asks for target size; computes size-aware cost/profit/ROI; marks `bookOk` if cost ≤ `bookThreshold`.
- **Entrypoint** (`src/index.ts`):
  - Paginates markets, runs discovery then validation, filters to profitable (cost < 1), sorts (ROI → profit → sooner expiry → cheaper), prints & saves top N to `output/top-results.json`.
- **Utils**: concurrency limiter, expiry parsing, orderbook walker.

## Config

Edit `src/config.ts` or override via env:

- `MAX_PAGES`, `PRICE_BATCH_SIZE`, `PRICE_WORKERS`, `BOOK_WORKERS`, `SLEEP_BETWEEN_PAGES_MS`.
- Thresholds: `DISCOVERY_THRESHOLD` (quick cost cap), `BOOK_THRESHOLD` (size cost cap), `TOP_PRINT`, `SIZE_USDC_PER_SIDE`.
- API: `API_BASE` (default `https://clob.polymarket.com`), `CHAIN_ID` (default 137, Polygon).

## Commands

- Install deps: `bun install`
- Format: `bun run format`
- Start scan: `MAX_PAGES=5000 bun start`
  - Results: `output/top-results.json` (profitable only, top N)
- Tests: `bun test`

## Current findings (Dec 30, 2025)

- No profitable (cost < 1) binary opps surfaced after scanning up to 5k pages with batched prices and size validation.
- Occasional Polymarket rate limits (`/price` 429); mitigated via batched `getPrices`, but may still appear under very large sweeps.

## Notes

- Husky/lint-staged/prettier configured; run `bun x husky install` after `git init` and add `.husky/pre-commit` with `bun run lint:staged`.
- Only binary markets are considered; multi-outcome (e.g., league top-4 finish) are skipped.
