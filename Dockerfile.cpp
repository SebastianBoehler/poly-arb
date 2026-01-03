# syntax=docker/dockerfile:1

# Multi-stage build for C++ Polymarket Arbitrage Bot
# Optimized for low-latency trading on GCloud

# Stage 1: Build environment
FROM debian:bookworm-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    libcurl4-openssl-dev \
    libssl-dev \
    ca-certificates \
    autoconf \
    automake \
    libtool \
    pkg-config \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy C++ source code
COPY cpp/ ./cpp/

WORKDIR /app/cpp

# Build with CMake
RUN mkdir -p build && cd build \
    && cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CXX_FLAGS="-O3 -DNDEBUG" \
    && make -j$(nproc) arb_test

# Stage 2: Minimal runtime
FROM debian:bookworm-slim AS runner

# Install only runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcurl4 \
    libssl3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --system --uid 1001 --create-home appuser

WORKDIR /app

# Copy only the binary
COPY --from=builder /app/cpp/build/arb_test ./arb_test

# Set ownership
RUN chown -R appuser:appuser /app

USER appuser

# Environment variables (override at runtime via docker run -e or docker-compose)
# PRIVATE_KEY and FUNDER_ADDRESS must be passed at runtime (not baked into image)
ENV SIGNATURE_TYPE="2"
ENV SIZE_USDC="5"
ENV TRIGGER_COMBINED="0.995"
ENV MAX_COMBINED="0.999"
ENV DRY_RUN="true"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep arb_test || exit 1

# Run the arb_test binary
CMD ["./arb_test"]
