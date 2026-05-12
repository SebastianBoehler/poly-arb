# Polymarket Arbitrage Bot - C++ Low-Latency Edition

High-performance C++ implementation for Polymarket arbitrage trading with minimal latency.

## Features

- **Low-latency HTTP client** using libcurl with TCP_NODELAY
- **WebSocket orderbook streaming** using libwebsockets
- **Fast JSON parsing** with simdjson and nlohmann/json
- **Lock-free atomic operations** for orderbook state
- **Multi-threaded architecture** for parallel processing

## Requirements

- CMake 3.16+
- C++20 compatible compiler (GCC 10+, Clang 12+, MSVC 2019+)
- libcurl
- OpenSSL

## Building

```bash
cd cpp
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

## Usage

```bash
# Show help
./polymarket_arb --help

# Fetch neg_risk markets and monitor orderbooks
./polymarket_arb

# Fetch only (no WebSocket subscription)
./polymarket_arb --fetch-only

# Monitor 15-minute crypto markets
./polymarket_arb --15m

# Monitor 4-hour crypto markets
./polymarket_arb --4h

# Monitor 1-hour crypto markets
./polymarket_arb --1h

# Custom settings
./polymarket_arb --neg-risk --max 100 --trigger 0.97
```

## Keep the C++ Client Fresh

`cpp/CMakeLists.txt` fetches `SebastianBoehler/polymarket-cpp-client` from `main` by default. Run this from the repo root before live or benchmark runs to clear the cached FetchContent checkout, reconfigure, and rebuild the key C++ binaries:

```bash
bun run cpp:update-client
```

Pin a known client version when you need reproducible tests:

```bash
POLYMARKET_CLIENT_GIT_TAG=<commit-or-tag> bun run cpp:update-client
```

## Discovery Mode

`discovery_mode` is a C++ live scanner for non-execution research. It fetches markets, snapshots YES/NO books, evaluates example strategies, and prints JSONL events with paper-trade projections.

```bash
cmake --build build --target discovery_mode

# General neg-risk smoke scan
./build/discovery_mode --max 50 --iterations 1

# 15m crypto scan, append findings to JSONL until Ctrl+C/SIGTERM
./build/discovery_mode --15m --max 25 --interval-ms 1000 --out ../data/discovery.jsonl

# Bounded overnight-style collection by wall-clock duration
./build/discovery_mode --15m --duration-hours 8 --interval-ms 30000 --out ../data/discovery-overnight.jsonl
```

Current example signals:

- `binary_arbitrage`: YES ask + NO ask is below the configured threshold with enough top-of-book depth.
- `market_making_candidate`: YES book spread and visible depth are large enough to investigate maker quotes.

## Options

| Option         | Description                                      |
| -------------- | ------------------------------------------------ |
| `--help`       | Show help message                                |
| `--fetch-only` | Only fetch markets, don't subscribe to WebSocket |
| `--15m`        | Fetch 15-minute crypto up/down markets           |
| `--4h`         | Fetch 4-hour crypto up/down markets              |
| `--1h`         | Fetch 1-hour crypto up/down markets              |
| `--neg-risk`   | Fetch neg_risk binary markets (default)          |
| `--max N`      | Maximum number of markets to fetch (default: 50) |
| `--trigger N`  | Trigger threshold for arb (default: 0.98)        |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Main Thread                          │
│  - Parse arguments                                          │
│  - Fetch markets via REST API                               │
│  - Print statistics                                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    WebSocket Thread                         │
│  - Connect to Polymarket CLOB WebSocket                     │
│  - Receive orderbook updates                                │
│  - Parse JSON with simdjson                                 │
│  - Update atomic orderbook state                            │
│  - Detect arbitrage opportunities                           │
└─────────────────────────────────────────────────────────────┘
```

## Performance Optimizations

1. **TCP_NODELAY** - Disable Nagle's algorithm for lower latency
2. **Atomic operations** - Lock-free orderbook updates
3. **simdjson** - SIMD-accelerated JSON parsing
4. **Pre-allocated buffers** - Minimize memory allocations
5. **Compiler optimizations** - `-O3 -march=native`

## API Endpoints Used

- **CLOB REST API**: `https://clob.polymarket.com`
  - `GET /markets` - Fetch all markets
  - `GET /book?token_id=...` - Fetch orderbook

- **CLOB WebSocket**: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Subscribe to orderbook updates

