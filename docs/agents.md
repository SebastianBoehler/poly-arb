# agents.md

Use this when coordinating multiple AI/automation agents on the same repo.

## Scope

- C++ core and TypeScript analysis live in separate domains.
- Use explicit short handoffs when switching authorship between agents.
- Favor reproducible, small patches over large refactors.

## Working protocol

- Include command intent in commit messages.
- Keep strategy hypothesis checks in `/scripts/nothing-ever-happens` and execution logic in `/cpp`.
- Keep data snapshots under `/data` and do not commit large raw files unless requested.

## Verification workflow

- Run `bun run strategy:nothing-ever-happens -- --csv <path>` with explicit `--csv` and filters.
- Run `bun run strategy:nothing-ever-happens:resolved -- --lookback-hours 336` for broad resolved-market win-rate checks.
- Capture report output before making trading-logic changes.
- Prefer per-category checks (e.g., `--category Sports`, `--category Crypto`, etc.).
