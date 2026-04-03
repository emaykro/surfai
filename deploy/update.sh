#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# SURFAI — Quick redeploy (pull + build + restart)
# Run as root: sudo bash /opt/surfai/deploy/update.sh
# =============================================================================

APP_DIR="/opt/surfai"

info() { echo -e "\033[0;32m[INFO]\033[0m $1"; }

cd "$APP_DIR"

info "Pulling latest code..."
sudo -u surfai git pull origin main

info "Installing dependencies..."
sudo -u surfai npm install --omit=dev
cd "$APP_DIR/client" && sudo -u surfai npm install && cd "$APP_DIR"

info "Building SDK..."
sudo -u surfai npm run build

info "Running migrations..."
sudo -u surfai npm run migrate

info "Restarting service..."
systemctl restart surfai
sleep 2

if systemctl is-active --quiet surfai; then
    info "SURFAI restarted successfully"
    journalctl -u surfai -n 5 --no-pager
else
    echo "Service failed! Check: journalctl -u surfai -n 30"
    exit 1
fi
