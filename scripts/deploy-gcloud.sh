#!/bin/bash
set -e

# GCloud deployment script for Polymarket C++ Arbitrage Bot
#
# Polymarket CLOB API: NOT Cloudflare blocked on GCloud PREMIUM network
# Tested: c3-standard-4 + PREMIUM tier = 32-38ms RTT (~16ms one-way)
#
# Polymarket servers: eu-west-2 (London)
# Default zone: europe-west4 (Netherlands) for lowest latency

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-}"
INSTANCE_NAME="${INSTANCE_NAME:-poly-arb-bot}"
ZONE="${ZONE:-europe-west4-a}"
# Machine types for trading (low to high performance):
#   e2-medium     - Budget, shared CPU, variable latency
#   c3-standard-4 - Compute-optimized, dedicated CPU, low jitter (RECOMMENDED)
#   c3-highcpu-4  - Even lower latency, less RAM
#   c3-standard-8 - More cores for parallel processing
MACHINE_TYPE="${MACHINE_TYPE:-c3-standard-4}"
# Network tier: PREMIUM for lowest latency routing, STANDARD for cost savings
NETWORK_TIER="${NETWORK_TIER:-PREMIUM}"
IMAGE_NAME="poly-arb-cpp"

# Proxy (optional - GCloud PREMIUM network is NOT blocked)
# Only needed if you encounter Cloudflare issues on specific IPs
PROXY_URL="${HTTP_PROXY:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=============================================="
echo "  Polymarket C++ Arb Bot - GCloud Deployment"
echo "=============================================="
echo ""

# Check prerequisites
check_prereqs() {
    echo "[1/6] Checking prerequisites..."
    
    if ! command -v gcloud &> /dev/null; then
        echo -e "${RED}Error: gcloud CLI not installed${NC}"
        echo "Install from: https://cloud.google.com/sdk/docs/install"
        exit 1
    fi
    
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: docker not installed${NC}"
        exit 1
    fi
    
    if [ -z "$PROJECT_ID" ]; then
        PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
        if [ -z "$PROJECT_ID" ]; then
            echo -e "${RED}Error: No GCP project set${NC}"
            echo "Set with: export GCP_PROJECT_ID=your-project-id"
            echo "Or run: gcloud config set project your-project-id"
            exit 1
        fi
    fi
    
    echo -e "${GREEN}✓ Prerequisites OK${NC}"
    echo "  Project: $PROJECT_ID"
    echo "  Zone: $ZONE"
    echo ""
}

# Build Docker image for AMD64
build_image() {
    echo "[2/6] Building Docker image for AMD64..."
    cd "$(dirname "$0")/.."
    
    docker buildx build --platform linux/amd64 -t $IMAGE_NAME:latest -f Dockerfile.cpp .
    
    echo -e "${GREEN}✓ Image built${NC}"
    echo ""
}

# Push to GCR
push_to_gcr() {
    echo "[3/6] Pushing to Google Container Registry..."
    
    # Configure docker for GCR
    gcloud auth configure-docker gcr.io --quiet
    
    # Tag and push
    docker tag $IMAGE_NAME:latest gcr.io/$PROJECT_ID/$IMAGE_NAME:latest
    docker push gcr.io/$PROJECT_ID/$IMAGE_NAME:latest
    
    echo -e "${GREEN}✓ Image pushed to gcr.io/$PROJECT_ID/$IMAGE_NAME${NC}"
    echo ""
}

# Kernel tuning startup script for low-latency TCP
STARTUP_SCRIPT='#!/bin/bash
# TCP low-latency tuning for trading
sysctl -w net.ipv4.tcp_low_latency=1
sysctl -w net.ipv4.tcp_fastopen=3
sysctl -w net.ipv4.tcp_nodelay=1
sysctl -w net.ipv4.tcp_timestamps=1
sysctl -w net.ipv4.tcp_sack=1
sysctl -w net.ipv4.tcp_window_scaling=1
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"
sysctl -w net.core.netdev_max_backlog=30000
echo "TCP low-latency tuning applied"
'

