import { Market } from "../types";

const expiryKeys = [
  "end_date_iso",
  "end_date",
  "close_time",
  "close_time_iso",
  "expiration_time",
  "expiration_date",
  "resolved_time",
  "resolution_time",
  "accepting_order_timestamp",
];

export function pickExpiryField(market: Market): string {
  for (const key of expiryKeys) {
    const v = market[key];
    if (v) return `${key}=${v}`;
  }
  return "expiry=unknown";
}

export function pickExpiryTs(market: Market): number | null {
  for (const key of expiryKeys) {
    const v = market[key];
    if (!v) continue;
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t;
  }
  return null;
}
