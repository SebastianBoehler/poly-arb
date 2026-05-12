/**
 * Wallet Activity Monitor for Polymarket Copy Trading.
 *
 * Polls the Polymarket Data API for a target wallet's trades
 * and emits new trades as they appear. Deduplicates by transaction hash.
 *
 * API: https://data-api.polymarket.com/activity?user=<address>&type=TRADE
 */

const DATA_API = "https://data-api.polymarket.com";
const POLL_INTERVAL_MS = 5_000; // 5 seconds

export interface WalletTrade {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string; // token ID
  side: "BUY" | "SELL";
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
}

export type TradeCallback = (trade: WalletTrade, walletAddress: string) => void;

export class WalletMonitor {
  private wallets: string[];
  private seenTxHashes = new Set<string>();
  private onTrade: TradeCallback;
  private pollIntervalMs: number;
  private isRunning = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastTimestamps = new Map<string, number>();

  constructor(options: {
    wallets: string[];
    onTrade: TradeCallback;
    pollIntervalMs?: number;
  }) {
    this.wallets = options.wallets.map((w) => w.toLowerCase());
    this.onTrade = options.onTrade;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  async fetchActivity(walletAddress: string): Promise<WalletTrade[]> {
    const lastTs = this.lastTimestamps.get(walletAddress);
    let url = `${DATA_API}/activity?user=${walletAddress}&type=TRADE&limit=50&sortBy=TIMESTAMP&order=DESC`;
    if (lastTs) {
      url += `&startDate=${lastTs}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        console.error(`[WalletMonitor] API error for ${walletAddress.slice(0, 10)}: ${res.status}`);
        return [];
      }
      return (await res.json()) as WalletTrade[];
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        console.error(`[WalletMonitor] Timeout fetching ${walletAddress.slice(0, 10)}`);
      }
      return [];
    }
  }

  private async pollOnce(): Promise<void> {
    for (const wallet of this.wallets) {
      try {
        const trades = await this.fetchActivity(wallet);
        let maxTs = this.lastTimestamps.get(wallet) ?? 0;

        for (const trade of trades) {
          if (this.seenTxHashes.has(trade.transactionHash)) continue;
          this.seenTxHashes.add(trade.transactionHash);

          if (trade.timestamp > maxTs) {
            maxTs = trade.timestamp;
          }

          this.onTrade(trade, wallet);
        }

        if (maxTs > 0) {
          this.lastTimestamps.set(wallet, maxTs);
        }

        // Cap seen set to prevent memory leak
        if (this.seenTxHashes.size > 10_000) {
          const arr = Array.from(this.seenTxHashes);
          this.seenTxHashes = new Set(arr.slice(arr.length - 5_000));
        }
      } catch (err) {
        console.error(`[WalletMonitor] Error polling ${wallet.slice(0, 10)}:`, err);
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[WalletMonitor] Monitoring ${this.wallets.length} wallet(s), poll every ${this.pollIntervalMs}ms`);
    for (const w of this.wallets) {
      console.log(`  → ${w}`);
    }

    // Seed: fetch current trades to avoid copying old history
    for (const wallet of this.wallets) {
      const trades = await this.fetchActivity(wallet);
      let maxTs = 0;
      for (const t of trades) {
        this.seenTxHashes.add(t.transactionHash);
        if (t.timestamp > maxTs) maxTs = t.timestamp;
      }
      if (maxTs > 0) this.lastTimestamps.set(wallet, maxTs);
      console.log(`[WalletMonitor] Seeded ${trades.length} existing trades for ${wallet.slice(0, 10)}`);
    }

    this.timerId = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    console.log("[WalletMonitor] Stopped");
  }

  addWallet(address: string): void {
    const lower = address.toLowerCase();
    if (!this.wallets.includes(lower)) {
      this.wallets.push(lower);
      console.log(`[WalletMonitor] Added wallet: ${lower}`);
    }
  }

  removeWallet(address: string): void {
    const lower = address.toLowerCase();
    this.wallets = this.wallets.filter((w) => w !== lower);
    console.log(`[WalletMonitor] Removed wallet: ${lower}`);
  }

  getWallets(): string[] {
    return [...this.wallets];
  }
}