# Create or update GCE instance
deploy_gce() {
    echo "[4/6] Deploying to GCE..."
    
    # Check if instance exists
    if gcloud compute instances describe $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID &>/dev/null; then
        echo "  Instance exists, updating container..."
        gcloud compute instances update-container $INSTANCE_NAME \
            --zone=$ZONE \
            --project=$PROJECT_ID \
            --container-image=gcr.io/$PROJECT_ID/$IMAGE_NAME:latest
    else
        echo "  Creating new instance with TCP tuning..."
        
        # Create instance with container-optimized OS and low-latency networking
        gcloud compute instances create-with-container $INSTANCE_NAME \
            --zone=$ZONE \
            --project=$PROJECT_ID \
            --machine-type=$MACHINE_TYPE \
            --image-family=cos-stable \
            --image-project=cos-cloud \
            --container-image=gcr.io/$PROJECT_ID/$IMAGE_NAME:latest \
            --container-env="PRIVATE_KEY=${PRIVATE_KEY}" \
            --container-env="FUNDER_ADDRESS=${FUNDER_ADDRESS}" \
            --container-env="SIGNATURE_TYPE=${SIGNATURE_TYPE:-2}" \
            --container-env="SIZE_USDC=${SIZE_USDC:-5}" \
            --container-env="TRIGGER_COMBINED=${TRIGGER_COMBINED:-0.98}" \
            --container-env="MAX_COMBINED=${MAX_COMBINED:-0.99}" \
            --container-env="DRY_RUN=${DRY_RUN:-true}" \
            --container-env="HTTP_PROXY=${HTTP_PROXY:-}" \
            --container-restart-policy=always \
            --tags=poly-arb \
            --scopes=default,logging-write \
            --network-tier=$NETWORK_TIER \
            --metadata=startup-script="$STARTUP_SCRIPT"
    fi
    
    echo -e "${GREEN}✓ Deployed to GCE${NC}"
    echo ""
}

# Show instance info
show_info() {
    echo "[5/6] Instance information..."
    
    EXTERNAL_IP=$(gcloud compute instances describe $INSTANCE_NAME \
        --zone=$ZONE \
        --project=$PROJECT_ID \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
    
    echo "  Instance: $INSTANCE_NAME"
    echo "  Zone: $ZONE"
    echo "  External IP: $EXTERNAL_IP"
    echo ""
}

# Show logs command
show_logs_cmd() {
    echo "[6/6] Useful commands:"
    echo ""
    echo "  # SSH into instance"
    echo "  gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID"
    echo ""
    echo "  # View container logs"
    echo "  gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID -- 'docker logs \$(docker ps -q) -f'"
    echo ""
    echo "  # Stop instance"
    echo "  gcloud compute instances stop $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID"
    echo ""
    echo "  # Delete instance"
    echo "  gcloud compute instances delete $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID"
    echo ""
    echo "  # Update environment variables"
    echo "  gcloud compute instances update-container $INSTANCE_NAME --zone=$ZONE --project=$PROJECT_ID \\"
    echo "    --container-env='DRY_RUN=false'"
    echo ""
}

# Main
main() {
    check_prereqs
    build_image
    push_to_gcr
    deploy_gce
    show_info
    show_logs_cmd
    
    echo -e "${GREEN}=============================================="
    echo "  Deployment complete!"
    echo "==============================================${NC}"
}

# Parse arguments
case "${1:-}" in
    --build-only)
        check_prereqs
        build_image
        ;;
    --push-only)
        check_prereqs
        push_to_gcr
        ;;
    --deploy-only)
        check_prereqs
        deploy_gce
        show_info
        show_logs_cmd
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --build-only   Only build the Docker image"
        echo "  --push-only    Only push to GCR (image must exist)"
        echo "  --deploy-only  Only deploy to GCE (image must be in GCR)"
        echo "  --help         Show this help"
        echo ""
        echo "Environment variables:"
        echo "  GCP_PROJECT_ID    GCP project ID"
        echo "  INSTANCE_NAME     GCE instance name (default: poly-arb-bot)"
        echo "  ZONE              GCE zone (default: europe-west4-a)"
        echo "  MACHINE_TYPE      GCE machine type (default: e2-small)"
        echo "  PRIVATE_KEY       Wallet private key"
        echo "  FUNDER_ADDRESS    Funder address"
        echo "  DRY_RUN           Set to 'false' for live trading"
        ;;
    *)
        main
        ;;
esac
