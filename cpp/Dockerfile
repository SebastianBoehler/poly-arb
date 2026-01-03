# syntax=docker/dockerfile:1
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git libcurl4-openssl-dev libssl-dev ca-certificates \
    autoconf automake libtool pkg-config zlib1g-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN mkdir -p build && cd build \
    && cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-O3 -DNDEBUG" \
    && make -j$(nproc) arb_test

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcurl4 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 1001 --create-home appuser
WORKDIR /app
COPY --from=builder /app/build/arb_test ./arb_test
RUN chown -R appuser:appuser /app
USER appuser

ENV SIGNATURE_TYPE="2" SIZE_USDC="5" TRIGGER_COMBINED="0.995" MAX_COMBINED="0.999" DRY_RUN="true"
CMD ["./arb_test"]
