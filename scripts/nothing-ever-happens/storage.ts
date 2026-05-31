import { readFileSync, writeFileSync } from "fs";
import { mkdirSync } from "node:fs";

import type { MarketRow } from "./types";

export type OutcomeCache = Record<
  string,
  {
    resolved: boolean;
    outcome: string | null;
    closed?: boolean | string | number | null;
    condition_id?: string;
    slug?: string;
    fetched_at?: string;
    [key: string]: unknown;
  }
>;

export function loadRows(csvPath: string): MarketRow[] {
  const text = readFileSync(csvPath, "utf8");
  return parseCsv(text);
}

export function readCache(path: string): OutcomeCache {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as OutcomeCache;
  } catch {
    return {};
  }
}

export function saveCache(path: string, cache: OutcomeCache): void {
  mkdirSync(extractDir(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function numberAt(row: MarketRow, key: string): number {
  const raw = row[key];
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function groupRowsByMarket(rows: MarketRow[]): Map<string, MarketRow[]> {
  const grouped = new Map<string, MarketRow[]>();
  for (const row of rows) {
    const marketId = row.id;
    if (!marketId) continue;
    if (!grouped.has(marketId)) grouped.set(marketId, []);
    grouped.get(marketId)?.push(row);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => {
      const scanA = Number(a.scan_id ?? "0");
      const scanB = Number(b.scan_id ?? "0");
      return scanA - scanB;
    });
  }
  return grouped;
}

function parseCsv(content: string): MarketRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  const rows: MarketRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    if (values.length === 0) continue;

    const row = {} as MarketRow;
    for (let c = 0; c < header.length; c += 1) {
      const key = header[c];
      row[key] = values[c] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(field);
      field = "";
      continue;
    }

    field += char;
  }
  values.push(field);
  return values;
}

function extractDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return ".";
  return path.slice(0, idx);
}
