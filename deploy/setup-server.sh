#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# SURFAI — First-time server setup script
# Run as root on the Timeweb VPS: sudo bash setup-server.sh
#
# Prerequisites: Ubuntu/Debian with Nginx already running (htracker.ru).
# This script installs SURFAI alongside the existing project without touching it.
# =============================================================================

REPO="https://github.com/emaykro/surfai.git"
APP_DIR="/opt/surfai"
DB_NAME="surfai"
DB_USER="surfai_user"
APP_PORT="3100"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---- 1. System dependencies ------------------------------------------------

info "Checking Node.js..."
if ! command -v node &>/dev/null; then
    info "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    info "Node.js $(node -v) already installed"
fi

info "Checking PostgreSQL..."
if ! command -v psql &>/dev/null; then
    info "Installing PostgreSQL..."
    apt-get install -y postgresql postgresql-contrib
    systemctl enable postgresql
    systemctl start postgresql
else
    info "PostgreSQL already installed"
fi

info "Checking Nginx..."
if ! command -v nginx &>/dev/null; then
    error "Nginx not found. It should already be running for htracker.ru"
fi
info "Nginx found: $(nginx -v 2>&1)"

# ---- 2. System user --------------------------------------------------------

if ! id -u surfai &>/dev/null; then
    info "Creating system user 'surfai'..."
    useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" surfai
else
    info "User 'surfai' already exists"
fi

# ---- 3. PostgreSQL database -------------------------------------------------

info "Setting up PostgreSQL database..."
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || {
    info "Creating database user '$DB_USER'..."
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
}

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || {
    info "Creating database '$DB_NAME'..."
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
}

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# ---- 4. Clone repository ---------------------------------------------------

if [ -d "$APP_DIR/.git" ]; then
    info "Repository already cloned, pulling latest..."
    cd "$APP_DIR"
    git pull origin main
else
    info "Cloning repository..."
    git clone "$REPO" "$APP_DIR"
fi

chown -R surfai:surfai "$APP_DIR"

# ---- 5. Environment file ---------------------------------------------------

ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    info "Creating .env file..."
    cat > "$ENV_FILE" <<ENVEOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
PORT=${APP_PORT}
CORS_ORIGIN=https://surfai.ru,https://api.surfai.ru
NODE_ENV=production
ENVEOF
    chown surfai:surfai "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info "Generated .env with random DB password"
    echo ""
    warn "============================================="
    warn "  DB PASSWORD (save this somewhere safe!):"
    warn "  $DB_PASSWORD"
    warn "============================================="
    echo ""
else
    warn ".env already exists, skipping (check DATABASE_URL manually)"
fi

# ---- 6. Install dependencies & build ---------------------------------------

info "Installing Node.js dependencies..."
cd "$APP_DIR"
sudo -u surfai npm ci --omit=dev 2>/dev/null || sudo -u surfai npm install --omit=dev
cd "$APP_DIR/client"
sudo -u surfai npm install
cd "$APP_DIR"

info "Building SDK..."
sudo -u surfai npm run build

# ---- 7. Run database migrations --------------------------------------------

info "Running database migrations..."
cd "$APP_DIR"
sudo -u surfai npm run migrate

# ---- 8. systemd service ----------------------------------------------------

info "Installing systemd service..."
cp "$APP_DIR/deploy/surfai.service" /etc/systemd/system/surfai.service
systemctl daemon-reload
systemctl enable surfai
systemctl start surfai

sleep 2
if systemctl is-active --quiet surfai; then
    info "SURFAI service is running on port $APP_PORT"
else
    error "SURFAI service failed to start. Check: journalctl -u surfai -n 50"
fi

# ---- 9. Nginx configuration ------------------------------------------------

NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

if [ -d "$NGINX_AVAILABLE" ]; then
    info "Installing Nginx config..."
    cp "$APP_DIR/deploy/surfai.nginx.conf" "$NGINX_AVAILABLE/surfai.conf"

    if [ ! -L "$NGINX_ENABLED/surfai.conf" ]; then
        ln -s "$NGINX_AVAILABLE/surfai.conf" "$NGINX_ENABLED/surfai.conf"
    fi

    nginx -t && {
        systemctl reload nginx
        info "Nginx reloaded with SURFAI config"
    } || {
        error "Nginx config test failed! Fix and run: nginx -t && systemctl reload nginx"
    }
else
    warn "No sites-available directory found. Copy surfai.nginx.conf manually into your nginx config."
fi

# ---- 10. Smoke test --------------------------------------------------------

info "Running smoke test..."
sleep 1
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/api/sessions?limit=1" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    info "Smoke test passed (HTTP 200 from /api/sessions)"
else
    warn "Smoke test returned HTTP $HTTP_CODE — service may still be starting. Check: curl http://127.0.0.1:${APP_PORT}/api/sessions?limit=1"
fi

# ---- Done -------------------------------------------------------------------

echo ""
info "============================================="
info "  SURFAI deployment complete!"
info "============================================="
info ""
info "  App directory:  $APP_DIR"
info "  Local port:     $APP_PORT"
info "  Database:       $DB_NAME"
info "  Service:        systemctl status surfai"
info "  Logs:           journalctl -u surfai -f"
info ""
info "  Next steps:"
info "  1. Point DNS for surfai.ru -> this server IP"
info "  2. sudo certbot --nginx -d surfai.ru -d api.surfai.ru"
info "  3. Uncomment HTTPS block in nginx config"
info "  4. Optional: htpasswd for /dashboard/ protection"
info "     sudo apt install apache2-utils"
info "     sudo htpasswd -c /etc/nginx/.htpasswd-surfai admin"
info "     Then uncomment auth_basic lines in nginx config"
info "============================================="
