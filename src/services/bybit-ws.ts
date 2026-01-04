/**
 * Bybit WebSocket client for real-time spot price monitoring.
 * Used to detect spot price movements that may precede Polymarket odds adjustments.
 *
 * Bybit V5 WebSocket API:
 * - Endpoint: wss://stream.bybit.com/v5/public/spot
 * - Topic: tickers.{symbol} (e.g., tickers.BTCUSDT)
 * - Push frequency: 50ms for spot
 */

import WebSocket from "ws";

export interface SpotPriceUpdate {
  symbol: string; // e.g., "BTCUSDT"
  lastPrice: number;
  timestamp: number;
  bid1Price: number;
  ask1Price: number;
  price24hPcnt: number; // 24h price change percentage
}

export interface SpotPriceHistory {
  price: number;
  ts: number;
}

export interface SpotMomentumEvent {
  symbol: string;
  direction: "up" | "down";
  startPrice: number;
  endPrice: number;
  pctChange: number;
  durationMs: number;
  timestamp: number;
}

type SpotPriceCallback = (update: SpotPriceUpdate) => void;
type SpotMomentumCallback = (event: SpotMomentumEvent) => void;

export class BybitSpotClient {
  private ws: WebSocket | null = null;
  private symbols: string[];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 3000;
  private pingInterval: NodeJS.Timeout | null = null;
  private connected = false;

  // Price history for momentum detection
  private priceHistory: Map<string, SpotPriceHistory[]> = new Map();
  private readonly historyWindowMs = 90_000; // 90s window
  private readonly historyMaxSize = 500;

  // Momentum detection thresholds
  private readonly momentumThresholdPct = 0.15; // 0.15% move triggers momentum event (lowered for more signals)
  private readonly momentumWindowMs = 60_000; // detect moves within 60s
  private lastLogTs = 0; // for periodic status logging

  // Callbacks
  private onPriceUpdate: SpotPriceCallback | null = null;
  private onMomentum: SpotMomentumCallback | null = null;
  private onConnect: (() => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  // Latest prices for external access
  private latestPrices: Map<string, SpotPriceUpdate> = new Map();

  constructor(symbols: string[] = ["BTCUSDT", "ETHUSDT"]) {
    this.symbols = symbols;
    for (const s of symbols) {
      this.priceHistory.set(s, []);
    }
  }

  setOnPriceUpdate(cb: SpotPriceCallback) {
    this.onPriceUpdate = cb;
  }

  setOnMomentum(cb: SpotMomentumCallback) {
    this.onMomentum = cb;
  }

  setOnConnect(cb: () => void) {
    this.onConnect = cb;
  }

  setOnDisconnect(cb: () => void) {
    this.onDisconnect = cb;
  }

  getLatestPrice(symbol: string): SpotPriceUpdate | undefined {
    return this.latestPrices.get(symbol);
  }

  getPriceHistory(symbol: string): SpotPriceHistory[] {
    return this.priceHistory.get(symbol) || [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect() {
    const url = "wss://stream.bybit.com/v5/public/spot";
    console.log(`[Bybit] Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log(`[Bybit] WebSocket connected to ${url}`);
      this.connected = true;
      this.reconnectAttempts = 0;

      // Subscribe to ticker streams
      const subscribeMsg = {
        op: "subscribe",
        args: this.symbols.map((s) => `tickers.${s}`),
      };
      this.ws?.send(JSON.stringify(subscribeMsg));
      console.log(`[Bybit] Subscribed to tickers: ${this.symbols.join(", ")}`);
      console.log(`[Bybit] Momentum detection: ${this.momentumThresholdPct}% move in ${this.momentumWindowMs / 1000}s`);

      // Start ping interval (Bybit requires ping every 20s)
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: "ping" }));
        }
      }, 15000);

      this.onConnect?.();
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle pong
        if (msg.op === "pong" || msg.ret_msg === "pong") {
          return;
        }

        // Handle subscription confirmation
        if (msg.op === "subscribe" && msg.success) {
          return;
        }

        // Handle ticker data
        if (msg.topic?.startsWith("tickers.") && msg.data) {
          this.handleTickerUpdate(msg);
        }
      } catch (err) {
        // Ignore parse errors
      }
    });

    this.ws.on("close", () => {
      console.log(`[Bybit] WebSocket disconnected`);
      this.connected = false;
      this.clearPingInterval();
      this.onDisconnect?.();
      this.attemptReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[Bybit] WebSocket error:`, err.message);
    });
  }

  private handleTickerUpdate(msg: any) {
    const data = msg.data;
    const symbol = data.symbol as string;
    const now = Date.now();

    const update: SpotPriceUpdate = {
      symbol,
      lastPrice: parseFloat(data.lastPrice),
      timestamp: msg.ts || now,
      bid1Price: parseFloat(data.bid1Price || "0"),
      ask1Price: parseFloat(data.ask1Price || "0"),
      price24hPcnt: parseFloat(data.price24hPcnt || "0"),
    };

    if (!Number.isFinite(update.lastPrice) || update.lastPrice <= 0) return;

    // Log periodic status (every 60s)
    if (now - this.lastLogTs > 60_000) {
      const prices = Array.from(this.latestPrices.entries())
        .map(([s, p]) => `${s.replace("USDT", "")}=$${p.lastPrice.toFixed(2)}`)
        .join(", ");
      console.log(`[Bybit] Status: ${prices}`);
      this.lastLogTs = now;
    }

    // Store latest price
    this.latestPrices.set(symbol, update);

    // Update price history
    const history = this.priceHistory.get(symbol) || [];
    history.push({ price: update.lastPrice, ts: now });

    // Trim old entries
    while (history.length > 0 && now - history[0].ts > this.historyWindowMs) {
      history.shift();
    }
    while (history.length > this.historyMaxSize) {
      history.shift();
    }
    this.priceHistory.set(symbol, history);

    // Emit price update
    this.onPriceUpdate?.(update);

    // Check for momentum
    this.detectMomentum(symbol, update.lastPrice, now);
  }

  private detectMomentum(symbol: string, currentPrice: number, now: number) {
    const history = this.priceHistory.get(symbol);
    if (!history || history.length < 2) return;

    // Find price from momentumWindowMs ago
    const windowStart = now - this.momentumWindowMs;
    const oldEntry = history.find((h) => h.ts >= windowStart);
    if (!oldEntry) return;

    const pctChange = ((currentPrice - oldEntry.price) / oldEntry.price) * 100;
    const absPctChange = Math.abs(pctChange);

    if (absPctChange >= this.momentumThresholdPct) {
      const event: SpotMomentumEvent = {
        symbol,
        direction: pctChange > 0 ? "up" : "down",
        startPrice: oldEntry.price,
        endPrice: currentPrice,
        pctChange,
        durationMs: now - oldEntry.ts,
        timestamp: now,
      };

      this.onMomentum?.(event);
    }
  }

  private clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[Bybit] Max reconnect attempts reached`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.min(this.reconnectAttempts, 5);
    console.log(`[Bybit] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    this.clearPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

// Singleton instance for stats script
let bybitClient: BybitSpotClient | null = null;

export function getBybitClient(symbols?: string[]): BybitSpotClient {
  if (!bybitClient) {
    bybitClient = new BybitSpotClient(symbols);
  }
  return bybitClient;
}