- **Gamma API**: `https://gamma-api.polymarket.com`
  - `GET /events?slug=...` - Fetch crypto up/down markets

## Trading Executables

### Batch Order Smoke Test

Tests batch order placement at best offer prices:

```bash
# Build
cmake --build build --target batch_order_smoke

# Run (dry-run by default)
PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/batch_order_smoke

# Live trading
PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/batch_order_smoke --live
```

### Position Management Smoke Test

Fetches positions, identifies redeemable/mergeable positions, and processes them:

```bash
# Build
cmake --build build --target position_smoke

# Run (dry-run by default)
PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/position_smoke

# Live execution (actually redeem/merge)
PRIVATE_KEY=0x... FUNDER_ADDRESS=0x... ./build/position_smoke --live
```

**Features:**

- Fetches all positions from Polymarket Data API
- Identifies **redeemable** positions (resolved markets with winning shares)
- Identifies **mergeable** positions (can merge Yes+No tokens back to USDC)
- Displays position details: size, avg price, current value, PnL
- Executes redeem/merge operations via CTF contract calls

### Environment Variables

| Variable         | Description                               |
| ---------------- | ----------------------------------------- |
| `PRIVATE_KEY`    | Wallet private key (required)             |
| `FUNDER_ADDRESS` | Address holding funds (for proxy wallets) |
| `SIZE_USDC`      | Size per leg in USDC (default: 1)         |

## ClobClient API

The C++ `ClobClient` class provides a comprehensive interface to Polymarket:

### Order Management

- `create_order()` / `create_market_order()` - Create signed orders
- `post_order()` / `post_orders()` - Post single or batch orders
- `cancel_order()` / `cancel_all()` - Cancel orders

### Position Management

- `get_positions()` - Fetch all positions from Data API
- `get_redeemable_positions()` - Get positions that can be redeemed
- `get_mergeable_positions()` - Get positions that can be merged
- `redeem_positions()` - Redeem winning shares for USDC
- `merge_positions()` - Merge Yes+No tokens back to USDC
- `redeem_all_positions()` - Batch redeem all redeemable positions

### Market Data

- `get_markets()` / `get_market()` - Fetch market info
- `get_order_book()` / `get_order_books()` - Fetch orderbooks
- `get_price()` / `get_midpoint()` / `get_spread()` - Price info

## Docker Deployment

### Local Docker Build

```bash
# Build the C++ arb_test image
docker build -f Dockerfile.cpp -t poly-arb-cpp:latest .

# Run locally
docker run --rm \
  -e PRIVATE_KEY="0x..." \
  -e FUNDER_ADDRESS="0x..." \
  -e DRY_RUN="true" \
  poly-arb-cpp:latest
```

### Docker Compose

```bash
# Run C++ bot with docker-compose
docker-compose up arb-cpp
```

### GCloud Deployment (Low-Latency)

Deploy to GCE in `us-east1` for lowest latency to Polymarket servers:

```bash
# Set environment variables
export GCP_PROJECT_ID="your-project-id"
export PRIVATE_KEY="0x..."
export FUNDER_ADDRESS="0x..."
export DRY_RUN="true"  # Set to "false" for live trading

# Deploy to GCloud
./scripts/deploy-gcloud.sh

# Or step-by-step:
./scripts/deploy-gcloud.sh --build-only   # Build image
./scripts/deploy-gcloud.sh --push-only    # Push to GCR
./scripts/deploy-gcloud.sh --deploy-only  # Deploy to GCE
```

#### GCloud Configuration

| Variable         | Default        | Description                            |
| ---------------- | -------------- | -------------------------------------- |
| `GCP_PROJECT_ID` | (required)     | Your GCP project ID                    |
| `INSTANCE_NAME`  | `poly-arb-bot` | GCE instance name                      |
| `ZONE`           | `us-east1-b`   | GCE zone (us-east1 for lowest latency) |
| `MACHINE_TYPE`   | `e2-small`     | GCE machine type                       |

#### Useful GCloud Commands

```bash
# SSH into instance
gcloud compute ssh poly-arb-bot --zone=us-east1-b

# View logs
gcloud compute ssh poly-arb-bot --zone=us-east1-b -- 'docker logs $(docker ps -q) -f'

# Stop instance
gcloud compute instances stop poly-arb-bot --zone=us-east1-b

# Update to live trading
gcloud compute instances update-container poly-arb-bot --zone=us-east1-b \
  --container-env='DRY_RUN=false'
```

## License

MIT
