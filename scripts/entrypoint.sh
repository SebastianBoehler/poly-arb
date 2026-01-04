#!/bin/bash
# Combined entrypoint for C++ arb bot + TS redemption service
# Runs both services in parallel, restarts on failure

set -e

echo "=== Polymarket Combined Service ==="
echo "Starting C++ arb bot and TS redemption service..."
echo ""

# Function to run C++ arb bot with auto-restart
run_arb_bot() {
    while true; do
        echo "[arb_bot] Starting C++ arbitrage bot..."
        /app/arb_test || true
        echo "[arb_bot] Process exited, restarting in 5s..."
        sleep 5
    done
}

# Function to run TS redemption service with auto-restart
run_redemption() {
    while true; do
        echo "[redemption] Starting TS redemption service..."
        cd /app/ts && bun run src/services/redemption-service.ts || true
        echo "[redemption] Process exited, restarting in 5s..."
        sleep 5
    done
}

# Trap signals for graceful shutdown
cleanup() {
    echo ""
    echo "Shutting down services..."
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# Start both services in background
run_arb_bot &
ARB_PID=$!

run_redemption &
REDEMPTION_PID=$!

echo "[main] Services started:"
echo "  - arb_bot PID: $ARB_PID"
echo "  - redemption PID: $REDEMPTION_PID"
echo ""

# Wait for any child to exit (shouldn't happen due to while loops)
wait
