import type { MarketRow } from "./types";
import type { OutcomeCache } from "./storage";

const DATA_API = "https://data-api.polymarket.com/markets";
const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const USER_AGENT = "polymarket-research-lab/1.0";

export type OutcomeMeta = {
  resolved: boolean;
  outcome: string | null;
  closed?: boolean | string | number | null;
  condition_id?: string;
  slug?: string;
  fetched_at?: string;
  [key: string]: unknown;
};

export async function fetchOutcome(
  row: MarketRow,
  cache: OutcomeCache,
  pauseMs: number,
): Promise<{ outcome: string | null; meta: OutcomeMeta }> {
  const conditionId = row.id;
  if (!conditionId) {
    return { outcome: null, meta: { resolved: false, outcome: null } };
  }

  const cached = cache[conditionId];
  if (cached && cached.resolved && cached.outcome) {
    return { outcome: cached.outcome, meta: cached };
  }

  const slug = row.slug;
  const dataPayload = await fetchJson<any>(`${DATA_API}?condition_id=${encodeURIComponent(conditionId)}`);
  let candidates: Record<string, unknown>[] | null = null;

  if (dataPayload) {
    if (Array.isArray(dataPayload) && dataPayload.length > 0) candidates = candidateFromArray(dataPayload[0]);
    else if (typeof dataPayload === "object") candidates = candidateFromArray(dataPayload);
  }

  if (!candidates) {
    const candidateLists = await Promise.all([
      fetchJson<any[]>(`${GAMMA_API}?condition_id=${encodeURIComponent(conditionId)}`),
      fetchJson<any[]>(`${GAMMA_API}?conditionId=${encodeURIComponent(conditionId)}`),
      fetchJson<any[]>(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`),
      fetchJson<any[]>(`${GAMMA_API}?market=${encodeURIComponent(conditionId)}`),
      fetchJson<any[]>(`${GAMMA_API}?market_id=${encodeURIComponent(conditionId)}`),
    ]);

    const merged: Record<string, unknown>[] = [];
    for (const list of candidateLists) {
      if (Array.isArray(list)) merged.push(...list);
    }

    candidates = pickCandidate(merged, conditionId, slug);
  }

  const meta: OutcomeMeta = {
    resolved: false,
    outcome: null,
    condition_id: conditionId,
    slug,
    fetched_at: new Date().toISOString(),
  };

  if (Array.isArray(candidates) && candidates.length > 0 && candidates[0]) {
    const resolvedMeta = parseResolvedOutcome(candidates[0]);
    meta.resolved = resolvedMeta.resolved;
    meta.outcome = resolvedMeta.outcome;
    meta.closed = resolvedMeta.closed;
    meta.fetched_at = new Date().toISOString();
  }

  cache[conditionId] = meta;
  await sleep(pauseMs);

  return { outcome: meta.outcome, meta };
}

function pickCandidate(
  candidates: Array<Record<string, unknown>>,
  conditionId: string,
  slug: string,
): Array<Record<string, unknown>> | null {
  if (candidates.length === 0) return null;
  const normalizedCondition = conditionId.toLowerCase();
  const normalizedSlug = (slug ?? "").toLowerCase();

  for (const candidate of candidates) {
    const condition = String(candidate.conditionId ?? "").toLowerCase();
    if (condition && condition === normalizedCondition) return [candidate];
  }

  for (const candidate of candidates) {
    const condition = String(candidate.id ?? "").toLowerCase();
    if (condition && condition === normalizedCondition) return [candidate];
  }

  for (const candidate of candidates) {
    const candidateSlug = String(candidate.slug ?? "").toLowerCase();
    if (candidateSlug && candidateSlug === normalizedSlug) return [candidate];
  }

  return [candidates[0]];
}

function parseResolvedOutcome(market: Record<string, unknown>): {
  resolved: boolean;
  outcome: string | null;
  closed?: boolean | string | number | null;
} {
  const resolved = Boolean(
    market.resolved ||
      market.closed ||
      market.isResolved,
  );
  if (!resolved) {
    return { resolved: false, outcome: null };
  }

  const outcomeRaw = String(
    market.outcome ??
      market.result ??
      market.resolution ??
      market.resolved_outcome ??
      "",
  ).toLowerCase();
  const outcome = normalizeOutcome(outcomeRaw);
  if (outcome) {
    return { resolved: true, outcome };
  }

  const outcomePrices = market.outcomePrices;
  if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
    const first = toFloat(outcomePrices[0]);
    const second = toFloat(outcomePrices[1]);
    if (first !== null && second !== null) {
      if (first >= 0.99 && second <= 0.01) {
        return { resolved: true, outcome: "yes" };
      }
      if (second >= 0.99 && first <= 0.01) {
        return { resolved: true, outcome: "no" };
      }
    }
  }

  return { resolved: true, outcome: null };
}

function normalizeOutcome(value: string): string | null {
  if (value === "yes" || value === "up") return "yes";
  if (value === "no" || value === "down") return "no";
  return null;
}

function toFloat(value: unknown): number | null {
  if (typeof value === "number") return value;
  const cast = Number(value);
  return Number.isFinite(cast) ? cast : null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function candidateFromArray(value: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    return value as Array<Record<string, unknown>>;
  }
  if (isRecord(value)) return [value as Record<string, unknown>];
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
